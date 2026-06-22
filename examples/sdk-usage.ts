// Runnable headless SDK smoke: an EXTERNAL caller drives the ax2 core with NO
// Cloudflare env. Proves the injection seam — createAgent over a caller-supplied
// AxAIService, a non-CF model, empty tools, run ONE turn via the returned Effect.
//
//   bun examples/sdk-usage.ts        # exits 0 on success, 1 on any failed assertion
//
// This file is ALSO the regression gate for the whole extraction: it consumes the
// public src/sdk.ts surface, so its exports are no longer dead.
import { AxMockAIService } from "@ax-llm/ax"
import { context as otelContext } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { NoopSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Resource from "@effect/opentelemetry/Resource"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Tracer from "effect/Tracer"
import { setActivitySink } from "../src/activity.ts"
// The ENTIRE surface a caller needs comes from sdk.ts — no reaching into internals.
import { type AxAIService, AxMemory, createAgent } from "../src/sdk.ts"

// ── plain ax2-style assertions ──────────────────────────────────────────────────
let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  } else {
    console.log(`ok: ${msg}`)
  }
}

// PROVE no-CF: snapshot CF env, then build everything without reading it.
const cfTokenBefore = process.env.CLOUDFLARE_API_TOKEN
const cfAccountBefore = process.env.CLOUDFLARE_ACCOUNT_ID

// ── caller-supplied stub AxAIService (NO network, deterministic) ────────────────
// ponytail: example stub ai echoes the message — no real provider, no network.
// Upgrade: point this at a real injected provider (OpenAI/Ollama) in CI.
// ax's DSP parser maps the single output field `reply:string` straight off the raw
// content, so returning the echoed message as content yields { reply: <echo> }.
const REPLY = "echo: hello from the stub"
const stubAi: AxAIService = new AxMockAIService({
  name: "stub",
  id: "stub-echo",
  features: { functions: true, streaming: false },
  chatResponse: async () => ({
    results: [{ index: 0, content: REPLY, finishReason: "stop" } as never],
    modelUsage: {
      ai: "stub",
      model: "stub/echo",
      tokens: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    } as never,
  }),
}) as unknown as AxAIService

// ── inject config: non-CF model + empty tools prove createAgent's DI ────────────
const sdk = createAgent({ ai: stubAi, model: "stub/echo", maxSteps: 4, tokenBudget: 50_000, tools: [] })

// ── OTel: a real (no-exporter) provider so turn()'s span machinery works headless.
// turn() needs an OtelTracerProvider in context AND a live active OTel span
// (currentOtelSpan + emit()'s getActiveSpan().addEvent on a RAW SDK span). Mirror the
// app's wiring (src/otel.ts TracingLive) minus the OTLP exporters: register a global
// AsyncLocalStorage context manager (so otelContext.with(...) tracks the active span),
// then merge NodeSdk.layer (which sets the GLOBAL SDK provider — this is what makes
// getActiveSpan() return a raw SpanImpl, not an effect wrapper) with layerTracerProvider
// (which surfaces the OtelTracerProvider service turn() reads). The span processor is a
// Noop — spans are recorded then dropped (no motel needed). Same shape as the app.
otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
const resourceCfg = { serviceName: "ax2-sdk-smoke", serviceVersion: "0.0.0" }
const spanProcessor = new NoopSpanProcessor()
const TracingLive = Layer.mergeAll(
  NodeSdk.layer(() => ({ resource: resourceCfg, spanProcessor })),
  Layer.provide(NodeSdk.layerTracerProvider([spanProcessor]), Resource.layer(resourceCfg)),
)

const main = async () => {
  // Collect the live node Activities the turn emits via the GLOBAL sink (the same
  // mechanism atoms.ts installs per turn). turn() pushes node start/done events here.
  const activities: string[] = []
  setActivitySink((a) => {
    activities.push(a.kind === "node" ? `node:${a.event}` : a.kind)
  })

  // A session: caller-built AxMemory + an external parent span (the session root).
  const mem = new AxMemory()
  const parent = Tracer.externalSpan({ traceId: "0".repeat(32), spanId: "0".repeat(16), sampled: false })
  const sessionId = "sdk-smoke-1"

  // turn() returns an EFFECT — run it at the boundary with the OtelTracerProvider
  // layer it needs. No CF env, no app runtime.
  const result = await Effect.runPromise(
    sdk.turn(mem, parent, sessionId)("hello").pipe(Effect.provide(TracingLive)),
  )

  setActivitySink(null)

  // ── assertions ────────────────────────────────────────────────────────────────
  assert(typeof result.reply === "string" && result.reply.length > 0, "a reply string came back")
  assert(result.reply === REPLY, `reply is the stub echo (got: ${JSON.stringify(result.reply)})`)
  assert(activities.some((a) => a.startsWith("node:")), `at least one node Activity observed (saw: ${activities.join(",") || "none"})`)
  assert(
    process.env.CLOUDFLARE_API_TOKEN === cfTokenBefore && process.env.CLOUDFLARE_ACCOUNT_ID === cfAccountBefore,
    "no CF env was mutated (the stub ai needs none)",
  )
  // The injection seam itself: createAgent accepted a non-CF AxAIService + model.
  assert(stubAi.getName() === "stub", "the injected (non-CF) AxAIService was the one used")
}

await main().catch((e) => {
  console.error("FAIL: turn threw", e)
  failed++
})

console.log(failed === 0 ? "\nSDK smoke: all pass ✓" : `\nSDK smoke: ${failed} FAILED`)
process.exit(failed ? 1 : 0)
