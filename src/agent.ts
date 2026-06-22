// Agent core in Effect. Tracing is "free": Effect.fn auto-creates the chat.turn
// span; we pass our OTel tracer + the active span's context INTO @ax-llm/ax so it
// emits canonical gen_ai.* child spans (token usage, finish reasons, message
// events). Effect's own Telemetry.addGenAIAnnotations stamps the semconv
// attributes on our span. Metrics + correlated logs come along automatically.
import { ax, type AxLoggerFunction, AxMemory } from "@ax-llm/ax"
import { existsSync, readFileSync } from "node:fs"
import { emitActivity } from "./activity.ts"
import { allocate, BudgetExhaustedError, type BudgetUsage } from "./orch.ts"
import { agent as agentNode } from "./orch-recipes.ts"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type { AnySpan } from "effect/Tracer"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"
import { BASE_TOOLS } from "./tools.ts"
import { BASE_PROMPT, limits, llm, MODEL, onEvent } from "./runtime.ts"
import { ORCH_TOOLS } from "./orch-tools.ts"

const MAX_STEPS = limits.maxSteps // max tool-call iterations per turn
// Hard per-turn TOKEN ceiling, enforced by orch's Budget (charged after each leaf
// from the forward result's usage). Distinct from MAX_STEPS (tool-call iterations,
// still recovered by turn() below): this is a real token gate that throws
// BudgetExhaustedError when a turn's cumulative usage crosses it.
const TOKEN_BUDGET = limits.tokenBudget

const BUDGET_NUDGE =
  "Your tool-call budget for this turn is used up. Do NOT call any more tools. Using everything you've gathered so far, give the user your best, concise answer now."

const PROVIDER = "cloudflare.workers-ai"

// BASE_PROMPT (the capable base system prompt) lives in runtime.ts — the neutral
// cycle-breaker module — so orchestration LEAF gens (orch-tools.ts) can import it
// without re-introducing the agent ⇄ orch-tools static init cycle. Re-exported here
// so callers that think of it as "the main agent's prompt" find it on agent.ts. A leaf
// is built from BASE_PROMPT + a persona overlay (NOT this ORCH_OVERLAY): a leaf is the
// main agent minus orchestration.
export { BASE_PROMPT }

