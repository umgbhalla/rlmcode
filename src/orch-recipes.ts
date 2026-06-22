// Orchestration RECIPES — USERLAND, not core. Each is composed ONLY from the 5 core
// primitives (node, parallel, pipeline, emit, allocate) + the NodeEvent bus. None of
// these are reified into orch.ts: the engine stays exactly 5 prims. Promise-native,
// like the combinators they call; Effect stays at the session boundary.
//
// UNIFIED VOCABULARY: the orchestration unit is a NODE. runNode() runs ONE node (the
// core `node` prim) bracketed by its start→done|error lifecycle events. leaf/agent/
// worker/task/job/unit/runner are forbidden as names for the unit.
import type { AxAIService, AxGen, AxGenIn, AxGenOut, AxStepHooks } from "@ax-llm/ax"
import { makeNodeLogger } from "./activity.ts"
import { type Budget, type BudgetUsage, node, type NodeOpts, type NodeEvent, pipeline, tokensOf } from "./orch.ts"
import { resilientNode } from "./orch-resilience.ts"
// Re-export the resilience surface so callers/tests keep a single recipe import site.
export { LEAF_TIMEOUT_MS, NodeTimeoutError, resilientNode, withRetry, withTimeout } from "./orch-resilience.ts"

// Hard upper bound on in-flight thunks for parallelLimit — the absolute concurrency
// ceiling regardless of what a caller (or the model) asks for. A big fan-out (e.g. 100
// nodes) must NEVER hit CF-Kimi all at once; parallelLimit caps simultaneous forwards
// at <= n <= MAX_CONCURRENCY and QUEUES the rest. Pairs with the service-level
// AxRateLimiterFunction (runtime.ts) as the second throttle layer.
export const MAX_CONCURRENCY = 100

// parallelLimit — BOUNDED fan-out: run at most `n` thunks concurrently, QUEUE the rest,
// return results in INPUT ORDER (results[i] is thunks[i]'s outcome), and map a failed
// slot to null — the SAME contract as the core `parallel` prim, just bounded. NOT a 6th
// core primitive (orch.ts stays exactly 5): a userland helper over Promise plumbing. `n`
// is clamped to 1..MAX_CONCURRENCY (a non-finite/<=0 n falls back to the default 8). A
// fixed pool of `n` pumps each pulls the next unclaimed index until the queue drains,
// so order is preserved by writing into results[idx] (not by completion order).
export const parallelLimit = async <T>(
  thunks: ReadonlyArray<() => Promise<T>>,
  n = 8,
): Promise<Array<T | null>> => {
  const limit = Number.isFinite(n) ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(n))) : 8
  const results = new Array<T | null>(thunks.length).fill(null)
  // Shared cursor: each pump claims the next unclaimed index and advances it. A holder
  // object (not a bare `let next`) so the analyzer reads cursor.i on both the claim AND
  // the advance — a bare post-increment `next++` reads as a dead final write to it.
  const cursor = { i: 0 }
  // A fixed pool of `limit` PUMPS (Promise-plumbing consumers, NOT orchestration nodes —
  // they only pull thunk indices). Each pumps the queue until it drains.
  const pump = async (): Promise<void> => {
    for (;;) {
      const idx = cursor.i
      cursor.i = idx + 1
      if (idx >= thunks.length) return
      try {
        results[idx] = await thunks[idx]!()
      } catch {
        results[idx] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, () => pump()))
  return results
}


// A sink that records a NodeEvent. Promise-native recipes stay Effect-free: the
// SESSION BOUNDARY (turn() in agent.ts) supplies this, running the real emit()
// Effect.sync IN the active OTel span's context, so span.addEvent lands on the
// live chat.turn span (NOT a forked fiber that has lost the context). Default is
// a no-op so a recipe can run standalone (tests) without a boundary.
export type EmitSink = (event: NodeEvent) => void
const noopSink: EmitSink = () => {}

// PER-NODE TOOL ROUTING: bind a node's forward to a logger tagged with its id, so the tools
// it loops (bash/read/grep) emit tool/result activities carrying that nodeId — the atoms
// reducer then attaches them to THIS node's OrchTree node, not the main transcript. The
// single chokepoint: every TOOL-looping node runs through runNode()/structuredPipeline, both
// of which call this before the forward. `debug:true` is set per-call so ax INVOKES the logger
// even when the AI service has no service-level debug (forward opts win over service options).
// A caller that already supplied a logger keeps it (never clobber an explicit override).
const withNodeLogger = (opts: NodeOpts, nodeId: string): NodeOpts =>
  opts.logger !== undefined ? opts : { ...opts, logger: makeNodeLogger(nodeId), debug: true }

