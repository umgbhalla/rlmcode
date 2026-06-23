// Orchestration core: a faithful PORT of the Workflow engine onto @ax-llm/ax.
// EXACTLY 5 orthogonal primitives, nothing else is engine. Promise-native at this
// level — Effect stays at the session boundary (turn() in agent.ts) and in otel.ts,
// NOT inside the combinators. runNode()/judge/workflow() are userland
// recipes (each <15 lines in these 5 prims), DELIBERATELY not reified here.
//
// UNIFIED VOCABULARY — ONE WORD: the orchestration unit is a NODE. The core prim that
// calls ax.forward() is `node` (below); the lifecycle-bracketed runner is runNode()
// (orch-recipes.ts). leaf/agent/worker/task/job/unit/runner are FORBIDDEN as names for
// the unit — they are all the SAME thing = a node. NodeEvent/NodeView already use it.
import type { AxGen, AxAIService, AxGenIn, AxGenOut, AxLoggerFunction, AxModelConfig, AxProgramForwardOptions, AxMemory, AxRateLimiterFunction, AxStepHooks } from "@ax-llm/ax"
import { type Context as OtelContext, type Tracer, trace as otelTrace } from "@opentelemetry/api"
import * as Effect from "effect/Effect"
import type { Activity } from "./activity.ts"
import { endNodeSpan, errorNodeSpan, startNodeSpan } from "./orch-spans.ts"

// The real forward() opts bag threaded by turn() (agent.ts). This is a STRUCTURAL
// SUPERSET of AxProgramForwardOptions, NOT an alias: sessionId/tracer/traceContext
// are custom turn-level extensions that forward() tolerates today but does not
// declare. Keeping NodeOpts an honest description of the real bag — node() casts to
// Readonly<AxProgramForwardOptions<string>> at the forward() boundary (see node).
export type NodeOpts = {
  mem: AxMemory
  sessionId: string
  tracer: Tracer // @opentelemetry/api Tracer (same instance turn() builds)
  traceContext: OtelContext // @opentelemetry/api Context
  maxSteps: number
  stream: boolean
  abortSignal: AbortSignal
  // GRACEFUL MAX-STEPS finalize knob (claude_code ceiling): on the LAST forward of a turn/
  // node — the one that must produce a final text reply instead of looping more tools — we
  // set this to 'none' so ax disables tool-calling (tool_choice:'none' on the CF/openai
  // provider) and the model is FORCED to answer from the tool results already in mem. ax's
  // AxProgramForwardOptions.functionCall accepts this verbatim; node() casts the bag through.
  // Omitted/undefined on a normal forward (tools stay 'auto'). NOT an `any`: a real ax option.
  functionCall?: "none" | "auto" | "required"
  // GRACEFUL MAX-STEPS in-loop hook (claude_code ceiling). ax's stepHooks.beforeStep fires at the
  // START of each step; finalizeOnMaxSteps (orch-recipes.ts) strips the tools on the LAST permitted
  // step so the model is FORCED to answer (no throw, no string-match). A real ax forward option
  // (AxProgramForwardOptions.stepHooks); node() threads it through the same cast. Omitted ⇒ ax's
  // default (throw on max-steps), so callers that want the graceful ceiling supply it explicitly.
  stepHooks?: AxStepHooks
  // MULTI-MODEL routing (per-NODE model + thinking level). ALL optional — absent ⇒ the
  // shared service's default model (Kimi K2.7) at default effort, i.e. UNCHANGED behaviour.
  // `model` is the per-forward CF model id (ax swaps the model param of the SAME service —
  // both pool models live on the same CF endpoint, no separate AxAIService). `modelConfig`
  // carries the AxModelConfig fragment (effort hint + the maxTokens FLOOR that keeps a
  // thinking model's reasoning from starving its content). `thinkingTokenBudget` is ax's
  // string-level thinking control. ALL are real AxProgramForwardOptions fields; node() casts
  // the bag through. Built by src/models.ts nodeForwardOpts() and spread onto NodeOpts.
  model?: string | undefined
  modelConfig?: AxModelConfig | undefined
  thinkingTokenBudget?: "minimal" | "low" | "medium" | "high" | "highest" | "none" | undefined
  // PER-NODE TOOL ROUTING: a per-forward logger bound to this node's id (makeNodeLogger).
  // ax calls it during forward() as steps complete, so the node's tool/result activities are
  // tagged with its nodeId and route to its OrchTree node (not the main transcript). A REAL
  // ax forward option (AxAIServiceOptions.logger; AxProgramForwardOptions extends it) — node()
  // casts the bag through. `debug` MUST be true for ax to INVOKE the logger; we set it per-call
  // (forward opts win over the service's debug) so a node's logger fires even on a service
  // without service-level debug (e.g. the live harness's standalone AI). Both omitted ⇒ ax's
  // service-level logger/debug (the main turn's untagged transcript logger), i.e. UNCHANGED.
  logger?: AxLoggerFunction | undefined
  debug?: boolean | undefined
  // PER-TURN activity sink (the closure runTurn threads). When a node forward runs WITHOUT an
  // explicit `logger`, withNodeLogger (orch-recipes) builds makeNodeLogger(emit, nodeId) from
  // this so the node's tool/result activities tag with its id and land in THIS turn's queue —
  // replacing the deleted module-global activity sink. Omitted ⇒ a no-op feed (a standalone
  // recipe call with no turn boundary, e.g. a headless test) — the forward still runs.
  emit?: ActivitySink | undefined
  // PER-CALL fetch override (finish-reason capture). A real ax forward option:
  // AxProgramForwardOptions extends AxAIServiceOptions, which declares `fetch?`. turn()
  // (agent.ts) threads a per-turn capture wrapper here instead of mutating the shared
  // service, so the finish-reason latch is per-turn (concurrency-safe), not a module
  // global. Omitted ⇒ the service's own fetch (UNCHANGED for nodes that don't set it).
  fetch?: typeof fetch | undefined
  // PER-CALL rate-limiter override (FIX B / contention): the BACKGROUND-NODE throttle lane.
  // AxProgramForwardOptions extends AxAIServiceOptions, which declares `rateLimiter?`; a per-
  // forward limiter overrides the service-level one. workflow-prims optsFor sets this to
  // runtime.nodeRateLimiter so every background node throttles on its OWN clock, separate from
  // the chat turn's service-level lane — a node fan-out can't starve the interactive turn.
  // Omitted ⇒ the service's own rateLimiter (the chat lane) — UNCHANGED for the main turn.
  rateLimiter?: AxRateLimiterFunction | undefined
}

