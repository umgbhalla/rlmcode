// Agent core in Effect. Tracing is "free": Effect.fn auto-creates the chat.turn
// span; we pass our OTel tracer + the active span's context INTO @ax-llm/ax so it
// emits canonical gen_ai.* child spans (token usage, finish reasons, message
// events). Effect's own Telemetry.addGenAIAnnotations stamps the semconv
// attributes on our span. Metrics + correlated logs come along automatically.
import { ax, type AxAIService, type AxFunction, type AxGen, AxMemory } from "@ax-llm/ax"
import { existsSync, readFileSync } from "node:fs"
import { makeLiveLogger } from "./activity.ts"
import { allocate, type ActivitySink, BudgetExhaustedError, type BudgetUsage } from "./orch.ts"
import { finalizeOnMaxSteps } from "./orch-recipes.ts"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type { AnySpan } from "effect/Tracer"
import * as Telemetry from "effect/unstable/ai/Telemetry"
import { SERVICE_NAME, SERVICE_VERSION } from "../otel.ts"
import { BASE_TOOLS } from "./tools.ts"
import { setNodeSpanTracer, setTurnContext } from "./orch-spans.ts"
import { BASE_PROMPT, limits, llm, makeOnEvent, MODEL, rateLimiter, setTurnEmit } from "./runtime.ts"
import { makeMockAI, MOCK_MODEL, setMockEmit } from "./mock-ai.ts"
import { MOCK_ORCH_TOOL } from "./mock.ts"
import { WORKFLOW_TOOLS } from "./workflow.ts"

// Step/token ceilings default to today's app values (limits, from runtime.ts): maxSteps is
// the HARD per-turn stop (tool-call iterations, handled gracefully in-loop by stepHooks); the
// token budget is an ADVISORY soft ceiling charged after each node, NEVER discarding a turn
// that did real work (only an explicit freeze() throws). Both are now createAgent inputs
// (config.maxSteps / config.tokenBudget) so a caller can override per agent.

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
  // in a tree). ONE tool: workflow({ script }) — author a JS orchestration script. The unit
  // everywhere is a NODE. (rlm_workflow's fixed strategies are now just a few lines of script.)
  "## Orchestration",
  "You can run deterministic multi-node flows, not just single replies. ONE tool: `workflow({ script })` — AUTHOR a JS orchestration script the engine runs. The unit is always a NODE.",
  // WHEN to orchestrate.
  "WHEN to orchestrate: (1) the task SPLITS into independent parts that don't depend on each other's output — fan them out with `parallel`; (2) you want the BEST of N attempts or to VERIFY an answer — generate N and `judge`, or run N skeptics and vote; (3) a BIG blob (long file, pasted log, whole concatenated module) won't fit the window — mine it with the `rlm` prim.",
  // WHEN NOT.
  "WHEN NOT: a trivial or strictly sequential task — DO IT DIRECTLY with your own file/shell tools. Do NOT fan out a one-liner. Do NOT spin up a node to read one file or run one command. Sequential steps (read → edit → test) are ONE node's task (yours): orchestration is for INDEPENDENT work or N-way redundancy, never to wrap a single linear chore.",
  // The prims.
  "`workflow({ script })`: the script body sees ONLY these prims: `phase(title)` groups the nodes that follow under a live tree heading; `log(msg)` narrates; `agent(prompt, {label?, model?, effort?, schema?})` spawns ONE sub-agent NODE (file/shell tools) → its text (or a validated object with schema, or null if it dies); `parallel(thunks)` is a BARRIER (all concurrent, ≤8 at once, a throwing thunk → null — `.filter(Boolean)`); `pipeline(items, ...stages)` flows each item through every stage with NO barrier (`stage(prev, item, i)`); `judge(candidates, criteria?)` picks the best verbatim; `rlm(context, query)` mines a BIG blob in a code runtime kept OUT of the prompt (the RLM node-kind — just a prim); `budget` is `{total, spent(), remaining()}`. `return <value>` is what comes back to you.",
  // Patterns as scripts (replacing the old fixed strategy menu).
  "PATTERNS (write the strategy as a script): division of labour — `phase('audit'); const rs = await parallel([()=>agent('audit src/auth for bugs'),()=>agent('check tests cover edge cases'),()=>agent('review error handling')]); return rs.filter(Boolean).join('\\n');`. Best of N + judge — `const c = await parallel([0,1,2].map(()=>()=>agent('design a rate limiter'))); return await judge(c.filter(Boolean));`. Verify (2-vote) — `const v = (await parallel([0,1].map(i=>()=>agent('refute: '+claim, {schema: VERDICT, label: 'vote:'+i})))).filter(Boolean); const ok = v.length>=2 && v.every(x=>!x.refuted);`. Survey-loop (the workhorse) — `for (let r=1;r<=12;r++){ phase('survey'); const s = await agent('scan -> total', {schema: S}); if (s.total===0) break; await pipeline(frontier, fix, verify, apply); }`. Mine a blob — `return await rlm(BIG_BLOB, 'which function registers the /auth route?');`.",
  // The hard rules.
  "HARD RULES: (1) give DISTINCT work per node, never N copies of the same string — only run N redundant attempts when you genuinely want best-of-N. (2) Stay BOUNDED — `parallel` runs ≤8 at once, the rest queue; don't fan out more nodes than the task has distinct parts. (3) Route per node — pass `model` ('kimi' default | 'glm') and `effort` ('low'..'max') to send a node to a stronger/cheaper engine. (4) Sub-agent nodes carry the file/shell tools ONLY and canNOT themselves orchestrate (one level deep — a script canNOT spawn a script). (5) The `rlm` actor writes PURE JS in a sandbox — NEVER `require`/`import`; the data is already a runtime variable.",
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