// GRACEFUL MAX-STEPS — a CEILING, not a cliff (claude_code model). ax runs the tool-calling
// loop internally; when it would exceed maxSteps it otherwise throws "max steps reached" (a
// brittle string the old code had to regex-match + recover from with a SEPARATE no-tools gen).
// Instead we hook the loop: ax's stepHooks.beforeStep(ctx) fires at the START of every step with
// ctx.stepIndex / ctx.maxSteps and ctx.removeFunctions(...names). On the LAST permitted step we
// strip ALL tools, so ax sends the final request with NO functions (tool_choice effectively
// 'none') — the model is FORCED to produce a final TEXT reply from the tool results already in
// mem, IN-LOOP, with NO throw and NO separate recovery gen. The session AxMemory persists, so a
// follow-up turn resumes; we emit a small marker (delta) so the UI knows the turn was
// TRUNCATED-then-finalized, not finished.
//
// `toolNames` are the gen's registered function names (BASE_TOOLS [+ ORCH_TOOLS + RLM_TOOLS] for
// the main turn; BASE_TOOLS for a node). onEvent + nodeId let the marker render on the live node.
// Real ax types end-to-end (AxStepHooks / AxStepContext.removeFunctions) — no `any`.
//
// The in-loop finalize is clean when the model has done >=1 real tool step before the cap (the
// realistic case: AX2_MAX_STEPS default 50, verified clean at low caps >=2). At the DEGENERATE cap
// maxSteps=1 (first step is also the last, ZERO prior tool work) kimi, primed by a tool-heavy
// system prompt, can emit raw `<|tool_call_begin|>` sentinel tokens as text instead of prose — a
// non-empty but garbage reply. That degenerate shape is now CAUGHT and coerced: runNode() (below)
// detects the raw-tool-token reply (looksLikeRawToolTokens) and runs ONE no-tools nudge forward
// (functionCall:'none') on the SAME mem to force clean prose — the old answerGen recovery, kept as a
// rare last-resort cleaner rather than the primary path. So both cap>=2 (clean finalize) and cap=1
// (clean after the nudge) yield usable prose, never raw sentinels.
// onTruncate (optional) fires ONCE when the cap is hit and tools are stripped — the caller
// (turn() in agent.ts) flips a flag so the turn can be annotated/marked as truncated-finalized.
export const finalizeOnMaxSteps = (
  toolNames: ReadonlyArray<string>,
  onEvent: EmitSink = noopSink,
  nodeId = "turn",
  onTruncate: () => void = () => {},
): AxStepHooks => {
  let fired = false
  return {
    beforeStep: (ctx) => {
      // The loop runs steps 0..maxSteps-1; the LAST permitted step is maxSteps-1. Strip tools
      // there so this step's model call cannot ask for another tool and MUST answer. Guard for
      // maxSteps<=1 (strip on step 0). Idempotent: removeFunctions on already-gone names is a no-op;
      // the `fired` latch keeps the marker + onTruncate to a single fire even if beforeStep re-runs.
      if (ctx.stepIndex >= ctx.maxSteps - 1 && toolNames.length > 0 && !fired) {
        fired = true
        ctx.removeFunctions(...toolNames)
        onTruncate()
        onEvent({
          type: "delta",
          nodeId,
          chunk: "⚠ max steps reached — finalizing (tools disabled; continue in a new message)",
        })
      }
    },
  }
}

// kimi (the CF model) sometimes emits its RAW tool-call wire tokens as plain TEXT instead of
// prose — the `<|tool_call(s)_section_begin|>` / `<|tool_call_begin|>` sentinels. This is the
// DEGENERATE graceful-finalize case (orch-recipes.ts:77 ponytail): when tools are stripped on a
// node's FIRST=LAST step (maxSteps<=1, ZERO prior tool work), kimi — primed by a tool-heavy
// system prompt — answers with these sentinel tokens, a non-empty but garbage reply. Detect it so
// the finalize cleaner can coerce real prose. A plain regex over the known kimi sentinels — no `any`.
const looksLikeRawToolTokens = (s: string): boolean => /<\|tool_calls?(_section)?_begin\|>|<\|tool_call_begin\|>/i.test(s)