// RATE-LIMIT VISIBILITY: the CAUSE of a transient retry — a 429 (rate-limit, the most common CF
// failure) vs any other transient (5xx / network / request-timeout). Carried on the `retry`
// NodeEvent so the live tree + composer can word a 429 distinctly ("rate-limited") from a generic
// transient hiccup ("retrying"). Logic/budget errors are NEVER retried, so they never reach here.
export type RetryCause = "rate_limited" | "transient"

// A node lifecycle event over the EXISTING activity bus + OTel span annotation —
// do NOT invent a second event system. Consumed by emit() (a thin hook).
export type NodeEvent =
  | { readonly type: "start"; readonly nodeId: string; readonly parentId?: string | undefined; readonly phase: string }
  | { readonly type: "delta"; readonly nodeId: string; readonly chunk: string }
  // RATE-LIMIT VISIBILITY: a transient (429/5xx/network) failure is about to be retried after a
  // backoff. Emitted by withRetry's onRetry (orch-resilience) BEFORE the backoff sleep, so the node
  // shows it's WAITING (not silently "thinking…") while it backs off — the gap that made a 429
  // indistinguishable from the crawl/hang. `attempt`/`max` are 1-based ("retry 2/3"); `delayMs` is
  // the backoff this retry waits. atoms folds it into a `retry` status on the node (cleared on the
  // next start/done/error), so the tree row + the composer surface "⏳ rate-limited · retry 2/3 · 4s".
  | { readonly type: "retry"; readonly nodeId: string; readonly cause: RetryCause; readonly attempt: number; readonly max: number; readonly delayMs: number }
  // COST-METER: `tokens` is this node's OWN token usage (the leaf forward's totalTokens,
  // derived by tokensOf() from the usage triple). Optional — a node that didn't charge a
  // budget (no usageOf) omits it. atoms folds it into the OrchTree per-node + run total.
  | { readonly type: "done"; readonly nodeId: string; readonly result: unknown; readonly tokens?: number | undefined }
  | { readonly type: "error"; readonly nodeId: string; readonly cause: unknown }

