#!/usr/bin/env bun
// TEMP span-dump probe (telemetry GATE proof). Installs an in-memory span exporter,
// wires the node-span tracer to that provider, drives a REAL runRlm over a buried-fact
// context, and prints the captured span tree — proving >1 child span nests under
// run_rlm (not one opaque blob). Not part of lint; delete after capture.
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { setNodeSpanTracer } from "../src/orch-spans.ts"
import { runRlm } from "../src/rlm-tool.ts"
import { MODEL, rateLimiter } from "../src/runtime.ts"
import { ai as makeAi, type AxAIService } from "@ax-llm/ax"

const buildLiveAi = (): AxAIService => {
  const apiKey = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!apiKey || !accountId) throw new Error("need CF creds")
  const svc = makeAi({ name: "openai", apiKey, apiURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`, config: { model: MODEL as never } })
  svc.setOptions({ rateLimiter })
  return svc
}

otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
// Register globally so runRlm's own otelTrace.getTracer(...) call (rlm-tool.ts:87,
// which RESETS the node-span tracer) resolves to THIS exporting provider, not the
// global no-op. In production turn() hands it the real re-surfaced OtelTracerProvider.
otelTrace.setGlobalTracerProvider(provider)
const tracer = provider.getTracer("span-probe")
setNodeSpanTracer(tracer)

const ai = buildLiveAi()
const context = [
  "Intro lorem ipsum ".repeat(40),
  "The activation code is ZEPHYR-7731. Keep it secret.",
  "More padding text ".repeat(40),
].join("\n")

// Root span (stands in for chat.turn / run_rlm tool root) so child node spans nest under it.
const root = tracer.startSpan("run_rlm")
await otelContext.with(otelTrace.setSpan(otelContext.active(), root), () =>
  runRlm(context, "What is the activation code?", ai, "rlm-probe", new AbortController().signal),
)
root.end()
await provider.forceFlush()

const spans = exporter.getFinishedSpans()
console.log(`\n=== captured ${spans.length} spans ===`)
for (const s of spans) {
  const phase = s.attributes["orch.node.phase"]
  const tok = s.attributes["orch.node.tokens"]
  const dur = (s.duration[0] * 1e3 + s.duration[1] / 1e6).toFixed(0)
  console.log(`${s.name.padEnd(28)} ${String(dur).padStart(6)}ms  phase=${phase ?? "-"}  tok=${tok ?? "-"}  id=${s.attributes["orch.node.id"] ?? "-"}`)
}
const childCount = spans.filter((s) => s.name.startsWith("orch.node")).length
console.log(`\n>1 child span under run_rlm? ${childCount > 1 ? "YES" : "NO"} (${childCount} orch.node child spans)`)
process.exit(0)