// extract the reply field off a forward result (string-shaped node O) for the sentinel check —
// every node gen here is `… -> reply:string`, so the reply field is the user-facing text.
const replyOf = (o: unknown): string => String((o as { reply?: unknown })?.reply ?? "")

// runNode — run ONE node (the core `node` prim) as a lifecycle-bracketed unit:
// start → done | error. The caller-supplied sink fires the lifecycle events; the recipe
// itself never touches Effect (it is pure Promise plumbing over node() + the 3 events).
// budget/usageOf are optional: when both are supplied, the recipe charges the budget from
// the forward result's usage (read off the gen via usageOf) AFTER the node returns —
// node()'s core (ai,input)=>Promise<O> signature is untouched. The budget is ADVISORY
// (soft): charge() NEVER discards a completed node for crossing the soft ceiling — it
// just flips overSoft(), which we surface as a delta nudge. Only a genuine runaway (the
// HARD ceiling) or an explicit freeze() throws BudgetExhaustedError. AgentNode is the
// node-spec shape (the unit is a node; the type name is retained for stability).
export type AgentNode<I extends AxGenIn, O extends AxGenOut> = {
  nodeId: string
  parentId?: string | undefined
  gen: AxGen<I, O>
  opts: NodeOpts
  onEvent?: EmitSink
  phase?: string
  budget?: Budget
  usageOf?: (gen: AxGen<I, O>) => BudgetUsage | undefined
}
export const runNode = async <I extends AxGenIn, O extends AxGenOut>(
  spec: AgentNode<I, O>,
  ai: AxAIService,
  input: I,
): Promise<O> => {
  const { nodeId, parentId, gen, onEvent = noopSink, phase = "node", budget, usageOf } = spec
  // PER-NODE TOOL ROUTING: tag this node's forward with a nodeId-bound logger so its tools
  // route under this node (not the main transcript). EXCEPTION: the MAIN turn (agent.ts) is
  // also run through runNode but its tools must stay in the transcript (untagged), served by
  // the service-level global logger — so it opts out. It is the ONLY node whose id starts with
  // `turn:`; every orchestration node has an `orch`/rootId-prefixed id, so this is unambiguous.
  const opts = nodeId.startsWith("turn:") ? spec.opts : withNodeLogger(spec.opts, nodeId)
  onEvent({ type: "start", nodeId, parentId, phase })
  try {
    // TRANSIENT RESILIENCE on the node path: per-node timeout (abort a hang) + retry-with-
    // backoff on transient (429/5xx/network/timeout) errors only — a logic error
    // (AxFunctionError/budget) fails fast. A retry emits a delta so the live tree shows it.
    let result = await resilientNode(gen, opts, nodeId, ai, input, (tryIndex, _err, delayMs) =>
      onEvent({ type: "delta", nodeId, chunk: `⟳ transient failure — retry ${tryIndex + 1} in ${delayMs}ms` }),
    )
    // GRACEFUL-FINALIZE CLEANER (orch-recipes.ts:77 Upgrade): if a stripped-tools finalize
    // returned kimi's RAW tool-call sentinel tokens as text (the degenerate maxSteps<=1 case),
    // run ONE no-tools nudge forward on the SAME mem (the tool results / prior context persist
    // in opts.mem) with functionCall:'none' so ax disables tool-calling and the model is FORCED
    // to answer in clean prose. A single, bounded, last-resort coercion — NOT the primary path
    // (the realistic cap>=2 already finalizes cleanly). Guarded: only fires on the sentinel shape.
    if (looksLikeRawToolTokens(replyOf(result))) {
      onEvent({ type: "delta", nodeId, chunk: "⚠ finalize emitted raw tool tokens — coercing a clean reply (no tools)" })
      const nudgeInput = {
        ...(input as Record<string, unknown>),
        message: "You already have the tool results in context. Answer the original request now in plain prose. Do NOT call any tools or emit tool-call syntax.",
      } as unknown as I
      const nudged = await node(gen, { ...opts, functionCall: "none", maxSteps: 1 })(ai, nudgeInput).catch(() => result)
      // Swap ONLY if the nudge produced clean prose. If the nudge ALSO emits raw tokens (a
      // deeper sentinel variant), we KEEP the original and do NOT loop — runNode nudges AT MOST
      // once. The caller (orchestrate in orch-run.ts / turn() in agent.ts) then owns the decision
      // to surface a partial or retry at a different cap; runNode never spins on a stuck model.
      if (!looksLikeRawToolTokens(replyOf(nudged))) result = nudged
    }
    // ADVISORY charge: track this node's spend AFTER it returned its real work. charge()
    // never throws for the soft line, so the node result below is ALWAYS returned. When
    // spend crosses the soft ceiling we emit a delta nudge (visible in the tree/span) but
    // do NOT discard the node — a runaway is bounded by the hard ceiling + maxSteps.
    // COST-METER: read this node's usage ONCE (the gen's getUsage() is CUMULATIVE over every
    // forward it ran — including the graceful-finalize nudge forward above — so a single late
    // read both charges the budget AND stamps the per-node token count, with the nudge's spend
    // already folded in; the old double-read called usageOf twice and let the nudge tokens slip).
    const usage = usageOf?.(gen)
    const nodeTokens = usageOf !== undefined ? tokensOf(usage) : undefined
    if (budget !== undefined) {
      budget.charge(usage)
      if (budget.overSoft()) onEvent({ type: "delta", nodeId, chunk: "⚠ over soft token budget (advisory — continuing)" })
    }
    onEvent({ type: "done", nodeId, result, tokens: nodeTokens })
    return result
  } catch (cause) {
    onEvent({ type: "error", nodeId, cause })
    throw cause
  }
}