export type EmitOpts = { readonly spanId?: string }

// The usage reader shape from agent.ts (readUsage/sumUsage): a leaf's token usage
// as a structural triple. charge() derives a token count from this (totalTokens, or
// promptTokens+completionTokens as a fallback) and adds it to the internal tally.
export type BudgetUsage = { promptTokens?: number | undefined; completionTokens?: number | undefined; totalTokens?: number | undefined }

// ADVISORY token gate (soft budget). Holds an internal used-token tally; charge()
// adds a leaf's usage AFTER it returns and NEVER throws for crossing the soft line —
// a leaf that did real work is never discarded for spending tokens. spent()/remaining()
// reflect the tally; over()/overSoft() expose the soft/hard state for a nudge/log.
// `total` is the SOFT ceiling (the advisory nudge line); `hard` is the runaway backstop
// (default Infinity = pure advisory) — only crossing `hard`, or an explicit freeze(),
// throws BudgetExhaustedError. maxSteps (per-leaf, ax-enforced) is the real hard stop.
export type Budget = {
  readonly total: number // soft ceiling (advisory nudge line)
  readonly hard: number // hard ceiling (runaway backstop; Infinity = pure advisory)
  charge(usage: BudgetUsage | undefined): void
  spent(): Promise<number>
  remaining(): Promise<number>
  // true once spend crosses the SOFT ceiling — drives an advisory nudge/log, NOT a throw.
  overSoft(): boolean
  freeze(reason: string): void
}

// Typed, throwable budget breach: emitted by freeze() and by charge() ONLY when the
// tally crosses the HARD ceiling (a genuine runaway). Crossing the SOFT ceiling does
// NOT throw — it nudges. Carries the reason and the spent/total numbers so a boundary
// catch can annotate a span or surface a partial.
export class BudgetExhaustedError extends Error {
  readonly _tag = "BudgetExhaustedError"
  readonly reason: string
  readonly spent: number
  readonly total: number
  constructor(reason: string, spent: number, total: number) {
    super(`budget exhausted (${reason}): spent ${spent} of ${total} tokens`)
    this.reason = reason
    this.spent = spent
    this.total = total
    this.name = "BudgetExhaustedError"
  }
}

// Derive a token count from a usage triple: prefer totalTokens, else sum the parts.
// Exported for the COST-METER: recipes pass a node's usage through this to stamp the
// per-node token count on its done event, and the headless test drives fake usage here.
export const tokensOf = (u: BudgetUsage | undefined): number =>
  u === undefined ? 0 : typeof u.totalTokens === "number" ? u.totalTokens : (u.promptTokens ?? 0) + (u.completionTokens ?? 0)

// RATE-LIMIT VISIBILITY: the SINGLE source of truth for the retry status string a retrying node
// shows — "⏳ rate-limited · retry 2/3 · 4s" for a 429, "⏳ retrying 2/3 · 4s" for a generic
// transient. The ⏳ glyph + wording is what the tree row (orch-tree summaryOf) AND the composer
// status both render, and what the frame gate asserts. Backoff ms rounds UP to whole seconds so a
// sub-second backoff still reads "1s" (never "0s"). Pure — exported so emit() + the UI agree.
export const retryStatus = (cause: RetryCause, attempt: number, max: number, delayMs: number): string => {
  const secs = Math.max(1, Math.ceil(delayMs / 1000))
  const label = cause === "rate_limited" ? "rate-limited · retry" : "retrying"
  return `⏳ ${label} ${attempt}/${max} · ${secs}s`
}

