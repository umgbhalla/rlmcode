// Agent core in Effect. Tracing is "free": Effect.fn auto-creates the chat.turn
// span; we pass our OTel tracer + the active span's context INTO @ax-llm/ax so it
// emits canonical gen_ai.* child spans (token usage, finish reasons, message
// events). Effect's own Telemetry.addGenAIAnnotations stamps the semconv
// attributes on our span. Metrics + correlated logs come along automatically.
import { ai, ax, AxMemory } from "@ax-llm/ax"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type { AnySpan } from "effect/Tracer"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"

const MODEL = "@cf/moonshotai/kimi-k2.7-code"
const PROVIDER = "cloudflare.workers-ai"

const llm = ai({
  name: "openai",
  apiKey: process.env.CLOUDFLARE_API_TOKEN!,
  apiURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
  config: { model: MODEL as any },
})

const chat = ax("message:string -> reply:string")

export class ChatError {
  readonly _tag = "ChatError"
  constructor(readonly cause: unknown) {}
}

// Metrics -> OTLP /v1/metrics via the PeriodicExportingMetricReader.
const turnsTotal = Metric.counter("chat_turns_total", { description: "completed chat turns" })
const tokensTotal = Metric.counter("chat_tokens_total", { description: "total LLM tokens used" })
const turnDuration = Metric.timer("chat_turn_duration", { description: "per-turn latency" })

// Best-effort token usage read off the ax generator (belt-and-suspenders;
// ax's own gen_ai child span also carries gen_ai.usage.* when given a tracer).
const readUsage = (): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined => {
  const u = (chat as any).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return last?.tokens ?? last
}

/**
 * Build a traced turn for a session. `chat.turn` (our Effect.fn span, kind=client,
 * gen_ai semconv) parents the ax gen_ai child; the whole thing parents the
 * session root span -> one trace per session.
 */
export const turn = (mem: AxMemory, parent: AnySpan, sessionId: string) =>
  Effect.fn("chat.turn", {
    kind: "client",
    // Parent to the session root (ExternalSpan) via span options -> all turns of
    // a session share one trace. (Do NOT use withParentSpan as a trailing combi:
    // it wipes the fn's own span context.)
    parent,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": PROVIDER,
      "gen_ai.request.model": MODEL,
      "session.id": sessionId,
    },
  })(
    function* (message: string) {
      const provider = yield* OtelTracer.OtelTracerProvider
      const tracer = provider.getTracer(SERVICE_NAME, SERVICE_VERSION)
      // Active OTel span = our chat.turn span; pass it as ax's parent context so
      // ax's gen_ai child nests under chat.turn deterministically.
      const otelSpan = yield* OtelTracer.currentOtelSpan
      const traceContext = otelTrace.setSpan(otelContext.active(), otelSpan)

      yield* Effect.logInfo("turn.start").pipe(
        Effect.annotateLogs({ "session.id": sessionId, "message.chars": message.length }),
      )

      // Make chat.turn the ACTIVE OTel context during forward so ax's tracer
      // (which reads context.active()) nests its gen_ai span under chat.turn.
      const res = yield* Effect.tryPromise({
        try: () =>
          otelContext.with(traceContext, () =>
            chat.forward(llm, { message }, { mem, sessionId, tracer, traceContext }),
          ),
        catch: (e) => new ChatError(e),
      })

      // Canonical gen_ai annotations via Effect's own helper (no hand-typed keys).
      const span = yield* Effect.currentSpan
      Telemetry.addGenAIAnnotations(span, {
        system: PROVIDER as any,
        operation: { name: "chat" },
        request: { model: MODEL },
        response: { model: MODEL },
      })
      const usage = readUsage()
      if (usage) {
        Telemetry.addGenAIAnnotations(span, {
          usage: { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
        })
        if (typeof usage.totalTokens === "number") yield* Metric.update(tokensTotal, usage.totalTokens)
      }

      yield* Metric.update(turnsTotal, 1)
      yield* Effect.logInfo("turn.done").pipe(Effect.annotateLogs({ "reply.chars": res.reply.length }))
      return res.reply
    },
    // Latency metric for the whole turn.
    (eff) => Effect.trackDuration(eff, turnDuration),
    // Record failures: withSpan already sets status=ERROR + recordException;
    // this adds a correlated structured log line for motel's logs tab.
    (eff) =>
      Effect.tapCause(eff, (cause) =>
        Effect.logError("turn.failed").pipe(
          Effect.annotateLogs({ "session.id": sessionId, "exception.message": Cause.pretty(cause) }),
        ),
      ),
  )
