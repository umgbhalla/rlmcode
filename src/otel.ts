// Real OTel wiring -> local `motel` ingest (127.0.0.1:27686). Exports THREE
// signals over OTLP/HTTP:
//   traces  -> /v1/traces    (SimpleSpanProcessor, flush-per-span, interactive)
//   logs    -> /v1/logs      (Effect.log* auto-correlated to spans by traceId/spanId)
//   metrics -> /v1/metrics   (PeriodicExportingMetricReader)
//
// NodeSdk.layer consumes its OtelTracerProvider internally (output is only
// Layer<Resource>), so trace.getTracer() would be a no-op exporter. We re-surface
// our OWN OtelTracerProvider (same span processor) so agent.ts can hand a real,
// exporting @opentelemetry/api Tracer to @ax-llm/ax -> ax's gen_ai.* child spans
// land in the same motel pipeline / same trace.
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Resource from "@effect/opentelemetry/Resource"
import { context as otelContext } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as Layer from "effect/Layer"
import * as Atom from "effect/unstable/reactivity/Atom"

export const SERVICE_NAME = "ax2-chat"
export const SERVICE_VERSION = "0.1.0"

const BASE = process.env.MOTEL_OTLP_URL ?? "http://127.0.0.1:27686"

// Register a global OTel ContextManager so @opentelemetry/api context.active()
// actually tracks the current span. Without it, context.with(...) is a no-op and
// ax's gen_ai span (created via tracer.startSpan with no explicit context) would
// always become a new root trace instead of nesting under chat.turn.
otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

const resourceCfg = {
  serviceName: SERVICE_NAME,
  serviceVersion: SERVICE_VERSION,
  attributes: {
    "deployment.environment.name": "local",
    "service.instance.id": "ax2.local",
  },
}

// One processor instance, shared by NodeSdk's internal provider AND the
// re-surfaced provider below, so both flush to the same exporter.
const spanProcessor = new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${BASE}/v1/traces` }))

// Hoisted so we can forceFlush on exit. Metrics export on a 5s interval, so a
// short-lived process (e.g. `bun run emit`) would otherwise drop the final
// window's counters/timers. Traces + logs use Simple processors (flush per
// record) and don't need this.
const metricReader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter({ url: `${BASE}/v1/metrics` }),
  exportIntervalMillis: 5000,
})

// beforeExit only (fires on natural drain — `emit` finishing, TUI Esc-quit).
// NOT SIGINT/SIGTERM: registering those would swallow Ctrl-C and leave the TUI
// hung. Best-effort; motel is local so the flush usually lands before exit.
let flushed = false
process.once("beforeExit", () => {
  if (flushed) return
  flushed = true
  void metricReader.forceFlush().catch(() => {})
})

const SdkLive = NodeSdk.layer(() => ({
  resource: resourceCfg,
  spanProcessor,
  logRecordProcessor: new SimpleLogRecordProcessor(new OTLPLogExporter({ url: `${BASE}/v1/logs` })),
  loggerMergeWithExisting: false, // replace console logger so the TUI isn't spammed
  metricReader,
  metricTemporality: "cumulative",
}))

// Expose OtelTracerProvider (Context.Service) backed by the same processor.
const ProviderLive = Layer.provide(
  NodeSdk.layerTracerProvider([spanProcessor]),
  Resource.layer(resourceCfg),
)

export const TracingLive = Layer.mergeAll(SdkLive, ProviderLive)

// Reusable Effect runtime bound to tracing. appRuntime.fn(...) effects run here.
export const appRuntime = Atom.runtime(TracingLive)