// judge — N candidates → one node picks the best. The judge gen takes a structured
// `candidates` input and returns the chosen result (its O is the chosen-candidate shape).
// Adopted by orch-run.orchestrate() (the demo-wire best-of-N path).
export const judge = async <C, I extends AxGenIn, O extends AxGenOut>(
  ai: AxAIService,
  candidates: ReadonlyArray<C>,
  judgeGen: AxGen<I, O>,
  judgeOpts: NodeOpts,
  toInput: (candidates: ReadonlyArray<C>) => I,
): Promise<O> => node(judgeGen, judgeOpts)(ai, toInput(candidates))

// loopUntilDry — run body repeatedly until isDry(prev,next) says it converged (or max
// hit). Returns the last (accumulated) value. Body owns its own accumulation.
// Adopted by orch-run.orchestrate() (re-runs the candidate fan-out until the
// surviving-count converges).
export const loopUntilDry = async <T>(
  body: () => Promise<T>,
  isDry: (prev: T, next: T) => boolean,
  max = 8,
): Promise<T> => {
  let prev = await body()
  for (let i = 1; i < max; i++) {
    const next = await body()
    if (isDry(prev, next)) return next
    prev = next
  }
  return prev
}

// adversarialVerify — produce once, then fan the skeptics out via parallelLimit() (failed
// skeptic → null, dropped), and let `accept` tally the boolean votes.
// Adopted by orch-run.orchestrate() (skeptics vote on the judged answer).
export const adversarialVerify = async <T>(
  produce: () => Promise<T>,
  skeptics: ReadonlyArray<(x: T) => Promise<boolean>>,
  accept: (votes: ReadonlyArray<boolean>) => boolean = (votes) =>
    votes.length > 0 && votes.filter(Boolean).length * 2 > votes.length,
): Promise<{ value: T; accepted: boolean; votes: ReadonlyArray<boolean> }> => {
  const value = await produce()
  // Bounded skeptic fan-out: at most MAX_CONCURRENCY (here the skeptic count is small,
  // but using parallelLimit keeps every recipe fan-out site under the same cap as the
  // orchestrate tool). Same null-on-failure contract as the unbounded parallel.
  const raw = await parallelLimit(skeptics.map((s) => () => s(value)), skeptics.length)
  const votes = raw.filter((v): v is boolean => v !== null)
  return { value, accepted: accept(votes), votes }
}

// untilGate — VERIFIED-STEP loop part 1: run produce(), evaluate gate(result); if the
// gate fails, re-run produce() WITH the prior failure fed back (produce takes the prior
// result|undefined so it can self-correct), and repeat until the gate passes or `max`
// attempts are spent. Returns the LAST result + whether the gate ultimately passed, so a
// caller can surface a best-so-far on failure rather than throwing. The gate is a
// predicate or an async check (e.g. "tests pass" / "non-empty"); we await it either way.
// Pure Promise plumbing — composes NOTHING but produce()/gate() the caller supplies (the
// real node work lives inside produce). NOT a core prim. `max` clamps to >=1 (a single
// attempt always runs). prev starts undefined (no prior failure on the first attempt).
export const untilGate = async <T>(
  produce: (prevFailure: T | undefined) => Promise<T>,
  gate: (result: T) => boolean | Promise<boolean>,
  max = 4,
): Promise<{ result: T; passed: boolean }> => {
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 4
  let result = await produce(undefined)
  let passed = await gate(result)
  for (let i = 1; i < limit && !passed; i++) {
    // feed the FAILED result back so produce() can correct it on the retry.
    result = await produce(result)
    passed = await gate(result)
  }
  return { result, passed }
}