// The MAIN chat gen's DEFAULT toolset: BASE_TOOLS + WORKFLOW_TOOLS — it alone may
// self-orchestrate (the single `workflow` tool; `rlm_workflow` was dropped as a redundant
// fixed-strategy wrapper — its strategies are now scripts). Every orchestration sub-run NODE
// is built with BASE_TOOLS only, so a node physically cannot re-orchestrate: the structural
// one-level recursion guard. This is the default `tools` for createAgent(); a caller may
// inject its own (e.g. [] for a headless smoke). The full system prompt (BASE_PROMPT +
// RLM_WORKFLOW_OVERLAY + projectDoc) is assembled inside createAgent so the prompt always
// matches whatever gen the factory constructs.
export const CHAT_TOOLS: AxFunction[] = [...BASE_TOOLS, ...WORKFLOW_TOOLS]

// The assembled system prompt (BASE_PROMPT + RLM_WORKFLOW_OVERLAY + projectDoc) — sent on
// EVERY turn. Built once here for the DEFAULT agent; createAgent re-assembles the identical
// string per factory so each agent's prompt matches its gen.
const buildSystemPrompt = (): string => `${BASE_PROMPT} ${RLM_WORKFLOW_OVERLAY}${loadProjectDoc()}`
// PROMPT SIZE (telemetry leap 2): record the DEFAULT prompt's char count so prompt bloat is
// visible on the span — an 8000-char projectDoc + full overlay every turn is a real latency
// lever. Exported (atoms.ts/chat.tsx-stable); turn() reads its OWN agent's prompt size.
export const SYSTEM_PROMPT_CHARS = buildSystemPrompt().length

class ChatError {
  readonly _tag = "ChatError"
  constructor(readonly cause: unknown) {}
}

// The token budget (orch.allocate) throws BudgetExhaustedError, wrapped by
// runForward into a ChatError. Unwrap one level to surface it on the span.
const asBudgetExhausted = (e: unknown): BudgetExhaustedError | undefined =>
  e instanceof ChatError && e.cause instanceof BudgetExhaustedError ? e.cause : undefined

// SEAL (core/tui split): the finish_reason skim (a fetch.clone() wrapper reading
// choices[0].finish_reason) and the response-id read (getChatLog().remoteId) are GONE. Their only
// public output was finishReason/response.id — both provider-wire signals, dropped from the
// normalized public TurnResult (src/core/run.ts). ax's own gen_ai child span still carries
// finish_reason as an event for motel; we no longer surface it on our span or the result.

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
const readUsage = (gen: AxGen): Usage | undefined => {
  const u = (gen as any).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return last?.tokens ?? last
}

