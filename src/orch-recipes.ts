// Orchestration RECIPES — USERLAND, not core. Each is composed ONLY from the 5 core
// primitives (leaf, parallel, pipeline, emit, allocate) + the NodeEvent bus. None of
// these are reified into orch.ts: the engine stays exactly 5 prims. Promise-native,
// like the combinators they call; Effect stays at the session boundary.
import type { AxAIService, AxGen, AxGenIn, AxGenOut } from "@ax-llm/ax"
import * as Effect from "effect/Effect"
import { emit, leaf, type LeafOpts, parallel } from "./orch.ts"

// agent — run one leaf as a lifecycle-bracketed node: start → done | error.
// emit() returns Effect<void>; we runFork it (fire-and-forget) since recipes are
// Promise-native and the bus push / span annotate inside emit is synchronous.
export const agent = async <I extends AxGenIn, O extends AxGenOut>(
  nodeId: string,
  gen: AxGen<I, O>,
  opts: LeafOpts,
  ai: AxAIService,
  input: I,
  phase = "agent",
): Promise<O> => {
  Effect.runFork(emit({ type: "start", nodeId, phase }))
  try {
    const result = await leaf(gen, opts)(ai, input)
    Effect.runFork(emit({ type: "done", nodeId, result }))
    return result
  } catch (cause) {
    Effect.runFork(emit({ type: "error", nodeId, cause }))
    throw cause
  }
}

// judge — N candidates → one leaf picks the best. The judge gen takes a structured
// `candidates` input and returns the chosen result (its O is the chosen-candidate shape).
export const judge = async <C, I extends AxGenIn, O extends AxGenOut>(
  ai: AxAIService,
  candidates: ReadonlyArray<C>,
  judgeGen: AxGen<I, O>,
  judgeOpts: LeafOpts,
  toInput: (candidates: ReadonlyArray<C>) => I,
): Promise<O> => leaf(judgeGen, judgeOpts)(ai, toInput(candidates))

// loopUntilDry — run body repeatedly until isDry(prev,next) says it converged (or max
// hit). Returns the last (accumulated) value. Body owns its own accumulation.
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

// adversarialVerify — produce once, then fan the skeptics out via parallel() (failed
// skeptic → null, dropped), and let `accept` tally the boolean votes.
export const adversarialVerify = async <T>(
  produce: () => Promise<T>,
  skeptics: ReadonlyArray<(x: T) => Promise<boolean>>,
  accept: (votes: ReadonlyArray<boolean>) => boolean = (votes) =>
    votes.length > 0 && votes.filter(Boolean).length * 2 > votes.length,
): Promise<{ value: T; accepted: boolean; votes: ReadonlyArray<boolean> }> => {
  const value = await produce()
  const raw = await parallel(skeptics.map((s) => () => s(value)))
  const votes = raw.filter((v): v is boolean => v !== null)
  return { value, accepted: accept(votes), votes }
}