// verifyHarden — VERIFIED-STEP loop part 2: adversarialVerify(value, skeptics); while the
// verdict is NOT accepted and we are under `max` rounds, call fix(value, votes) to repair
// the value (the skeptics' votes inform the fix) and re-verify the repaired value. Returns
// the last value + its acceptance + the last votes. `accept` is threaded to
// adversarialVerify (default majority). Composes ONLY adversarialVerify (itself a recipe
// over parallelLimit) + the caller's fix() — no core prim added. `max` clamps to >=1 (one
// verify always runs; max=1 means verify-only, no fix round).
export const verifyHarden = async <T>(
  value: T,
  skeptics: ReadonlyArray<(x: T) => Promise<boolean>>,
  fix: (value: T, votes: ReadonlyArray<boolean>) => Promise<T>,
  max = 2,
  accept?: (votes: ReadonlyArray<boolean>) => boolean,
): Promise<{ value: T; accepted: boolean; votes: ReadonlyArray<boolean> }> => {
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 2
  let verdict = await adversarialVerify(async () => value, skeptics, accept)
  for (let i = 1; i < limit && !verdict.accepted; i++) {
    const repaired = await fix(verdict.value, verdict.votes)
    verdict = await adversarialVerify(async () => repaired, skeptics, accept)
  }
  return verdict
}

// verifiedStep — THE verified-step recipe: untilGate(produce, gate) to get a result that
// passes the cheap gate (tests/non-empty), THEN verifyHarden(result, skeptics, fix) to
// adversarially harden it. BUDGET-BOUNDED: before each expensive phase we check the SOFT
// budget (allocate()'s advisory ceiling) — once we are over soft we STOP looping and return
// the BEST-SO-FAR rather than spending more. This is the never-infinite guarantee: the loop
// counts in untilGate/verifyHarden are the hard caps; the budget is the soft early-out. The
// budget is ADVISORY (charging happens inside the nodes produce/skeptics/fix run); verifiedStep
// only READS overSoft() to decide whether to keep going. Composed ENTIRELY from untilGate +
// verifyHarden (which sit on adversarialVerify → parallelLimit) — NO 6th core prim.
export const verifiedStep = async <T>(spec: {
  produce: (prevFailure: T | undefined) => Promise<T>
  gate: (result: T) => boolean | Promise<boolean>
  skeptics: ReadonlyArray<(x: T) => Promise<boolean>>
  fix: (value: T, votes: ReadonlyArray<boolean>) => Promise<T>
  budget?: Budget
  gateMax?: number
  hardenMax?: number
  accept?: (votes: ReadonlyArray<boolean>) => boolean
}): Promise<{ value: T; passedGate: boolean; accepted: boolean; votes: ReadonlyArray<boolean>; stoppedOnBudget: boolean }> => {
  const { produce, gate, skeptics, fix, budget, gateMax = 4, hardenMax = 2, accept } = spec
  const overSoft = () => budget !== undefined && budget.overSoft()
  // Phase 1: gate loop (at least one produce always runs — the step must yield SOMETHING).
  const gated = await untilGate(produce, gate, gateMax)
  // Budget early-out BEFORE the expensive harden phase: if we are already over the soft
  // ceiling, return best-so-far (the gated result) WITHOUT spending skeptic/fix tokens.
  if (overSoft()) {
    return { value: gated.result, passedGate: gated.passed, accepted: false, votes: [], stoppedOnBudget: true }
  }
  // Phase 2: harden. If over soft AFTER the first verify, verifyHarden's own budget check
  // (the hardenMax cap) already bounds it; we additionally short-circuit the fix rounds by
  // passing hardenMax=1 when over soft so no further fix tokens are spent.
  const hardenRounds = overSoft() ? 1 : hardenMax
  const verdict = await verifyHarden(gated.result, skeptics, fix, hardenRounds, accept)
  return { value: verdict.value, passedGate: gated.passed, accepted: verdict.accepted, votes: verdict.votes, stoppedOnBudget: overSoft() }
}