// The reasoning-token count from a usage triple: prefer reasoningTokens (CF/openai
// completion_tokens_details.reasoning_tokens), else thoughtsTokens (Gemini usageMetadata).
// Undefined when neither is present (a non-thinking turn / provider that omits it).
const reasoningOf = (u: Usage | undefined): number | undefined =>
  u === undefined ? undefined : (u.reasoningTokens ?? u.thoughtsTokens)

// The INTERNAL turn result (driven by runTurn, which normalizes it into the public TurnResult in
// src/core/run.ts). No finishReason / response.id — those provider-wire signals were sealed off.
export type TurnResult = { reply: string; tokens?: number | undefined; reasoningTokens?: number | undefined; budget: boolean }

// ── DI: createAgent — the injectable factory ───────────────────────────────────
// The THREE things that used to be module singletons (the AI service, the chat gen,
// and the step/token limits) are now factory inputs. `ai` + `model` are required; the
// rest default to today's app values (CHAT_TOOLS / limits.maxSteps / limits.tokenBudget /
// liveLogger) so the DEFAULT agent (constructed at module load below over the CF `llm`)
// behaves BYTE-FOR-BYTE as before. An external caller can inject their OWN AxAIService
// (OpenAI, Ollama, a stub) + tools/model/limits and run turns with NO Cloudflare env.
export type AxAgentConfig = {
  readonly ai: AxAIService
  readonly model: string
  readonly maxSteps?: number | undefined
  readonly tokenBudget?: number | undefined
  readonly tools?: AxFunction[] | undefined
}

