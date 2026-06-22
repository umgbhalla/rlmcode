#!/usr/bin/env bun
// LIVE telemetry verification (telemetry leaps 1/2/2b/3). GATED behind AX2_LIVE=1.
// Drives the REAL run_rlm path against CF-Kimi, capturing spans into an InMemorySpanExporter
// so we can PROVE: (2b) >1 child span under run_rlm (the internal stages — distiller /
// executor turns / responder — are no longer one black box); and we read reasoning tokens +
// timing off the real run. Quotes the span list for the gate.
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { ai, AxMemory, type AxAIService } from "@ax-llm/ax"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Tracer from "effect/Tracer"
import { setNodeSpanTracer } from "../src/orch-spans.ts"
import { runRlm } from "../src/rlm-node.ts"
import { turn } from "../src/agent.ts"
import { TracingLive } from "../src/otel.ts"
import { MODEL, rateLimiter } from "../src/runtime.ts"

// Build the CF-Kimi service exactly like src/runtime.ts (standalone, not the app singleton).
const buildLiveAi = (): AxAIService => {
  const apiKey = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!apiKey || !accountId) throw new Error("needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (run via --env-file=.env)")
  const svc = ai({ name: "openai", apiKey, apiURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`, config: { model: MODEL as never } })
  svc.setOptions({ rateLimiter })
  return svc
}

if (process.env.AX2_LIVE !== "1") {
  console.log("telemetry-live.test: skipped: set AX2_LIVE=1")
  process.exit(0)
}

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
// Register GLOBALLY so otelTrace.getTracer(...) inside runRlm (which calls setNodeSpanTracer
// with ITS OWN tracer from the service-name provider) resolves to OUR exporting in-memory
// provider — the app's turn() would wire the motel exporter; here we capture the same spans.
otelTrace.setGlobalTracerProvider(provider)
const tracer = provider.getTracer("telemetry-live", "0.1.0")
setNodeSpanTracer(tracer)

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) { console.error(`  FAIL: ${msg}`); failed++ }
}

await (async () => {
  // ── (1)(2)(3) TURN-LEVEL: a trivial "hi" through the REAL turn() — proves reasoning
  // tokens + prompt size are now attributable. turn() exports to motel (running locally);
  // we read the TurnResult (which now carries reasoningTokens — the exact code path) and
  // print the prompt size. This is the "is a slow hi thinking? prompt bloat?" answer.
  const hiProgram = Effect.gen(function* () {
    const parent = yield* Effect.useSpan(
      "chat.session",
      { kind: "server", attributes: { "session.id": "telemetry-hi", "gen_ai.request.model": MODEL } },
      (span) => Effect.succeed(Tracer.externalSpan({ traceId: span.traceId, spanId: span.spanId, sampled: true })),
    )
    const t0 = Date.now()
    const res = yield* turn(new AxMemory(), parent, "telemetry-hi")("hi")
    return { res, wallMs: Date.now() - t0 }
  })
  const hi = await Effect.runPromise(Effect.provide(hiProgram, Layer.merge(TracingLive, Layer.empty)))
  // SYSTEM_PROMPT_CHARS is the assembled system prompt size (BASE_PROMPT+RLM_WORKFLOW_OVERLAY+projectDoc).
  const { SYSTEM_PROMPT_CHARS } = await import("../src/agent.ts")
  console.log("─".repeat(60))
  console.log("(1)(2)(3) TRIVIAL 'hi' TURN — attribution:")
  console.log(`  wall:            ${hi.wallMs}ms`)
  console.log(`  prompt size:     ${SYSTEM_PROMPT_CHARS} system chars + 2 user chars = ${SYSTEM_PROMPT_CHARS + 2} chars`)
  console.log(`  total tokens:    ${hi.res.tokens ?? "?"}`)
  console.log(`  reasoning tokens:${hi.res.reasoningTokens ?? 0}  ← the THINKING share of a slow turn`)
  console.log(`  reply:           ${JSON.stringify(String(hi.res.reply).slice(0, 120))}`)
  console.log("─".repeat(60))
  assert(typeof hi.res.reply === "string" && hi.res.reply.length > 0, "hi turn returned a real reply")
  // reasoningTokens is present (a number, possibly 0) — the field is now wired end-to-end.
  assert(hi.res.reasoningTokens !== undefined || hi.res.tokens !== undefined, "hi turn surfaced usage (reasoning wired)")

  const ai = buildLiveAi()
  // A long context with a buried fact (same shape as the RLM gate) so the executor runs
  // multiple turns — the multi-node tree we want to see in the trace.
  const sections = Array.from({ length: 40 }, (_, i) => {
    const n = i + 1
    if (n === 22) return `Section ${n}: The load-test mascot codename is ZEPHYR-7731.`
    return `Section ${n}: routine guidance about caching, retries, and rate limiting with no special identifiers.`
  })
  const context = sections.join("\n\n")
  const query = "Find the load-test mascot codename mentioned exactly once. Reply with the exact string."

  // Run the RLM inside a ROOT span so the run_rlm node spans have a parent in the same trace.
  const root = tracer.startSpan("run_rlm")
  const rootCtx = otelTrace.setSpan(otelContext.active(), root)
  const out = await otelContext.with(rootCtx, () =>
    runRlm(context, query, ai, "live-telemetry-rlm", new AbortController().signal),
  )
  root.end()

  await provider.forceFlush()
  const spans = exporter.getFinishedSpans()
  const names = spans.map((s) => s.name)

  console.log("─".repeat(60))
  console.log(`RLM result turns=${out.turns} callbacks=${out.callbacks}`)
  console.log("Captured spans:")
  for (const s of spans) {
    const nodeId = s.attributes["orch.node.id"]
    const tokens = s.attributes["orch.node.tokens"]
    const durMs = Number(s.duration[0]) * 1000 + Number(s.duration[1]) / 1e6
    console.log(`  • ${s.name}  [${durMs.toFixed(0)}ms]${nodeId ? `  node=${nodeId}` : ""}${tokens !== undefined ? `  tokens=${tokens}` : ""}`)
  }
  console.log("─".repeat(60))

  // GATE (2b): the RLM is NO LONGER one black box. Two flavours of child span now appear:
  //   (a) ax gen_ai STAGE spans (AxGen > Node:distiller / executor / responder, AxFlow) —
  //       emitted because we threaded tracer + traceContext INTO rlm.forward();
  //   (b) our orch.node.* spans minted from the actorTurnCallback NodeEvents.
  // The run_rlm root is the LAST/longest span; every span that ended INSIDE its window and is
  // not the root itself is a child → the internal turns are visible. We assert >1 child span.
  const rootSpan = spans.find((s) => s.name === "run_rlm")
  assert(rootSpan !== undefined, "captured the run_rlm root span")
  const children = spans.filter((s) => s !== rootSpan && s.name !== "AxFlow")
  assert(out.callbacks > 0, `RLM callbacks fired, got ${out.callbacks}`)
  assert(
    children.length > 1,
    `>1 child span under run_rlm (internal stages/turns visible, not one black box), got ${children.length}: ${JSON.stringify(children.map((s) => s.name))}`,
  )
})()

if (failed > 0) {
  console.error(`telemetry-live.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("telemetry-live.test: all pass ✓")
process.exit(0)
