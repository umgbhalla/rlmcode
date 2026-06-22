// Orchestration core: a faithful PORT of the Workflow engine onto @ax-llm/ax.
// EXACTLY 5 orthogonal primitives, nothing else is engine. Promise-native at this
// level — Effect stays at the session boundary (turn() in agent.ts) and in otel.ts,
// NOT inside the combinators. agent()/judge/loopUntilDry/workflow() are userland
// recipes (each <15 lines in these 5 prims), DELIBERATELY not reified here.
import { AxGen, type AxAIService, type AxGenIn, type AxGenOut, type AxProgramForwardOptions, type AxMemory } from "@ax-llm/ax"
import type { Context as OtelContext, Tracer } from "@opentelemetry/api"
import * as Effect from "effect/Effect"

// The real forward() opts bag threaded by turn() (agent.ts). This is a STRUCTURAL
// SUPERSET of AxProgramForwardOptions, NOT an alias: sessionId/tracer/traceContext
// are custom turn-level extensions that forward() tolerates today but does not
// declare. Keeping LeafOpts an honest description of the real bag — leaf() casts to
// Readonly<AxProgramForwardOptions<string>> at the forward() boundary (see leaf).
export type LeafOpts = {
  mem: AxMemory
  sessionId: string
  tracer: Tracer // @opentelemetry/api Tracer (same instance turn() builds)
  traceContext: OtelContext // @opentelemetry/api Context
  maxSteps: number
  stream: boolean
  abortSignal: AbortSignal
}

// A node lifecycle event over the EXISTING activity bus + OTel span annotation —
// do NOT invent a second event system. Consumed by emit() (a thin hook).
export type NodeEvent =
  | { readonly type: "start"; readonly nodeId: string; readonly parentId?: string; readonly phase: string }
  | { readonly type: "delta"; readonly nodeId: string; readonly chunk: string }
  | { readonly type: "done"; readonly nodeId: string; readonly result: unknown }
  | { readonly type: "error"; readonly nodeId: string; readonly cause: unknown }

export type EmitOpts = { readonly spanId?: string }

// Token gate. Reads usage via the existing usage reader in agent.ts (once wired).
export type Budget = {
  readonly total: number
  spent(): Promise<number>
  remaining(): Promise<number>
  freeze(reason: string): void
}

// 1. leaf — the ONLY thing that calls ax. Curried so opts bind once, then (ai,input)
// runs the forward. opts is cast to Readonly<AxProgramForwardOptions> at the boundary:
// LeafOpts is a known structural superset (carries sessionId/tracer/traceContext that
// AxProgramForwardOptions omits); the <string> arg matches forward()'s model-key param.
// This is sound — not `any`, no ponytail needed.
export const leaf =
  <I extends AxGenIn, O extends AxGenOut>(gen: AxGen<I, O>, opts: LeafOpts) =>
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

// 4. emit — STUB. Thin hook over the existing activity bus + OTel span annotation.
// ponytail: no-op skeleton; the NodeEvent never reaches the bus or a span yet.
// Ceiling: orchestration nodes are invisible in the TUI/traces. Upgrade: wire to
// emitActivity + span annotation (emit-wire).
export const emit = (_event: NodeEvent, _opts?: EmitOpts): Effect.Effect<void> => Effect.void

// 5. allocate — STUB. Token gate. spent/remaining resolve to 0/total, freeze is a no-op.
// ponytail: advisory-only skeleton; no real usage read, no enforcement.
// Ceiling: a run can blow past `total` with no signal. Upgrade: read real usage via
// readUsage + typed BudgetExhaustedError (budget-enforce).
export const allocate = (total: number): Budget => ({
  total,
  spent: async () => 0,
  remaining: async () => total,
  freeze: (_reason: string) => {},
})