export const createAgent = (config: AxAgentConfig) => {
  const { ai: service, model } = config
  const maxSteps = config.maxSteps ?? limits.maxSteps
  const tokenBudget = config.tokenBudget ?? limits.tokenBudget

  // The chat gen — built ONCE per createAgent call (closure-scoped, not module-scoped).
  // The full system prompt (BASE_PROMPT + RLM_WORKFLOW_OVERLAY + projectDoc) always matches
  // the gen the factory constructs; the registered tool names feed finalizeOnMaxSteps.
  const chatTools = config.tools ?? CHAT_TOOLS
  const chat = ax("message:string -> reply:string", { functions: chatTools })
  const systemPrompt = buildSystemPrompt()
  // PROMPT SIZE (telemetry leap 2): this agent's actual assembled prompt char count, read by
  // turn() below. The system prompt is tool-independent (BASE_PROMPT + RLM_WORKFLOW_OVERLAY +
  // projectDoc), so it equals the module-level SYSTEM_PROMPT_CHARS export for every agent —
  // reuse it (it's also the value the telemetry-live harness asserts against).
  const systemPromptChars = SYSTEM_PROMPT_CHARS
  chat.setDescription(systemPrompt)
  // The registered tool names — handed to finalizeOnMaxSteps so the in-loop step hook strips
  // exactly these on the final permitted step (GRACEFUL max-steps ceiling).
  const chatToolNames = chatTools.map((f) => f.name)

  // Bind debug + rateLimiter on the injected service. The LOGGER is NO LONGER bound here — it is
  // a PER-TURN forward option (makeLiveLogger(emit), threaded by turn() from runTurn's per-turn
  // emit), which kills the last module-load global (the old service-level liveLogger binding).
  // setOptions reassigns every field.
  service.setOptions({ debug: true, rateLimiter })

  // One in-flight AbortController per session (overwritten each turn), scoped to THIS
  // agent so two agents never collide on a sessionId. abortTurn() lets the UI cancel a
  // running turn: ax honors abortSignal in forward() and throws AxAIServiceAbortedError,
  // which surfaces as a normal turn failure.
  const turnAborters = new Map<string, AbortController>()
  const abortTurn = (sessionId: string): boolean => {
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
  const turn = (mem: AxMemory, parent: AnySpan, sessionId: string, emit: ActivitySink) =>
    Effect.fn("chat.turn", {
      kind: "client",
      // Parent to the session root (ExternalSpan) via span options -> all turns of
      // a session share one trace. (Do NOT use withParentSpan as a trailing combi:
      // it wipes the fn's own span context.)
      parent,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": PROVIDER,
        "gen_ai.request.model": model,
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
        // TEST-ONLY (off in prod): point the mock AI's group-variant tool-CALL feed at THIS
        // turn's emit. The mock service bypasses ax's response logging, so its read/glob/grep
        // cluster's call rows would never reach the live feed otherwise; setMockEmit re-binds the
        // sink per turn (serialized turns, so no cross-feed). Unset AX2_MOCK ⇒ never called.
        if (process.env.AX2_MOCK === "1") setMockEmit(emit)
        // Stash THIS turn's emit + OTel context by sessionId so a tool handler (workflow/RLM)
        // can recover them: ax forwards a FIXED extra (sessionId/ai/abortSignal/…) to a tool
        // func — NOT arbitrary forward opts — so neither the per-turn `emit` nor the traceContext
        // reaches the handler via opts. A workflow node's lifecycle rows would otherwise vanish
        // and its spans fragment into a NEW trace. Both keyed by sessionId, overwritten each turn
        // (serialized by busyAtom, so no cross-feed).
        setTurnEmit(sessionId, emit)
        setTurnContext(sessionId, traceContext)

        const aborter = new AbortController()
      turnAborters.set(sessionId, aborter)
      // One ADVISORY token budget for the whole turn. runNode() charges it from the forward
      // result's usage; crossing the SOFT ceiling only nudges (a delta in the tree) — it NEVER
      // discards the turn. The hard per-turn stop is MAX_STEPS (now handled GRACEFULLY in-loop
      // by stepHooks below, not by a throw). The tapCause below stays for an explicit
      // freeze()/runaway, which is the only thing that throws BudgetExhaustedError.
      const budget = allocate(tokenBudget)
      const usageOf = (gen: AxGen): BudgetUsage | undefined => readUsage(gen)

      yield* Effect.logInfo("turn.start").pipe(
        Effect.annotateLogs({ "session.id": sessionId, "message.chars": message.length }),
      )

      // TIMING BREAKDOWN (telemetry leap 3) + PROMPT SIZE (leap 2): stamp the span with events
      // that split the turn's wall-clock into assemble vs model vs parse. The system prompt is
      // assembled at module load (SYSTEM_PROMPT_CHARS) and re-sent verbatim each turn, so
      // 'prompt.assembled' carries the system+user char size; 'forward.sent'/'forward.received'
      // bracket the model fetch. Separating assemble proves the time is in the MODEL, not our
      // plumbing — the key signal for a slow "hi" being all reasoning.
      const promptChars = systemPromptChars + message.length
      yield* Effect.annotateCurrentSpan({ "chat.prompt.system_chars": systemPromptChars, "chat.prompt.total_chars": promptChars })
      // Timing events go on the RAW OTel span (otelSpan, already resolved above) — Effect v4
      // exposes no addEventToCurrentSpan, and the OTel span carries timestamps natively.
      otelSpan.addEvent("prompt.assembled", { "chat.prompt.system_chars": systemPromptChars, "chat.prompt.total_chars": promptChars })

      // GRACEFUL MAX-STEPS (claude_code ceiling): instead of letting ax throw "max steps reached"
      // and recovering with a SEPARATE no-tools gen (the old brittle string-match + answerGen
      // path), we hook ax's own tool loop. On the LAST permitted step finalizeOnMaxSteps strips
      // the tools, so ax is FORCED to emit a final TEXT reply IN-LOOP — no throw, no string-match.
      // onTruncate flips the flag below; the session AxMemory persists, so a follow-up turn
      // resumes from where this one stopped.
      // PER-TURN node-event sink: build onEvent over THIS turn's activity emit (the closure
      // runTurn threaded in), so the max-steps marker + any orch NodeEvent fired this turn lands
      // in THIS turn's queue — no module global. Also handed to tool handlers via forward `extra`.
      const onEvent = makeOnEvent(emit)
      let budgetExhausted = false
      const stepHooks = finalizeOnMaxSteps(chatToolNames, onEvent, `turn:${sessionId}`, () => {
        budgetExhausted = true
      })

      // Make chat.turn the ACTIVE OTel context during forward so ax's tracer (which reads
      // context.active()) nests its gen_ai span under chat.turn. abortSignal -> ax cancels in-flight.
      const runForward = (msg: string) =>
        Effect.tryPromise({
          try: () =>
            otelContext.with(traceContext, async () => {
              // LIVE STREAM: drain ax's streamingForward generator. PROVEN (scripts probe): plain
              // forward(stream:true) collapses to ONE ChatResponseStreamingDoneResult (a single
              // dump, nothing live) — only streamingForward yields per-chunk deltas. ax emits the
              // reasoning first (delta.thought) then the answer (delta.reply), both INCREMENTAL, so
              // we append each to the per-turn emit → atoms grows the in-flight message → the dim-
              // italic thinking + the reply render token-by-token. Tools render via the per-turn
              // logger (makeLiveLogger(emit), set in `opts.logger` below — replaces the old service-
              // level liveLogger binding). A tool handler recovers the SAME per-turn emit via
              // getTurnEmit(sessionId) (ax drops non-standard opts from `extra`). stepHooks +
              // abortSignal ride along.
              const opts = {
                mem,
                sessionId,
                tracer,
                traceContext,
                maxSteps,
                stream: true,
                abortSignal: aborter.signal,
                stepHooks,
                logger: makeLiveLogger(emit),
                debug: true,
              }
              let reply = ""
              for await (const d of chat.streamingForward(service, { message: msg }, opts as Parameters<typeof chat.streamingForward>[2])) {
                const delta = (d as { delta?: { reply?: string; thought?: string } }).delta ?? {}
                if (delta.thought) emit({ kind: "thinkingDelta", text: delta.thought })
                if (delta.reply) {
                  reply += delta.reply
                  emit({ kind: "replyDelta", text: delta.reply })
                }
              }
              // ADVISORY budget charge (runNode used to do this; the streaming drain bypasses it).
              budget.charge(usageOf(chat))
              return { reply }
            }),
          catch: (e) => new ChatError(e),
        })

      // TIMING BREAKDOWN (telemetry 3): bracket the model fetch with span events — 'forward.sent'
      // → 'forward.received' IS the model wall-clock; 'parsed' marks ax's response parse done.
      // Emitted on the raw OTel span so motel's span view shows the split.
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
        yield* Effect.annotateCurrentSpan({ "chat.budget_exhausted": true, "chat.max_steps": maxSteps })
        yield* Effect.logWarning("max steps reached -> finalized in-loop with tools disabled").pipe(
          Effect.annotateLogs({ "session.id": sessionId, "chat.max_steps": maxSteps }),
        )
      }

      // Canonical gen_ai annotations via Effect's own helper (no hand-typed keys). response.id /
      // finish_reason are NOT surfaced here (provider-wire, sealed off) — ax's own gen_ai child
      // span still carries finish_reason as an event for motel.
      const span = yield* Effect.currentSpan
      // 'parsed' — ax has parsed the response into the structured reply + usage by now.
      otelSpan.addEvent("parsed")
      Telemetry.addGenAIAnnotations(span, {
        system: PROVIDER as any,
        operation: { name: "chat" },
        request: { model },
        response: { model },
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

  return { turn, abortTurn }
}

// The injectable agent surface. turn() STAYS Effect-returning (the Effect.fn span +
// budget recovery + metrics + OTel annotations live INSIDE the closure exactly as
// before, just sourced from config). Derived from createAgent's inferred shape so
// turn()'s exact Effect type (error+context channels) is preserved for callers (atoms.ts).
export type AxAgentSDK = ReturnType<typeof createAgent>

// The DEFAULT app agent — constructed ONCE over the CF-Kimi `llm` (runtime.ts) at the
// app's default model. This is the single construction site every importer pulls from;
// re-exporting turn/abortTurn keeps atoms.ts / chat.tsx byte-identical.
//
// NARROW TEST-ONLY SEAM (off in prod): AX2_MOCK=1 swaps the CF service for the canned mock
// AI (mock-ai.ts — zero network), so a headless harness drives the REAL turn loop with no
// Cloudflare env. The flag is read ONCE here; unset ⇒ the unchanged CF path. mock-ai.ts
// imports nothing from this module, so the seam introduces no init cycle.
export const defaultAgent: AxAgentSDK =
  process.env.AX2_MOCK === "1"
    ? createAgent({ ai: makeMockAI(process.env.AX2_MOCK_STREAM === "1"), model: MOCK_MODEL, tools: [...BASE_TOOLS, MOCK_ORCH_TOOL] })
    : createAgent({ ai: llm, model: MODEL })
export const turn = defaultAgent.turn
export const abortTurn = defaultAgent.abortTurn
