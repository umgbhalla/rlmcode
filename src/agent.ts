// Agent core in Effect. Tracing is "free": Effect.fn auto-creates the chat.turn
// span; we pass our OTel tracer + the active span's context INTO @ax-llm/ax so it
// emits canonical gen_ai.* child spans (token usage, finish reasons, message
// events). Effect's own Telemetry.addGenAIAnnotations stamps the semconv
// attributes on our span. Metrics + correlated logs come along automatically.
import { ax, AxMemory } from "@ax-llm/ax"
import { existsSync, readFileSync } from "node:fs"
import { liveLogger } from "./activity.ts"
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
import { setNodeSpanTracer } from "./orch-spans.ts"
import { BASE_PROMPT, limits, llm, MODEL, onEvent, rateLimiter } from "./runtime.ts"
import { RLM_WORKFLOW_TOOLS } from "./rlm-workflow.ts"
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
// cycle-breaker module — so orchestration NODE gens (rlm-workflow.ts) can import it
// without re-introducing the agent ⇄ rlm-workflow static init cycle. Re-exported here
// so callers that think of it as "the main agent's prompt" find it on agent.ts. A node
// is built from BASE_PROMPT + a persona overlay (NOT this RLM_WORKFLOW_OVERLAY): a node is the
// main agent minus orchestration.
export { BASE_PROMPT }

