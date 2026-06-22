// Orchestration core: a faithful PORT of the Workflow engine onto @ax-llm/ax.
// EXACTLY 5 orthogonal primitives, nothing else is engine. Promise-native at this
// level — Effect stays at the session boundary (turn() in agent.ts) and in otel.ts,
// NOT inside the combinators. agent()/judge/loopUntilDry/workflow() are userland
// recipes (each <15 lines in these 5 prims), DELIBERATELY not reified here.
import { AxGen, type AxAIService, type AxGenIn, type AxGenOut, type AxProgramForwardOptions, type AxMemory } from "@ax-llm/ax"
import { type Context as OtelContext, type Tracer, trace as otelTrace } from "@opentelemetry/api"
import * as Effect from "effect/Effect"
import { emitActivity, type Activity } from "./activity.ts"

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

// The usage reader shape from agent.ts (readUsage/sumUsage): a leaf's token usage
// as a structural triple. charge() derives a token count from this (totalTokens, or
// promptTokens+completionTokens as a fallback) and adds it to the internal tally.
export type BudgetUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number }

// Token gate. Holds an internal used-token tally; charge() adds a leaf's usage after
// it returns, spent()/remaining() reflect the tally, freeze()/over-budget throw.
export type Budget = {
  readonly total: number
  charge(usage: BudgetUsage | undefined): void
  spent(): Promise<number>
  remaining(): Promise<number>
  freeze(reason: string): void
}

// Typed, throwable budget breach: emitted by freeze() and by charge() when the
// tally crosses `total`. Carries the reason and the spent/total numbers so a
// boundary catch can annotate a span or surface a nudge.
export class BudgetExhaustedError extends Error {
  readonly _tag = "BudgetExhaustedError"
  constructor(
    readonly reason: string,
    readonly spent: number,
    readonly total: number,
  ) {
    super(`budget exhausted (${reason}): spent ${spent} of ${total} tokens`)
    this.name = "BudgetExhaustedError"
  }
}

// Derive a token count from a usage triple: prefer totalTokens, else sum the parts.
const tokensOf = (u: BudgetUsage | undefined): number =>
  u === undefined ? 0 : typeof u.totalTokens === "number" ? u.totalTokens : (u.promptTokens ?? 0) + (u.completionTokens ?? 0)

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

// 4. emit — thin hook over the existing activity bus + the active OTel span. Maps
// each NodeEvent variant to an Activity (pushed via emitActivity) AND annotates the
// span in scope (addEvent + attributes). Stays Effect<void>: the session boundary
// (turn() in agent.ts) runs it; the body is sync (bus push + span annotate).
export const emit = (event: NodeEvent, _opts?: EmitOpts): Effect.Effect<void> =>
  Effect.sync(() => {
    // 1) activity bus — orchestration node lifecycle row (atoms sink handles it).
    // parentId travels on EVERY node Activity (not just start). delta/done/error
    // NodeEvents don't carry it, so it's undefined there — atoms preserves the
    // already-known parentId on update, so a child resolving before its parent's
    // start event never loses its edge.
    const activity: Activity =
      event.type === "delta"
        ? { kind: "node", nodeId: event.nodeId, event: "delta", parentId: undefined, detail: event.chunk }
        : event.type === "done"
          ? { kind: "node", nodeId: event.nodeId, event: "done", parentId: undefined, detail: clip(event.result) }
          : event.type === "error"
            ? { kind: "node", nodeId: event.nodeId, event: "error", parentId: undefined, detail: clip(event.cause) }
            : { kind: "node", nodeId: event.nodeId, event: "start", parentId: event.parentId, detail: event.phase }
    emitActivity(activity)

    // 2) active OTel span — addEvent + structured attributes. getActiveSpan() returns
    // a non-recording no-op span when there is none, so this is always safe.
    const span = otelTrace.getActiveSpan()
    if (span !== undefined) {
      span.addEvent(`orch.node.${event.type}`, {
        "orch.node.id": event.nodeId,
        ...(event.type === "start" ? { "orch.node.parent_id": event.parentId ?? "", "orch.node.phase": event.phase } : {}),
        ...(event.type === "delta" ? { "orch.node.chunk": event.chunk } : {}),
        ...(event.type === "done" ? { "orch.node.result": clip(event.result) } : {}),
        ...(event.type === "error" ? { "orch.node.cause": clip(event.cause) } : {}),
      })
    }
  })

// Stringify an unknown payload for a span attribute / activity detail, bounded.
const clip = (v: unknown, max = 256): string => {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } })()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// 5. allocate — token gate over a real internal tally. charge() folds a leaf's usage
// (the readUsage/sumUsage triple) into `used`; the moment `used` crosses `total` it
// throws BudgetExhaustedError, as does freeze(). spent()/remaining() reflect the tally.
export const allocate = (total: number): Budget => {
  let used = 0
  let frozen: string | undefined
  const guard = () => {
    if (frozen !== undefined) throw new BudgetExhaustedError(frozen, used, total)
    if (used > total) throw new BudgetExhaustedError("over-budget", used, total)
  }
  return {
    total,
    charge: (usage) => {
      used += tokensOf(usage)
      guard()
    },
    spent: async () => used,
    remaining: async () => Math.max(0, total - used),
    freeze: (reason: string) => {
      frozen = reason
      guard()
    },
  }
}
