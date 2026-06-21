// Agent core in Effect. Tracing is "free": Effect.fn auto-creates the chat.turn
// span; we pass our OTel tracer + the active span's context INTO @ax-llm/ax so it
// emits canonical gen_ai.* child spans (token usage, finish reasons, message
// events). Effect's own Telemetry.addGenAIAnnotations stamps the semconv
// attributes on our span. Metrics + correlated logs come along automatically.
import { ai, ax, type AxLoggerFunction, AxMemory } from "@ax-llm/ax"
import { existsSync, readFileSync } from "node:fs"
import { emitActivity } from "./activity.ts"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type { AnySpan } from "effect/Tracer"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"
import { tools } from "./tools.ts"

const MAX_STEPS = Number(process.env.AX2_MAX_STEPS ?? 50) // max tool-call iterations per turn

const BUDGET_NUDGE =
  "Your tool-call budget for this turn is used up. Do NOT call any more tools. Using everything you've gathered so far, give the user your best, concise answer now."

const MODEL = "@cf/moonshotai/kimi-k2.7-code"
const PROVIDER = "cloudflare.workers-ai"

const llm = ai({
  name: "openai",
  apiKey: process.env.CLOUDFLARE_API_TOKEN!,
  apiURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
  config: { model: MODEL as any },
})

const BASE_PROMPT = [
  "You are a capable coding agent running inside a terminal, in the user's project directory.",
  "Tools: bash, read_file, write_file, edit_file, glob, grep. When a request needs real work,",
  "USE the tools to inspect/modify files and run commands BEFORE answering — don't guess.",
  "Verify with a tool when unsure. Keep replies concise and concrete; show the result that matters.",
  "Format replies in GitHub-flavored markdown (use `code`, lists, and ```fences``` where helpful).",
].join(" ")

// Like Claude Code loading CLAUDE.md: if launched in a repo with project
// instructions, fold them into the system prompt. AGENTS.md takes priority.
const loadProjectDoc = (): string => {
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      if (existsSync(file)) {
        const body = readFileSync(file, "utf8").slice(0, 8000)
        return `\n\n# Project instructions (${file})\n${body}`
      }
    } catch {
      /* ignore */
    }
  }
  return ""
}

export const projectDocLoaded = (["AGENTS.md", "CLAUDE.md"] as const).find((f) => existsSync(f)) ?? null

const chat = ax("message:string -> reply:string", { functions: tools })
chat.setDescription(BASE_PROMPT + loadProjectDoc())

// No-tools generator used to recover when the tool budget is exhausted: it
// answers from the conversation/tool history already in memory.
const answerGen = ax("message:string -> reply:string")
answerGen.setDescription(
  "You have already gathered information using tools in this conversation. Do NOT request tools. Using the conversation and tool results so far, give the user your best, concise answer in GitHub-flavored markdown.",
)

// ponytail: brittle string-match — ax throws no typed/coded error for the step
// limit. Ceiling: breaks if ax rewords the message. Upgrade: switch to a typed error code when ax adds one.
const isMaxSteps = (e: unknown): boolean =>
  e instanceof ChatError && /max steps reached/i.test(String((e.cause as { message?: string } | undefined)?.message ?? ""))

class ChatError {
  readonly _tag = "ChatError"
  constructor(readonly cause: unknown) {}
}

const argStr = (p: unknown) => {
  const s = typeof p === "string" ? p : JSON.stringify(p ?? {})
  // ponytail: de-doubles only exact 2x repeats (ax stream-chunk quirk). Ceiling:
  // won't catch other duplication shapes. Upgrade: fix in ax / drop if ax stops doubling.
  const h = s.length / 2
  if (s.length % 2 === 0 && s.slice(0, h) === s.slice(h)) return s.slice(0, h)
  return s
}