// 1. node — the ONLY thing that calls ax. Curried so opts bind once, then (ai,input)
// runs the forward. opts is cast to Readonly<AxProgramForwardOptions> at the boundary:
// NodeOpts is a known structural superset (carries sessionId/tracer/traceContext that
// AxProgramForwardOptions omits); the <string> arg matches forward()'s model-key param.
// This is sound — not `any`, no ponytail needed.
export const node =
  <I extends AxGenIn, O extends AxGenOut>(gen: AxGen<I, O>, opts: NodeOpts) =>
  (ai: AxAIService, input: I): Promise<O> =>
    gen.forward(ai, input, opts as Readonly<AxProgramForwardOptions<string>>)

// 2. parallel — the ONLY fan-out. Failed slots resolve to null (never reject);
// callers .filter(Boolean). A scoped fiber set at the Effect boundary above interrupts
// these on run cancellation.
export const parallel = <T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>> =>
  Promise.all(thunks.map((t) => t().catch(() => null)))

// 3. pipeline — the ONLY sequence. NO barrier between stages: item A may be in stage 3
// while B is still in stage 1. Async-generator fan-through, each item flows
// stage->stage independently.
export async function* pipeline<T>(
  items: AsyncIterable<T> | Iterable<T>,
  ...stages: ReadonlyArray<(x: any) => Promise<any> | AsyncIterable<any>>
): AsyncGenerator<unknown> {
  const run = async function* (value: unknown, depth: number): AsyncGenerator<unknown> {
    if (depth === stages.length) {
      yield value
      return
    }
    const out = stages[depth]!(value)
    if (out != null && typeof (out as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      for await (const next of out as AsyncIterable<unknown>) yield* run(next, depth + 1)
    } else {
      yield* run(await out, depth + 1)
    }
  }
  for await (const item of items as AsyncIterable<T>) yield* run(item, 0)
}

// The per-turn Activity destination — a plain closure created INSIDE runTurn (src/core/run.ts)
// pushing into THAT turn's queue. Threaded into emit() (below) and the loggers in activity.ts,
// REPLACING the deleted module-global sink. Concurrency-correct: each turn has its own sink, so
// two turns' node events never interleave into one buffer.
export type ActivitySink = (a: Activity) => void

// 4. emit — thin hook over the per-turn activity sink + the active OTel span. Maps each
// NodeEvent variant to an Activity (pushed via the supplied `sink`) AND annotates the span in
// scope (addEvent + attributes). Stays Effect<void>: the session boundary (turn() in agent.ts)
// runs it; the body is sync (sink push + span annotate). The `sink` is the per-turn emit closure
// threaded from runTurn — no module global.
export const emit = (event: NodeEvent, sink: ActivitySink, _opts?: EmitOpts): Effect.Effect<void> =>
  Effect.sync(() => {
    // 1) activity sink — orchestration node lifecycle row (the turn's queue / atoms reducer).
    // parentId travels on EVERY node Activity (not just start). delta/done/error
    // NodeEvents don't carry it, so it's undefined there — atoms preserves the
    // already-known parentId on update, so a child resolving before its parent's
    // start event never loses its edge.
    const activity: Activity =
      event.type === "delta"
        ? { kind: "node", nodeId: event.nodeId, event: "delta", parentId: undefined, detail: event.chunk }
        : event.type === "retry"
          ? // RATE-LIMIT VISIBILITY: a retry carries the formatted status string (retryStatus, the
            // one source of truth) as `detail` so atoms sets it as the node's live `retry` status —
            // visible WHILE backing off (the node stays "running"), not swallowed like the old delta.
            { kind: "node", nodeId: event.nodeId, event: "retry", parentId: undefined, detail: retryStatus(event.cause, event.attempt, event.max, event.delayMs) }
          : event.type === "done"
            ? { kind: "node", nodeId: event.nodeId, event: "done", parentId: undefined, detail: clip(event.result), tokens: event.tokens }
            : event.type === "error"
              ? { kind: "node", nodeId: event.nodeId, event: "error", parentId: undefined, detail: causeText(event.cause) }
              : { kind: "node", nodeId: event.nodeId, event: "start", parentId: event.parentId, detail: event.phase }
    sink(activity)

    // 1b) SPAN GRANULARITY (telemetry 2b) — mirror this NodeEvent as a REAL child span so
    // the trace shows per-node timing, not one opaque blob. start mints a child span (under
    // its parentId's span / the ambient active span); done/error end it with tokens/result.
    // Purely additive to the addEvent below — the live tree + point-events are unchanged.
    if (event.type === "start") startNodeSpan(event.nodeId, event.parentId, event.phase)
    else if (event.type === "done") endNodeSpan(event.nodeId, event.result, event.tokens)
    else if (event.type === "error") errorNodeSpan(event.nodeId, event.cause)

    // 2) active OTel span — addEvent + structured attributes. getActiveSpan() returns
    // a non-recording no-op span when there is none, so this is always safe.
    const span = otelTrace.getActiveSpan()
    if (span !== undefined) {
      span.addEvent(`orch.node.${event.type}`, {
        "orch.node.id": event.nodeId,
        ...(event.type === "start" ? { "orch.node.parent_id": event.parentId ?? "", "orch.node.phase": event.phase } : {}),
        ...(event.type === "delta" ? { "orch.node.chunk": event.chunk } : {}),
        // RATE-LIMIT VISIBILITY: a retry stamps the trace with the cause + attempt + backoff, so a
        // 429 storm is legible in motel's span view (the old delta named neither cause nor N/M).
        ...(event.type === "retry" ? { "orch.node.retry_cause": event.cause, "orch.node.retry_attempt": event.attempt, "orch.node.retry_max": event.max, "orch.node.retry_delay_ms": event.delayMs } : {}),
        ...(event.type === "done" ? { "orch.node.result": clip(event.result), ...(event.tokens !== undefined ? { "orch.node.tokens": event.tokens } : {}) } : {}),
        ...(event.type === "error" ? { "orch.node.cause": causeText(event.cause) } : {}),
      })
    }
  })

// Stringify an unknown payload for a span attribute / activity detail, bounded.
const clip = (v: unknown, max = 256): string => {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } })()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// HUMAN error text for an error NodeEvent — the message/tag, NOT the whole serialized
// error object. JSON.stringify(cause) leaked `{"nodeId":…,"_tag":"NodeTimeoutError",…}`
// as the node's summary cell (the widest row on screen); an Error's .message ("node X
// timed out after 120000ms") or a tagged error's _tag is what a human needs.
const causeText = (cause: unknown): string => {
  if (cause instanceof Error) return clip(cause.message)
  if (cause !== null && typeof cause === "object") {
    const o = cause as { message?: unknown; _tag?: unknown }
    if (typeof o.message === "string") return clip(o.message)
    if (typeof o._tag === "string") return clip(o._tag)
  }
  return clip(cause)
}

