// Orchestration RECIPES — USERLAND, not core. Each is composed ONLY from the 5 core
// primitives (node, parallel, pipeline, emit, allocate) + the NodeEvent bus. None of
// these are reified into orch.ts: the engine stays exactly 5 prims. Promise-native,
// like the combinators they call; Effect stays at the session boundary.
//
// UNIFIED VOCABULARY: the orchestration unit is a NODE. runNode() runs ONE node (the
// core `node` prim) bracketed by its start→done|error lifecycle events. leaf/agent/
// worker/task/job/unit/runner are forbidden as names for the unit.
import type { AxAIService, AxGen, AxGenIn, AxGenOut } from "@ax-llm/ax"
import { type Budget, type BudgetUsage, node, type LeafOpts, type NodeEvent, pipeline } from "./orch.ts"

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
  opts: LeafOpts
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
  const { nodeId, parentId, gen, opts, onEvent = noopSink, phase = "node", budget, usageOf } = spec
  onEvent({ type: "start", nodeId, parentId, phase })
  try {
    const result = await node(gen, opts)(ai, input)
    // ADVISORY charge: track this node's spend AFTER it returned its real work. charge()
    // never throws for the soft line, so the node result below is ALWAYS returned. When
    // spend crosses the soft ceiling we emit a delta nudge (visible in the tree/span) but
    // do NOT discard the node — a runaway is bounded by the hard ceiling + maxSteps.
    if (budget !== undefined) {
      budget.charge(usageOf?.(gen))
      if (budget.overSoft()) onEvent({ type: "delta", nodeId, chunk: "⚠ over soft token budget (advisory — continuing)" })
    }
    onEvent({ type: "done", nodeId, result })
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
  judgeOpts: LeafOpts,
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

// structuredPipeline — FIRST-CLASS typed structured pipeline. Each stage is a node:
// a gen typed by its OWN signature (e.g. `text:string -> facts:json` then
// `facts:json -> summary:string`) plus its LeafOpts. The recipe threads the TYPED
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
  readonly opts: LeafOpts
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
      const out = await node(gen, opts)(ai, prev as AxGenIn)
      if (budget !== undefined) {
        budget.charge(usageOf?.(gen))
        if (budget.overSoft()) onEvent({ type: "delta", nodeId, chunk: "⚠ over soft token budget (advisory — continuing)" })
      }
      onEvent({ type: "done", nodeId, result: out })
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