// The orchestration paragraphs — appended to the MAIN chat gen ONLY (it alone carries
// ORCH_TOOLS). A leaf gen is built from BASE_PROMPT (above) WITHOUT this overlay: it has
// no orchestration tools, so telling it about orchestrate/run_orch_script would be a lie.
const ORCH_OVERLAY = [
  // Orchestration: this agent can run deterministic multi-node flows, not just single replies.
  "Orchestration: beyond a single reply you can drive deterministic multi-node runs whose nodes render live in a tree.",
  "SELF-orchestrate via tools: `orchestrate(task, subtasks?, strategy, branches?)` fans out sub-agents (each with the file tools only). USE it when a",
  "task splits into independent parts: PASS `subtasks` — a list of DIFFERENT, independent pieces (division of labour) — and branch i works subtasks[i]",
  "(e.g. orchestrate({ subtasks: ['audit auth.ts for bugs', 'check tests cover edge cases', 'review error handling'] })). Only omit subtasks and pass",
  "`task` alone when you genuinely want N REDUNDANT attempts at the SAME task (e.g. with 'best_of_n'). strategy 'parallel' returns all, 'judge' picks the best of N,",
  "'verify' answers once then skeptics vote accept/reject, 'best_of_n' re-runs until stable then judges. `run_orch_script(name, message)`",
  "loads + runs a saved `.ax/orch/<name>` script — USE it after write_file-ing a custom `.ax/orch/<name>.ts` flow. BOUNDS (self-limit): sub-agent",
  "leaves run with file tools only and canNOT themselves orchestrate (one level deep), a token budget caps each run, branches cap at 4. Decompose at the top.",
  "User-invoked triggers: `^o` runs a built-in fan-out over the current input; `/run <name> [message]` loads + runs a saved script.",
  "To author a CUSTOM flow, write_file a script to `.ax/orch/<name>.ts` (trusted dir; paths escaping it are rejected) exporting",
  "`orchestrate(ctx, prims)`, then tell the user to `/run <name>`. prims = { leaf, parallel, pipeline, emit, allocate, gen } plus recipes",
  "{ agent, judge, loopUntilDry, adversarialVerify }; ctx = { message, ai, budget, onEvent, optsFor(), usageOf }. A dynamic orch script needs",
  "NO runtime imports — gen() is an ambient prim factory that builds leaves inline: gen(signature, description?) returns an AxGen for leaf().",
  "Compose ONLY through prims, so the engine core stays the 5 primitives. RULE: never share a mutating memory across concurrent branches — call",
  "`ctx.optsFor()` for a fresh forked memory per parallel leaf. See `.ax/orch/example.ts` for the canonical pattern.",
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

// The MAIN chat gen gets BASE_TOOLS + ORCH_TOOLS — it alone may self-orchestrate.
// Every orchestration sub-run LEAF (orch-tools.ts) is built with BASE_TOOLS only, so a
// leaf physically cannot re-orchestrate: the structural one-level recursion guard.
const chat = ax("message:string -> reply:string", { functions: [...BASE_TOOLS, ...ORCH_TOOLS] })
chat.setDescription(`${BASE_PROMPT} ${ORCH_OVERLAY}${loadProjectDoc()}`)

// No-tools generator used to recover when the tool budget is exhausted: it
// answers from the conversation/tool history already in memory.
const answerGen = ax("message:string -> reply:string")
answerGen.setDescription(
  "You have already gathered information using tools in this conversation. Do NOT request tools. Using the conversation and tool results so far, give the user your best, concise answer in GitHub-flavored markdown.",
)

// ponytail: brittle string-match — ax throws no typed/coded error for the step
// limit. Ceiling: breaks if ax rewords the message. Upgrade: switch to a typed error code when ax adds one.
// Walk the cause chain (ChatError -> AxGenerateError -> inner Error) so a deeper
// wrap doesn't hide the signal.
const isMaxSteps = (e: unknown): boolean => {
  if (!(e instanceof ChatError)) return false
  let cur: { message?: string; cause?: unknown } | undefined = e.cause as any
  for (let i = 0; i < 5 && cur; i++) {
    if (/max steps reached/i.test(String(cur.message ?? ""))) return true
    cur = cur.cause as any
  }
  return false
}

class ChatError {
  readonly _tag = "ChatError"
  constructor(readonly cause: unknown) {}
}

// The token budget (orch.allocate) throws BudgetExhaustedError, wrapped by
// runForward into a ChatError. Unwrap one level to surface it on the span.
const asBudgetExhausted = (e: unknown): BudgetExhaustedError | undefined =>
  e instanceof ChatError && e.cause instanceof BudgetExhaustedError ? e.cause : undefined

// Tool-call args as a string for the UI. No de-double needed: the only place ax
// doubles params (mergeFunctionCalls, params += params) is the STREAMING done-cb
// path; we run stream:false (see runForward), where ChatResponseResults carries
// the provider's single tool_calls[].function.arguments verbatim. (A doubled
// '{…}{…}' would also fail ax's own JSON.parse and never execute.)
const argStr = (p: unknown) => (typeof p === "string" ? p : JSON.stringify(p ?? {}))

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

// gen_ai.response.finish_reason is the one signal ax exposes nowhere on its
// public program API (getUsage gives tokens, getChatLog gives the response id,
// but finish_reason lives only on ax's internal gen_ai child-span event). The
// only no-ax-patch way to read it is the raw /chat/completions JSON, so we wrap
// fetch and skim choices[0].finish_reason off a clone (ax still consumes the
// real body). Turns are serialized (busyAtom), so a module-level latch is safe;
// turn() resets it before each forward and reads it after.
let lastFinishReason: string | undefined
// Cast: Bun's `typeof fetch` carries a `.preconnect` member ax never calls.
const captureFetch = (async (input: any, init: any): Promise<Response> => {
  const res = await fetch(input, init)
  try {
    if (res.ok) {
      const j: any = await res.clone().json()
      const fr = j?.choices?.[0]?.finish_reason
      if (typeof fr === "string") lastFinishReason = fr
    }
  } catch {
    /* non-JSON / streaming / error body — ignore, finish_reason just stays unset */
  }
  return res
}) as typeof fetch

// The logger lives on the AI service (not forward opts) and only fires with
// debug enabled. Custom logger replaces ax's console printer -> no TUI spam.
// fetch MUST be set in THIS same call: setOptions reassigns every field, so a
// later bare setOptions would wipe a fetch passed only to ai().
llm.setOptions({ debug: true, logger: liveLogger, fetch: captureFetch })

// Metrics -> OTLP /v1/metrics via the PeriodicExportingMetricReader.
const turnsTotal = Metric.counter("chat_turns_total", { description: "completed chat turns" })
const turnsFailed = Metric.counter("chat_turns_failed", { description: "turns that ended in failure" })
const tokensTotal = Metric.counter("chat_tokens_total", { description: "total LLM tokens used" })
const turnDuration = Metric.timer("chat_turn_duration", { description: "per-turn latency" })

type Usage = { promptTokens?: number; completionTokens?: number; totalTokens?: number }

// Token usage off AxProgram.getUsage() (AxGen extends AxProgram) — a real, if
// lightly-documented, API returning AxProgramUsage[] with .tokens per call. It's
// the source for gen_ai.usage.* + the token metric (ax's own span carries usage
// only as an event). Guarded: yields nothing if ax changes the shape (non-fatal).
const readUsage = (gen: typeof chat): Usage | undefined => {
  const u = (gen as any).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return last?.tokens ?? last
}

// Sum usage across generators (chat + answerGen on the budget-recovery path) so
// the token metric / gen_ai.usage.* cover the WHOLE turn, not just the first gen.
const sumUsage = (...us: ReadonlyArray<Usage | undefined>): Usage | undefined => {
  const present = us.filter((u): u is Usage => u !== undefined)
  if (present.length === 0) return undefined
  const add = (k: keyof Usage) => {
    const vals = present.map((u) => u[k]).filter((n): n is number => typeof n === "number")
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined
  }
  return { promptTokens: add("promptTokens"), completionTokens: add("completionTokens"), totalTokens: add("totalTokens") }
}

// ponytail: provider response id read off ax's getChatLog() (remoteId). ax doesn't
// expose finish_reason publicly (it's on ax's own gen_ai child span already), so
// we only surface the id here. Ceiling: yields nothing if ax changes the log shape.
// Upgrade: ax public response-metadata API (id + finish_reason).
const readResponseId = (gen: typeof chat): string | undefined => {
  const log = (gen as any).getChatLog?.()
  const last = Array.isArray(log) ? log[log.length - 1] : undefined
  return last?.remoteId ?? undefined
}

export type TurnResult = { reply: string; tokens?: number; finishReason?: string; budget: boolean }

// One in-flight AbortController per session (overwritten each turn). abortTurn()
// lets the UI cancel a running turn: ax honors abortSignal in forward() and
// throws AxAIServiceAbortedError, which surfaces as a normal turn failure.
const turnAborters = new Map<string, AbortController>()
export const abortTurn = (sessionId: string): boolean => {
  const c = turnAborters.get(sessionId)
  if (!c || c.signal.aborted) return false
  c.abort()
  return true
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

      lastFinishReason = undefined // reset the captureFetch latch for this turn
      const aborter = new AbortController()
      turnAborters.set(sessionId, aborter)
      // One token budget for the whole turn (shared across the chat + answerGen
      // leaves). agent() charges it from each forward result's usage; crossing the
      // ceiling throws BudgetExhaustedError, caught below and surfaced on the span.
      const budget = allocate(TOKEN_BUDGET)
      const usageOf = (gen: typeof chat): BudgetUsage | undefined => readUsage(gen)

      yield* Effect.logInfo("turn.start").pipe(
        Effect.annotateLogs({ "session.id": sessionId, "message.chars": message.length }),
      )

      // Make chat.turn the ACTIVE OTel context during forward so ax's tracer
      // (which reads context.active()) nests its gen_ai span under chat.turn.
      // stream:false -> no token streaming; we render step-by-step.
      // abortSignal -> ax cancels the in-flight forward when the UI interrupts.
      const runForward = (gen: typeof chat, msg: string) =>
        Effect.tryPromise({
          try: () =>
            otelContext.with(traceContext, () =>
              // agent() brackets the leaf in start→done|error node events; the opts
              // bag is threaded through unchanged (behavior-identical to a bare leaf).
              agentNode(
                {
                  nodeId: `turn:${sessionId}`,
                  gen,
                  opts: { mem, sessionId, tracer, traceContext, maxSteps: MAX_STEPS, stream: false, abortSignal: aborter.signal },
                  onEvent,
                  budget,
                  usageOf,
                },
                llm,
                { message: msg },
              ),
            ),
          catch: (e) => new ChatError(e),
        })

      // If the tool-call budget is hit, ax throws "max steps reached"; don't fail
      // — recover with a NO-TOOLS generator that answers from the conversation/
      // tool history already in memory. (Tried stripping tools mid-loop via a
      // beforeStep hook to avoid the throw + its red gen_ai span, but kimi then
      // emits raw <|tool_call_begin|> tokens as text — a fresh no-tools generator
      // with an explicit "answer now" nudge gives clean prose. The red child span
      // on the abandoned attempt is the documented cost; chat.budget_exhausted
      // marks the turn so it's not mistaken for an unrecovered failure.)
      let budgetExhausted = false
      const res = yield* runForward(chat, message).pipe(
        Effect.catchIf(isMaxSteps, () =>
          Effect.gen(function* () {
            budgetExhausted = true
            yield* Effect.annotateCurrentSpan({ "chat.budget_exhausted": true, "chat.max_steps": MAX_STEPS })
            yield* Effect.logWarning("tool budget reached -> asking model to answer").pipe(
              Effect.annotateLogs({ "session.id": sessionId, "chat.max_steps": MAX_STEPS }),
            )
            return yield* runForward(answerGen, BUDGET_NUDGE)
          }),
        ),
        // Token budget breach is a HARD failure (distinct from max-steps recovery):
        // annotate the span with the typed error's spent/total, then re-fail.
        (eff) =>
          Effect.tapCause(eff, (cause) => {
            const be = asBudgetExhausted(Cause.squash(cause))
            return be
              ? Effect.annotateCurrentSpan({
                  "chat.budget_token_exhausted": true,
                  "chat.budget_spent": be.spent,
                  "chat.budget_total": be.total,
                })
              : Effect.void
          }),
      )

      // Canonical gen_ai annotations via Effect's own helper (no hand-typed keys).
      // response.id = provider completion id (from ax's chat log) so a turn can be
      // cross-referenced with provider-side logs.
      const span = yield* Effect.currentSpan
      Telemetry.addGenAIAnnotations(span, {
        system: PROVIDER as any,
        operation: { name: "chat" },
        request: { model: MODEL },
        response: {
          model: MODEL,
          id: readResponseId(budgetExhausted ? answerGen : chat),
          finishReasons: lastFinishReason ? [lastFinishReason] : undefined,
        },
      })
      const usage = budgetExhausted ? sumUsage(readUsage(chat), readUsage(answerGen)) : readUsage(chat)
      if (usage) {
        Telemetry.addGenAIAnnotations(span, {
          usage: { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
        })
        if (typeof usage.totalTokens === "number") yield* Metric.update(tokensTotal, usage.totalTokens)
      }

      // Put the REAL conversation content on chat.turn (the readable parent span)
      // so motel shows prompt + reply, not just metadata. (ax buries content in
      // AxGen events.) Truncate to keep spans sane. NB: these are app-local keys
      // (chat.*), NOT the gen_ai.* semconv — the canonical message records live as
      // events on ax's gen_ai child span; squatting gen_ai.prompt would mislead
      // semconv-aware tooling.
      const reply = res.reply ?? ""
      const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)
      yield* Effect.annotateCurrentSpan({
        "chat.prompt": clip(message),
        "chat.reply": clip(reply),
        "chat.budget_exhausted": budgetExhausted,
      })

      yield* Metric.update(turnsTotal, 1)
      yield* Effect.logInfo("turn.done").pipe(Effect.annotateLogs({ "reply.chars": reply.length }))
      const result: TurnResult = {
        reply,
        tokens: usage?.totalTokens,
        finishReason: lastFinishReason,
        budget: budgetExhausted,
      }
      return result
    },
    // Latency metric for the whole turn.
    (eff) => Effect.trackDuration(eff, turnDuration),
    // Record failures: withSpan already sets status=ERROR + recordException;
    // this adds a correlated structured log line for motel's logs tab + a
    // failure metric so the failed-turn rate is chartable alongside chat_turns_total.
    (eff) =>
      Effect.tapCause(eff, (cause) =>
        Effect.flatMap(Metric.update(turnsFailed, 1), () =>
          Effect.logError("turn.failed").pipe(
            Effect.annotateLogs({ "session.id": sessionId, "exception.message": Cause.pretty(cause) }),
          ),
        ),
      ),
  )