// 5. allocate — ADVISORY token gate over a real internal tally. `soft` is the nudge
// line; `hard` (default Infinity) is the runaway backstop. charge() folds a leaf's
// usage (the readUsage/sumUsage triple) into `used` and NEVER throws for crossing the
// soft line — the leaf result is always returned; crossing soft only flips overSoft()
// (the caller logs/nudges). It throws BudgetExhaustedError ONLY when `used` crosses the
// HARD ceiling (a genuine runaway), as does freeze(). spent()/remaining() reflect the
// tally. This is the root-cause fix: a completed leaf is tracked, never guillotined.
export const allocate = (soft: number, hard: number = Number.POSITIVE_INFINITY): Budget => {
  let used = 0
  let frozen: string | undefined
  // ONLY the hard ceiling (or an explicit freeze) throws — the soft ceiling never does.
  const guard = () => {
    if (frozen !== undefined) throw new BudgetExhaustedError(frozen, used, hard)
    if (used > hard) throw new BudgetExhaustedError("runaway", used, hard)
  }
  return {
    total: soft,
    hard,
    charge: (usage) => {
      used += tokensOf(usage)
      guard()
    },
    spent: async () => used,
    remaining: async () => Math.max(0, soft - used),
    overSoft: () => used > soft,
    freeze: (reason: string) => {
      frozen = reason
      guard()
    },
  }
}