// The orchestration paragraphs — appended to the MAIN chat gen ONLY (it alone carries
// RLM_WORKFLOW_TOOLS). A node gen is built from BASE_PROMPT (above) WITHOUT this overlay: it has
// no orchestration tools, so telling it about rlm_workflow would be a lie.
const RLM_WORKFLOW_OVERLAY = [
  // ── ORCHESTRATION GUIDANCE ────────────────────────────────────────────────────────
  // Beyond a single reply you can drive deterministic multi-node runs (nodes render live
  // in a tree). Two tools: rlm_workflow (fan out sub-agents) and run_rlm (mine a big blob
  // in a code runtime). The unit everywhere is a NODE.
  "## Orchestration",
  "You can run deterministic multi-node flows, not just single replies. Tools: `rlm_workflow` (fan out sub-agents over distinct subtasks) and `run_rlm` (mine a huge blob in a code runtime). The unit is always a NODE.",
  // WHEN to orchestrate.
  "WHEN to orchestrate: (1) the task SPLITS into independent parts that don't depend on each other's output — fan them out (`rlm_workflow` with distinct `subtasks`); (2) you want the BEST of N attempts or to VERIFY an answer — use strategy `judge`/`best_of_n` (best-of-N) or `verify` (skeptics vote); (3) a BIG blob (long file, pasted log, whole concatenated module) won't fit the window — use `run_rlm`.",
  // WHEN NOT.
  "WHEN NOT: a trivial or strictly sequential task — DO IT DIRECTLY with your own file/shell tools. Do NOT fan out a one-liner. Do NOT spin up a node to read one file or run one command. Sequential steps (read → edit → test) are ONE node's task (yours): orchestration is for INDEPENDENT work or N-way redundancy, never to wrap a single linear chore.",
  // The strategy menu — one line each.
  "STRATEGY MENU (rlm_workflow's `strategy`, default `parallel`): `parallel` = fan DISTINCT subtasks, return all (division of labour); `judge` = run N, one judge picks the single best verbatim; `verify` = answer once, N skeptics vote accept/reject; `best_of_n` = re-run the fan-out until the survivor count is stable, then judge; `plan` = a planner node auto-decomposes `task` into distinct subtasks, then fans out one node per subtask.",
  "Examples: `rlm_workflow({ subtasks: ['audit src/auth for bugs', 'check tests cover edge cases', 'review error handling'] })` (parallel division of labour); `rlm_workflow({ task: 'design a rate limiter', strategy: 'judge', branches: 3 })` (best of 3); `rlm_workflow({ task: 'is this migration safe?', strategy: 'verify', branches: 4 })` (answer + 3 skeptics); `rlm_workflow({ task: 'refactor the auth module', strategy: 'plan' })` (auto-decompose then fan out).",
  // The hard rules.
  "HARD RULES: (1) give DISTINCT subtasks, never N copies of the same string — pass `subtasks` for division of labour; only omit them (and pass `task` alone) when you genuinely want N REDUNDANT attempts (e.g. `best_of_n`). (2) Stay BOUNDED — `branches` caps at 100 (~8 run at once, the rest queue); don't request more nodes than the task has distinct parts. (3) Pick MODEL + THINKING per node — pass `model` ('kimi' default | 'glm') and `effort` ('low'..'max') to route a node to a stronger/cheaper engine. (4) Sub-agent nodes carry the file/shell tools ONLY and canNOT themselves orchestrate (one level deep). (5) An RLM actor writes PURE JS in a sandbox — NEVER `require`/`import`; the data is already a runtime variable.",
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

// The MAIN chat gen gets BASE_TOOLS + RLM_WORKFLOW_TOOLS — it alone may self-orchestrate.
// Every orchestration sub-run NODE (rlm-workflow.ts) is built with BASE_TOOLS only, so a
// node physically cannot re-orchestrate: the structural one-level recursion guard.
const CHAT_TOOLS = [...BASE_TOOLS, ...RLM_WORKFLOW_TOOLS, ...RLM_TOOLS]
const chat = ax("message:string -> reply:string", { functions: CHAT_TOOLS })
// PROMPT SIZE (telemetry leap 2): the assembled system prompt (BASE_PROMPT + RLM_WORKFLOW_OVERLAY +
// projectDoc) is sent on EVERY turn. Record its char count so prompt bloat is visible on the
// span — an 8000-char projectDoc + full overlay every turn is a real latency lever.
const SYSTEM_PROMPT = `${BASE_PROMPT} ${RLM_WORKFLOW_OVERLAY}${loadProjectDoc()}`
export const SYSTEM_PROMPT_CHARS = SYSTEM_PROMPT.length
chat.setDescription(SYSTEM_PROMPT)

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

// REASONING TOKENS (telemetry leap 1): Kimi K2.7 (and GLM) are THINKING models — they
// emit reasoning_content before the reply, so most of a slow turn is REASONING, invisible
// in prompt/completion alone. ax's openai-compat provider maps the OpenAI
// completion_tokens_details.reasoning_tokens field onto AxTokenUsage.reasoningTokens (and
// the Gemini-style thoughtsTokens), confirmed in @ax-llm/ax/index.js. We surface BOTH so a
// 25s "hi" turn is attributable to thinking, not just opaque latency. thoughtsTokens prefers
// reasoningTokens (CF/openai) and falls back to thoughtsTokens (Gemini-shaped).
type Usage = {
  promptTokens?: number | undefined
  completionTokens?: number | undefined
  totalTokens?: number | undefined
  reasoningTokens?: number | undefined
  thoughtsTokens?: number | undefined
}

// Token usage off AxProgram.getUsage() (AxGen extends AxProgram) — a real, if
// lightly-documented, API returning AxProgramUsage[] with .tokens per call. It's
// the source for gen_ai.usage.* + the token metric (ax's own span carries usage
// only as an event). Guarded: yields nothing if ax changes the shape (non-fatal).
const readUsage = (gen: typeof chat): Usage | undefined => {
  const u = (gen as any).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return last?.tokens ?? last
}

// The reasoning-token count from a usage triple: prefer reasoningTokens (CF/openai
// completion_tokens_details.reasoning_tokens), else thoughtsTokens (Gemini usageMetadata).
// Undefined when neither is present (a non-thinking turn / provider that omits it).
const reasoningOf = (u: Usage | undefined): number | undefined =>
  u === undefined ? undefined : (u.reasoningTokens ?? u.thoughtsTokens)


// ponytail: provider response id read off ax's getChatLog() (remoteId). ax doesn't
// expose finish_reason publicly (it's on ax's own gen_ai child span already), so
// we only surface the id here. Ceiling: yields nothing if ax changes the log shape.
// Upgrade: ax public response-metadata API (id + finish_reason).
const readResponseId = (gen: typeof chat): string | undefined => {
  const log = (gen as any).getChatLog?.()
  const last = Array.isArray(log) ? log[log.length - 1] : undefined
  return last?.remoteId ?? undefined
}

export type TurnResult = { reply: string; tokens?: number | undefined; reasoningTokens?: number | undefined; finishReason?: string | undefined; budget: boolean }

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
      // SPAN GRANULARITY (telemetry 2b): wire the node-span minter to THIS turn's exporting
      // tracer so every orchestration/RLM NodeEvent fired mid-turn mints a REAL child span
      // nested under chat.turn — the trace mirrors the live tree. Turns are serialized
      // (busyAtom), so this module-global set is race-free across turns.
      setNodeSpanTracer(tracer)

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

      // TIMING BREAKDOWN (telemetry leap 3) + PROMPT SIZE (leap 2): stamp the span with
      // events that split the turn's wall-clock into assemble vs model vs parse. The system
      // prompt is assembled at module load (SYSTEM_PROMPT_CHARS) and re-sent verbatim each
      // turn, so 'prompt.assembled' carries the system+user char size; 'forward.sent'/
      // 'forward.received' bracket the model fetch (stream:false ⇒ one round trip). Even
      // though assemble is trivial here, separating it proves the time is in the MODEL, not
      // our plumbing — the key signal for a slow "hi" being all reasoning.
      const promptChars = SYSTEM_PROMPT_CHARS + message.length
      yield* Effect.annotateCurrentSpan({ "chat.prompt.system_chars": SYSTEM_PROMPT_CHARS, "chat.prompt.total_chars": promptChars })
      // Timing events go on the RAW OTel span (otelSpan, already resolved above) — Effect v4
      // exposes no addEventToCurrentSpan, and the OTel span carries timestamps natively.
      otelSpan.addEvent("prompt.assembled", { "chat.prompt.system_chars": SYSTEM_PROMPT_CHARS, "chat.prompt.total_chars": promptChars })

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

      // TIMING BREAKDOWN (telemetry 3): bracket the model fetch with span events. stream:false
      // ⇒ one round trip, so 'forward.sent' → 'forward.received' IS the model wall-clock (where
      // a slow thinking-model turn spends its time); 'parsed' marks ax's response parse done.
      // These are emitted on the raw OTel span so motel's span view shows the split.
      otelSpan.addEvent("forward.sent")
      const res = yield* runForward(message).pipe(
        (eff) => Effect.tap(eff, () => Effect.sync(() => otelSpan.addEvent("forward.received"))),
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
      // 'parsed' — ax has parsed the response into the structured reply + usage by now.
      otelSpan.addEvent("parsed")
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
        // REASONING TOKENS (telemetry 1): Effect's addGenAIAnnotations has no reasoning slot,
        // so stamp the canonical gen_ai.usage.thoughts_tokens key directly (the same key ax
        // uses on its own gen_ai span: LLM_USAGE_THOUGHTS_TOKENS). This is what makes a slow
        // "hi" attributable to THINKING — most of the latency on a thinking model is reasoning.
        const reasoning = reasoningOf(usage)
        if (typeof reasoning === "number") {
          yield* Effect.annotateCurrentSpan({
            "gen_ai.usage.thoughts_tokens": reasoning,
            "gen_ai.usage.reasoning_tokens": reasoning,
          })
        }
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

      const reasoningTokens = reasoningOf(usage)
      yield* Metric.update(turnsTotal, 1)
      // turn.done log now carries the ATTRIBUTION signal: reply size, total + reasoning tokens,
      // and prompt size — so the logs tab shows whether a slow "hi" was thinking vs prompt bloat.
      yield* Effect.logInfo("turn.done").pipe(
        Effect.annotateLogs({
          "reply.chars": reply.length,
          "tokens.total": usage?.totalTokens ?? 0,
          "tokens.prompt": usage?.promptTokens ?? 0,
          "tokens.completion": usage?.completionTokens ?? 0,
          "tokens.reasoning": reasoningTokens ?? 0,
          "prompt.chars": promptChars,
        }),
      )
      const result: TurnResult = {
        reply,
        tokens: usage?.totalTokens,
        reasoningTokens,
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
