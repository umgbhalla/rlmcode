// Agent core in Effect. Tracing is "free": Effect.fn auto-creates the chat.turn
// span; we pass our OTel tracer + the active span's context INTO @ax-llm/ax so it
// emits canonical gen_ai.* child spans (token usage, finish reasons, message
// events). Effect's own Telemetry.addGenAIAnnotations stamps the semconv
// attributes on our span. Metrics + correlated logs come along automatically.
import { ax, type AxLoggerFunction, AxMemory } from "@ax-llm/ax"
import { existsSync, readFileSync } from "node:fs"
import { emitActivity } from "./activity.ts"
import { allocate, BudgetExhaustedError, type BudgetUsage } from "./orch.ts"
import { finalizeOnMaxSteps, runNode } from "./orch-recipes.ts"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type { AnySpan } from "effect/Tracer"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"
import { BASE_TOOLS } from "./tools.ts"
import { BASE_PROMPT, limits, llm, MODEL, onEvent, rateLimiter } from "./runtime.ts"
import { ORCH_TOOLS } from "./orch-tools.ts"
import { RLM_TOOLS } from "./rlm-tool.ts"

const MAX_STEPS = limits.maxSteps // max tool-call iterations per turn — the HARD per-turn stop
// Per-turn SOFT TOKEN ceiling (advisory), tracked by orch's Budget (charged after each
// node from the forward result's usage). allocate() with no hard arg is pure-advisory:
// charge() NEVER throws for crossing it — a turn that did real work is never discarded.
// MAX_STEPS (tool-call iterations, recovered by turn() below) is the real per-turn stop;
// the token tally is a tracking/backstop signal. Only an explicit freeze() throws.
const TOKEN_BUDGET = limits.tokenBudget

const PROVIDER = "cloudflare.workers-ai"

// BASE_PROMPT (the capable base system prompt) lives in runtime.ts — the neutral
// cycle-breaker module — so orchestration NODE gens (orch-tools.ts) can import it
// without re-introducing the agent ⇄ orch-tools static init cycle. Re-exported here
// so callers that think of it as "the main agent's prompt" find it on agent.ts. A node
// is built from BASE_PROMPT + a persona overlay (NOT this ORCH_OVERLAY): a node is the
// main agent minus orchestration.
export { BASE_PROMPT }

// The orchestration paragraphs — appended to the MAIN chat gen ONLY (it alone carries
// ORCH_TOOLS). A node gen is built from BASE_PROMPT (above) WITHOUT this overlay: it has
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
  "nodes run with file tools only and canNOT themselves orchestrate (one level deep), a token budget caps each run, branches cap at 100 (at most ~8 run at once, the rest queue). Decompose at the top.",
  "User-invoked triggers: `^o` runs a built-in fan-out over the current input; `/run <name> [message]` loads + runs a saved script.",
  "To author a CUSTOM flow, write_file a script to `.ax/orch/<name>.ts` (trusted dir; paths escaping it are rejected) exporting",
  "`orchestrate(ctx, prims)`, then tell the user to `/run <name>`. prims = { node, parallel, pipeline, emit, allocate, gen } plus recipes",
  "{ runNode, judge, loopUntilDry, adversarialVerify, structuredPipeline }; ctx = { message, ai, budget, onEvent, optsFor(), usageOf }. The unit is a NODE: node(gen, opts) calls ax; runNode(spec, ai, input) runs ONE node. A dynamic orch script needs",
  "NO runtime imports — gen() is an ambient prim factory that builds nodes inline: gen(signature, description?) returns an AxGen for node().",
  "For a TYPED multi-step transform (each step's structured object feeds the next), use `structuredPipeline(stages, ai, input, onEvent, rootId)` where each",
  "stage is { gen, opts } and the gen's signature carries real types (e.g. gen('text:string -> facts:json') then gen('facts:json -> summary:string')) —",
  "stages thread STRUCTURED objects, not strings. See `.ax/orch/structured-pipe.ts`.",
  "Compose ONLY through prims, so the engine core stays the 5 primitives. RULE: never share a mutating memory across concurrent branches — call",
  "`ctx.optsFor()` for a fresh forked memory per parallel node. See `.ax/orch/example.ts` for the canonical pattern.",
  // RLM: the right tool for a BIG context blob that won't fit the prompt window.
  "Explore a LARGE context blob with `run_rlm(context, query)`: a Recursive Language Model loads the blob into a code runtime (NOT the prompt) and a",
  "sub-LM writes JavaScript (slice/regex/sub-queries) to mine it, returning an answer + evidence. PREFER run_rlm over orchestrate when the context is",
  "too big to fit the window and you need to FIND or SUMMARISE something buried inside (a long file, a pasted log, a whole concatenated module). The",
  "RLM is single-level too: it cannot orchestrate or call file tools.",
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
// Every orchestration sub-run NODE (orch-tools.ts) is built with BASE_TOOLS only, so a
// node physically cannot re-orchestrate: the structural one-level recursion guard.
const CHAT_TOOLS = [...BASE_TOOLS, ...ORCH_TOOLS, ...RLM_TOOLS]
const chat = ax("message:string -> reply:string", { functions: CHAT_TOOLS })
chat.setDescription(`${BASE_PROMPT} ${ORCH_OVERLAY}${loadProjectDoc()}`)