// structuredPipeline — FIRST-CLASS typed structured pipeline. Each stage is a node:
// a gen typed by its OWN signature (e.g. `text:string -> facts:json` then
// `facts:json -> summary:string`) plus its NodeOpts. The recipe threads the TYPED
// output of stage k straight into stage k+1's input — no string flattening between
// stages, no intermediate collection. The KEY invariant: stage k's output object must
// match stage k+1's input field shape (the gen signatures encode this), so the chain
// is structured end-to-end. ax's forward() parses/validates/retries each stage's JSON
// against its signature, so a stage yields a real typed object, not a string blob.
//
// Built ENTIRELY from the existing prims: each stage wraps node(gen, opts) in a
// pipeline() stage fn, bracketed with start/done|error NodeEvents (so every stage
// renders as a node in the OrchTree) and ADVISORY-charged to the budget (same contract
// as runNode(): a completed stage is never discarded — only a HARD-ceiling runaway or
// freeze() throws). NOT a 6th core prim: orch.ts stays exactly 5 — this is a userland
// recipe over node + pipeline + emit + allocate. Unlike fan-out it is pure serial
// threading, so it needs NO concurrency cap.
//
// A stage's I/O is `any` at the boundary because pipeline() is heterogeneous (stage k's
// O is stage k+1's I, but the array's element type can't name that chain in TS without
// a variadic-tuple HKT). The signatures carry the real types; the runtime contract is
// enforced by ax's parse/retry. ponytail: stage I/O typed as AxGenIn/AxGenOut, not a
// statically-chained tuple. Upgrade: a variadic-tuple builder that proves O_k === I_{k+1}
// at compile time (e.g. a fluent `.then(gen)` chain that carries the running output type).
export type PipelineStage = {
  readonly gen: AxGen<AxGenIn, AxGenOut>
  readonly opts: NodeOpts
  readonly nodeId?: string
  readonly phase?: string
  readonly budget?: Budget
  readonly usageOf?: (gen: AxGen<AxGenIn, AxGenOut>) => BudgetUsage | undefined
}
export const structuredPipeline = async (
  stages: ReadonlyArray<PipelineStage>,
  ai: AxAIService,
  input: AxGenIn,
  onEvent: EmitSink = noopSink,
  rootId = "pipeline",
): Promise<AxGenOut> => {
  if (stages.length === 0) throw new Error("structuredPipeline needs at least one stage")
  // Each stage becomes a pipeline() stage fn: bracket the node, run it, charge the
  // (advisory) budget AFTER it returns its real typed work, and pass the typed object on.
  const stageFns = stages.map((stage, i) => async (prev: AxGenOut): Promise<AxGenOut> => {
    const { gen, opts, nodeId = `${rootId}/stage-${i}`, phase = `stage ${i + 1}`, budget, usageOf } = stage
    onEvent({ type: "start", nodeId, parentId: rootId, phase })
    try {
      // PER-NODE TOOL ROUTING: tag the stage's forward so any tools it loops route under this
      // stage's node (not the main transcript), same as runNode().
      const out = await node(gen, withNodeLogger(opts, nodeId))(ai, prev as AxGenIn)
      // COST-METER: stamp this stage's per-node tokens on its done event (same as runNode).
      let stageTokens: number | undefined
      if (usageOf !== undefined) stageTokens = tokensOf(usageOf(gen))
      if (budget !== undefined) {
        budget.charge(usageOf?.(gen))
        if (budget.overSoft()) onEvent({ type: "delta", nodeId, chunk: "⚠ over soft token budget (advisory — continuing)" })
      }
      onEvent({ type: "done", nodeId, result: out, tokens: stageTokens })
      return out
    } catch (cause) {
      onEvent({ type: "error", nodeId, cause })
      throw cause
    }
  })
  onEvent({ type: "start", nodeId: rootId, phase: "structuredPipeline" })
  try {
    // pipeline() threads the single input through every stage fn in order; we drain the
    // async-generator and keep the LAST yielded value — the final stage's typed output.
    let result: AxGenOut = input as AxGenOut
    for await (const v of pipeline([input as AxGenOut], ...stageFns)) result = v as AxGenOut
    onEvent({ type: "done", nodeId: rootId, result })
    return result
  } catch (cause) {
    onEvent({ type: "error", nodeId: rootId, cause })
    throw cause
  }
}
