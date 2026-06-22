// Orchestration RECIPES — USERLAND, not core. Each is composed ONLY from the 5 core
// primitives (leaf, parallel, pipeline, emit, allocate) + the NodeEvent bus. None of
// these are reified into orch.ts: the engine stays exactly 5 prims. Promise-native,
// like the combinators they call; Effect stays at the session boundary.
import type { AxAIService, AxGen, AxGenIn, AxGenOut } from "@ax-llm/ax"
import { leaf, type LeafOpts, type NodeEvent, parallel } from "./orch.ts"

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
export type AgentNode<I extends AxGenIn, O extends AxGenOut> = {
  nodeId: string
  gen: AxGen<I, O>
  opts: LeafOpts
  onEvent?: EmitSink
  phase?: string
}
export const agent = async <I extends AxGenIn, O extends AxGenOut>(
  node: AgentNode<I, O>,
  ai: AxAIService,
  input: I,
): Promise<O> => {
  const { nodeId, gen, opts, onEvent = noopSink, phase = "agent" } = node
  onEvent({ type: "start", nodeId, phase })
  try {
    const result = await leaf(gen, opts)(ai, input)
    onEvent({ type: "done", nodeId, result })
    return result
  } catch (cause) {
    onEvent({ type: "error", nodeId, cause })
    throw cause
  }
}

// judge — N candidates → one leaf picks the best. The judge gen takes a structured
// `candidates` input and returns the chosen result (its O is the chosen-candidate shape).
// ponytail: skeleton recipe — exposed on the userland surface, not yet adopted by a
// caller in src/. Ceiling: unexercised path (only agent() is wired into turn() today).
// Upgrade: call from a best-of-N turn path in agent.ts and assert it in a test (orch-judge).
export const judge = async <C, I extends AxGenIn, O extends AxGenOut>(
  ai: AxAIService,
  candidates: ReadonlyArray<C>,
  judgeGen: AxGen<I, O>,
  judgeOpts: LeafOpts,
  toInput: (candidates: ReadonlyArray<C>) => I,
): Promise<O> => leaf(judgeGen, judgeOpts)(ai, toInput(candidates))

// loopUntilDry — run body repeatedly until isDry(prev,next) says it converged (or max
// hit). Returns the last (accumulated) value. Body owns its own accumulation.
// ponytail: skeleton recipe — userland surface, not yet adopted by a caller in src/.
// Ceiling: unexercised path. Upgrade: drive an iterative-refine turn from agent.ts and
// cover it with a test (orch-loop).
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
// ponytail: skeleton recipe — userland surface, not yet adopted by a caller in src/.
// Ceiling: unexercised path. Upgrade: wire a verify-before-accept turn in agent.ts and
// assert the vote tally in a test (orch-verify).
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