// The main chat gen's registered tool names — handed to finalizeOnMaxSteps so the in-loop
// step hook strips exactly these on the final permitted step (GRACEFUL max-steps ceiling).
const CHAT_TOOL_NAMES = CHAT_TOOLS.map((f) => f.name)

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
const finishReasonState: { last: string | undefined } = { last: undefined }
// Cast: Bun's `typeof fetch` carries a `.preconnect` member ax never calls.
const captureFetch = (async (input: any, init: any): Promise<Response> => {
  const res = await fetch(input, init)
  try {
    if (res.ok) {
      const j: any = await res.clone().json()
      const fr = j?.choices?.[0]?.finish_reason
      if (typeof fr === "string") finishReasonState.last = fr
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
// rateLimiter throttles concurrent forwards at the service level (min-interval, AX2_MAX_RPS)
// — the second layer under parallelLimit's in-flight cap. MUST ride in THIS same setOptions
// call: setOptions reassigns every field, so a later bare setOptions would wipe it (same
// reason fetch is here).
llm.setOptions({ debug: true, logger: liveLogger, fetch: captureFetch, rateLimiter })

// Metrics -> OTLP /v1/metrics via the PeriodicExportingMetricReader.
const turnsTotal = Metric.counter("chat_turns_total", { description: "completed chat turns" })
const turnsFailed = Metric.counter("chat_turns_failed", { description: "turns that ended in failure" })
const tokensTotal = Metric.counter("chat_tokens_total", { description: "total LLM tokens used" })
const turnDuration = Metric.timer("chat_turn_duration", { description: "per-turn latency" })

type Usage = { promptTokens?: number | undefined; completionTokens?: number | undefined; totalTokens?: number | undefined }

// Token usage off AxProgram.getUsage() (AxGen extends AxProgram) — a real, if
// lightly-documented, API returning AxProgramUsage[] with .tokens per call. It's
// the source for gen_ai.usage.* + the token metric (ax's own span carries usage
// only as an event). Guarded: yields nothing if ax changes the shape (non-fatal).
const readUsage = (gen: typeof chat): Usage | undefined => {
  const u = (gen as any).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return last?.tokens ?? last
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

export type TurnResult = { reply: string; tokens?: number | undefined; finishReason?: string | undefined; budget: boolean }

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

      finishReasonState.last = undefined // reset the captureFetch latch for this turn
      const aborter = new AbortController()
      turnAborters.set(sessionId, aborter)
      // One ADVISORY token budget for the whole turn. runNode() charges it from the forward
      // result's usage; crossing the SOFT ceiling only nudges (a delta in the tree) — it NEVER
      // discards the turn. The hard per-turn stop is MAX_STEPS (now handled GRACEFULLY in-loop
      // by stepHooks below, not by a throw). The tapCause below stays for an explicit
      // freeze()/runaway, which is the only thing that throws BudgetExhaustedError.
      const budget = allocate(TOKEN_BUDGET)
      const usageOf = (gen: typeof chat): BudgetUsage | undefined => readUsage(gen)

      yield* Effect.logInfo("turn.start").pipe(
        Effect.annotateLogs({ "session.id": sessionId, "message.chars": message.length }),
      )

      // GRACEFUL MAX-STEPS (claude_code ceiling): instead of letting ax throw
      // "max steps reached" and recovering with a SEPARATE no-tools gen (the old
      // brittle string-match + answerGen path), we hook ax's own tool loop. On the
      // LAST permitted step finalizeOnMaxSteps strips the tools, so ax is FORCED to
      // emit a final TEXT reply IN-LOOP — no throw, no string-match. onTruncate flips
      // the flag below so the turn is marked truncated-then-finalized (the session
      // AxMemory persists, so a follow-up turn resumes from where this one stopped).
      let budgetExhausted = false
      const stepHooks = finalizeOnMaxSteps(CHAT_TOOL_NAMES, onEvent, `turn:${sessionId}`, () => {
        budgetExhausted = true
      })

      // Make chat.turn the ACTIVE OTel context during forward so ax's tracer
      // (which reads context.active()) nests its gen_ai span under chat.turn.
      // stream:false -> no token streaming; we render step-by-step.
      // abortSignal -> ax cancels the in-flight forward when the UI interrupts.
      const runForward = (msg: string) =>
        Effect.tryPromise({
          try: () =>
            otelContext.with(traceContext, () =>
              // runNode() brackets the node in start→done|error node events; the opts
              // bag is threaded through unchanged (behavior-identical to a bare node).
              runNode(
                {
                  nodeId: `turn:${sessionId}`,
                  gen: chat,
                  opts: {
                    mem,
                    sessionId,
                    tracer,
                    traceContext,
                    maxSteps: MAX_STEPS,
                    stream: false,
                    abortSignal: aborter.signal,
                    stepHooks,
                  },
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

      const res = yield* runForward(message).pipe(
        // Token budget breach is a HARD failure: annotate the span with the typed
        // error's spent/total, then re-fail. (Max-steps no longer throws — it is
        // handled gracefully in-loop above — so this only catches a real runaway.)
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

      if (budgetExhausted) {
        yield* Effect.annotateCurrentSpan({ "chat.budget_exhausted": true, "chat.max_steps": MAX_STEPS })
        yield* Effect.logWarning("max steps reached -> finalized in-loop with tools disabled").pipe(
          Effect.annotateLogs({ "session.id": sessionId, "chat.max_steps": MAX_STEPS }),
        )
      }

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
          id: readResponseId(chat),
          finishReasons: finishReasonState.last ? [finishReasonState.last] : undefined,
        },
      })
      // Single gen now (the in-loop finalize answers on the SAME chat gen/mem), so usage is
      // just chat's — no separate answerGen to sum. sumUsage retained for orchestration paths.
      const usage = readUsage(chat)
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
        finishReason: finishReasonState.last,
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