// ax's NATIVE step feed. ax calls this during forward() as steps complete:
// per-step agent narration, tool calls, tool results. We map them to UI
// activity. id correlates a call with its result so the row updates in place.
const liveLogger: AxLoggerFunction = (m) => {
  const emitStep = (results: ReadonlyArray<{ content?: string; functionCalls?: ReadonlyArray<{ id: string; function: { name: string; params?: string | object } }> }>) => {
    for (const r of results) {
      const calls = r.functionCalls ?? []
      // narration only for intermediate steps (steps that also call tools);
      // the final step's text is the reply, appended once by sendAtom.
      if (calls.length > 0 && r.content && r.content.trim()) emitActivity({ kind: "text", text: r.content.trim() })
      for (const fc of calls) {
        emitActivity({ kind: "tool", id: fc.id, name: fc.function.name, args: argStr(fc.function.params) })
      }
    }
  }
  switch (m.name) {
    case "ChatResponseResults":
      emitStep(m.value as any)
      break
    case "ChatResponseStreamingDoneResult":
      emitStep([m.value as any])
      break
    case "FunctionResults":
      for (const fr of m.value) emitActivity({ kind: "result", id: fr.functionId, result: String(fr.result).slice(0, 4000), isError: Boolean(fr.isError) })
      break
    default:
      break
  }
}

// The logger lives on the AI service (not forward opts) and only fires with
// debug enabled. Custom logger replaces ax's console printer -> no TUI spam.
llm.setOptions({ debug: true, logger: liveLogger })

// Metrics -> OTLP /v1/metrics via the PeriodicExportingMetricReader.
const turnsTotal = Metric.counter("chat_turns_total", { description: "completed chat turns" })
const tokensTotal = Metric.counter("chat_tokens_total", { description: "total LLM tokens used" })
const turnDuration = Metric.timer("chat_turn_duration", { description: "per-turn latency" })

// ponytail: token usage read off ax's undocumented getUsage(). Load-bearing —
// it's the only source feeding gen_ai.usage.* + the token metric (ax's AxGen span
// doesn't carry usage). Ceiling: silently yields nothing if ax changes the shape
// (guarded, non-fatal). Upgrade: a public ax usage API.
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
      // stream:false -> no token streaming; we render step-by-step.
      const runForward = (gen: typeof chat, msg: string) =>
        Effect.tryPromise({
          try: () =>
            otelContext.with(traceContext, () =>
              gen.forward(llm, { message: msg }, { mem, sessionId, tracer, traceContext, maxSteps: MAX_STEPS, stream: false }),
            ),
          catch: (e) => new ChatError(e),
        })

      // If the tool-call budget is hit, don't fail — tell the model to stop
      // calling tools and answer from what it has, then await the next turn.
      let budgetExhausted = false
      const res = yield* runForward(chat, message).pipe(
        Effect.catchIf(isMaxSteps, () =>
          Effect.gen(function* () {
            budgetExhausted = true
            // Mark the nudge ON THE TRACE: a span attribute (queryable in motel)
            // + a correlated warning log. Without this the recovery is invisible —
            // the turn just shows a failed gen_ai child then a mysterious 2nd one.
            yield* Effect.annotateCurrentSpan({ "chat.budget_exhausted": true, "chat.max_steps": MAX_STEPS })
            yield* Effect.logWarning("tool budget reached -> asking model to answer").pipe(
              Effect.annotateLogs({ "session.id": sessionId, "chat.max_steps": MAX_STEPS }),
            )
            return yield* runForward(answerGen, BUDGET_NUDGE)
          }),
        ),
      )

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

      // Put the REAL conversation content on chat.turn (the readable parent span)
      // so motel shows prompt + reply, not just metadata. (ax buries content in
      // AxGen events.) Truncate to keep spans sane.
      const reply = res.reply ?? ""
      const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)
      yield* Effect.annotateCurrentSpan({
        "gen_ai.prompt": clip(message),
        "gen_ai.completion": clip(reply),
        "chat.budget_exhausted": budgetExhausted,
      })

      yield* Metric.update(turnsTotal, 1)
      yield* Effect.logInfo("turn.done").pipe(Effect.annotateLogs({ "reply.chars": reply.length }))
      return reply
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
