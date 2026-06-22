// Orchestration RECIPES — USERLAND, not core. Each is composed ONLY from the 5 core
// primitives (leaf, parallel, pipeline, emit, allocate) + the NodeEvent bus. None of
// these are reified into orch.ts: the engine stays exactly 5 prims. Promise-native,
// like the combinators they call; Effect stays at the session boundary.
import type { AxAIService, AxGen, AxGenIn, AxGenOut } from "@ax-llm/ax"
import { type Budget, type BudgetUsage, leaf, type LeafOpts, type NodeEvent } from "./orch.ts"

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
// fixed pool of `n` workers each pulls the next unclaimed index until the queue drains,
// so order is preserved by writing into results[idx] (not by completion order).
export const parallelLimit = async <T>(
  thunks: ReadonlyArray<() => Promise<T>>,
  n = 8,
): Promise<Array<T | null>> => {
  const limit = Number.isFinite(n) ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(n))) : 8
  const results = new Array<T | null>(thunks.length).fill(null)
  // Shared cursor: each worker claims the next unclaimed index and advances it. A holder
  // object (not a bare `let next`) so the analyzer reads cursor.i on both the claim AND
  // the advance — a bare post-increment `next++` reads as a dead final write to it.
  const cursor = { i: 0 }
  const worker = async (): Promise<void> => {
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
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, () => worker()))
  return results
}

// A sink that records a NodeEvent. Promise-native recipes stay Effect-free: the
// SESSION BOUNDARY (turn() in agent.ts) supplies this, running the real emit()
// Effect.sync IN the active OTel span's context, so span.addEvent lands on the
// live chat.turn span (NOT a forked fiber that has lost the context). Default is
// a no-op so a recipe can run standalone (tests) without a boundary.
export type EmitSink = (event: NodeEvent) => void
const noopSink: EmitSink = () => {}

// agent — run one leaf as a lifecycle-bracketed node: start → done | error. The
// caller-supplied sink fires the lifecycle events; the recipe itself never
// touches Effect (it is pure Promise plumbing over leaf() + the 3 events).
// budget/usageOf are optional: when both are supplied, the recipe charges the
// budget from the forward result's usage (read off the gen via usageOf) AFTER the
// leaf returns — leaf()'s core (ai,input)=>Promise<O> signature is untouched. The
// budget is ADVISORY (soft): charge() NEVER discards a completed leaf for crossing the
// soft ceiling — it just flips overSoft(), which we surface as a delta nudge. Only a
// genuine runaway (the HARD ceiling) or an explicit freeze() throws BudgetExhaustedError.
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
export const agent = async <I extends AxGenIn, O extends AxGenOut>(
  node: AgentNode<I, O>,
  ai: AxAIService,
  input: I,
): Promise<O> => {
  const { nodeId, parentId, gen, opts, onEvent = noopSink, phase = "agent", budget, usageOf } = node
  onEvent({ type: "start", nodeId, parentId, phase })
  try {
    const result = await leaf(gen, opts)(ai, input)
    // ADVISORY charge: track this leaf's spend AFTER it returned its real work. charge()
    // never throws for the soft line, so the leaf result below is ALWAYS returned. When
    // spend crosses the soft ceiling we emit a delta nudge (visible in the tree/span) but
    // do NOT discard the leaf — a runaway is bounded by the hard ceiling + maxSteps.
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

// judge — N candidates → one leaf picks the best. The judge gen takes a structured
// `candidates` input and returns the chosen result (its O is the chosen-candidate shape).
// Adopted by orch-run.orchestrate() (the demo-wire best-of-N path).
export const judge = async <C, I extends AxGenIn, O extends AxGenOut>(
  ai: AxAIService,
  candidates: ReadonlyArray<C>,
  judgeGen: AxGen<I, O>,
  judgeOpts: LeafOpts,
  toInput: (candidates: ReadonlyArray<C>) => I,
): Promise<O> => leaf(judgeGen, judgeOpts)(ai, toInput(candidates))

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
