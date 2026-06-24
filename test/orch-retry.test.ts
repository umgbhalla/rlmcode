// @effect/vitest port of scripts/orch-retry.test.ts — TRANSIENT-RESILIENCE. NO LLM, NO network:
// fake nodes (a gen that throws a transient N times then succeeds; one that hangs; one that
// throws a logic error) drive withRetry / withTimeout / resilientNode. Pins: (1) RETRY recovers
// a transient; (2) TIMEOUT fires on a hang → NodeTimeoutError + null slot; (3) LOGIC errors are
// NOT retried.
//
// These use REAL backoff/timeout timers, so the cases run under `it.live` (real runtime, NOT the
// TestClock that `it.effect` installs) to preserve exact timing behavior. Env knobs (read at
// orch-recipes module load) are set BEFORE the dynamic import below — a static import hoists
// above the assignment and would freeze the defaults.
import { AxFunctionError, type AxAIService, type AxGen } from "@ax-llm/ax"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

process.env.RLM_NODE_BACKOFF_MS = "2"
process.env.RLM_NODE_RETRIES = "2"

import type { EmitSink } from "../src/core/orch-recipes.ts"
import type { NodeEvent, NodeOpts } from "../src/core/orch.ts"
const { classifyTransient, NODE_ATTEMPTS, NodeTimeoutError, parallelLimit, resilientNode, runNode, withRetry, withTimeout } =
  await import("../src/core/orch-recipes.ts")
const { BudgetExhaustedError, retryStatus } = await import("../src/core/orch.ts")

const fakeAi = {} as AxAIService

const optsFor = (signal: AbortSignal = new AbortController().signal): NodeOpts =>
  ({ mem: {}, sessionId: "test", tracer: undefined, traceContext: undefined, maxSteps: 1, stream: false, abortSignal: signal }) as unknown as NodeOpts

const recorder = () => {
  const events: Array<NodeEvent> = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

const statusErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
const networkErr = () => Object.assign(new Error("socket hang up"), { name: "AxAIServiceNetworkError" })

const scriptedGen = (throws: ReadonlyArray<Error | null>, reply = "ok") => {
  const state = { calls: 0 }
  const gen = {
    forward: async (_ai: unknown, _input: unknown, _o: unknown): Promise<{ reply: string }> => {
      const err = throws[Math.min(state.calls, throws.length - 1)]
      state.calls++
      if (err) throw err
      return { reply }
    },
    getUsage: () => [],
  } as unknown as AxGen<{ message: string }, { reply: string }>
  return { gen, state }
}

it.live("withRetry recovers a transient (429 then 503 then success)", () =>
  Effect.promise(async () => {
    const { gen, state } = scriptedGen([statusErr(429), statusErr(503), null], "recovered")
    let retries = 0
    const out = await resilientNode(gen, optsFor(), "n1", fakeAi, { message: "q" }, { onRetry: () => retries++ })
    expect(out.reply, "resilientNode returns the recovered reply").toBe("recovered")
    expect(state.calls, "resilientNode retried the transient: 3 forward calls").toBe(3)
    expect(retries, "onRetry fired once per retry (2)").toBe(2)
  }),
)

it.live("a network error is transient and recovered", () =>
  Effect.promise(async () => {
    const { gen, state } = scriptedGen([networkErr(), null], "net-ok")
    const out = await resilientNode(gen, optsFor(), "n1b", fakeAi, { message: "q" })
    expect(out.reply, "network error retried + recovered").toBe("net-ok")
    expect(state.calls, "network transient retried once").toBe(2)
  }),
)

it.live("classifyTransient + retryStatus rate-limit wording", () =>
  Effect.sync(() => {
    expect(classifyTransient(statusErr(429)), "429 → rate_limited").toBe("rate_limited")
    expect(classifyTransient(statusErr(503)), "503 → transient").toBe("transient")
    expect(classifyTransient(networkErr()), "network → transient").toBe("transient")
    expect(retryStatus("rate_limited", 2, 3, 4000), "retryStatus 429 wording").toBe("⏳ rate-limited · retry 2/3 · 4s")
    expect(retryStatus("transient", 2, 3, 250), "retryStatus transient sub-second rounds to 1s").toBe("⏳ retrying 2/3 · 1s")
  }),
)

it.live("runNode emits a structured retry NodeEvent DURING a 429-then-recover, before done", () =>
  Effect.promise(async () => {
    const { events, sink } = recorder()
    const { gen } = scriptedGen([statusErr(429), null], "rl-ok")
    const out = await runNode({ nodeId: "rl-node", gen, opts: optsFor(), onEvent: sink }, fakeAi, { message: "q" })
    expect(out.reply, "runNode recovers the 429").toBe("rl-ok")
    const retry = events.find((e): e is Extract<NodeEvent, { type: "retry" }> => e.type === "retry")
    expect(retry, "runNode emitted a `retry` NodeEvent during the 429 backoff").toBeDefined()
    expect(retry?.cause, "the retry event names the 429 cause (rate_limited)").toBe("rate_limited")
    expect(retry?.attempt === 2 && retry?.max === NODE_ATTEMPTS, `the retry event carries attempt 2/${NODE_ATTEMPTS}`).toBe(true)
    const iRetry = events.findIndex((e) => e.type === "retry")
    const iDone = events.findIndex((e) => e.type === "done")
    expect(iRetry >= 0 && iDone >= 0 && iRetry < iDone, "the retry signal precedes the node's done").toBe(true)
  }),
)

it.live("LOGIC errors are NOT retried — AxFunctionError throws on the FIRST failure", () =>
  Effect.promise(async () => {
    const funcErr = new AxFunctionError([{ field: "x", message: "bad arg" }])
    const { gen, state } = scriptedGen([funcErr, null], "would-recover")
    let threw: unknown
    try {
      await resilientNode(gen, optsFor(), "n2", fakeAi, { message: "q" })
    } catch (e) {
      threw = e
    }
    expect(threw instanceof AxFunctionError, "AxFunctionError is rethrown").toBe(true)
    expect(state.calls, "AxFunctionError is NOT retried (1 call)").toBe(1)
  }),
)

it.live("BudgetExhaustedError is NOT retried", () =>
  Effect.promise(async () => {
    const budgetErr = new BudgetExhaustedError("runaway", 100, 50)
    const { gen, state } = scriptedGen([budgetErr, null])
    let threw: unknown
    try {
      await resilientNode(gen, optsFor(), "n2b", fakeAi, { message: "q" })
    } catch (e) {
      threw = e
    }
    expect(threw instanceof BudgetExhaustedError, "BudgetExhaustedError is rethrown").toBe(true)
    expect(state.calls, "BudgetExhaustedError is NOT retried (1 call)").toBe(1)
  }),
)

it.live("TIMEOUT fires on a HANG → NodeTimeoutError, and the forked signal is ABORTED", () =>
  Effect.promise(async () => {
    let nodeAborted = false
    let threw: unknown
    try {
      await withTimeout("hang", 50, new AbortController().signal, (signal) => {
        signal.addEventListener("abort", () => (nodeAborted = true))
        return new Promise<never>(() => {})
      })
    } catch (e) {
      threw = e
    }
    expect(threw instanceof NodeTimeoutError, "a hang times out with NodeTimeoutError").toBe(true)
    expect(nodeAborted, "withTimeout aborts the forked node signal on timeout").toBe(true)
  }),
)

it.live("a CANCELLED parent (turn) STILL aborts the node mid-run", () =>
  Effect.promise(async () => {
    const parent = new AbortController()
    let nodeAborted = false
    let signalAborted!: () => void
    const aborted = new Promise<void>((r) => (signalAborted = r))
    const p = withTimeout("cancel", 10_000, parent.signal, (signal) => {
      signal.addEventListener("abort", () => {
        nodeAborted = true
        signalAborted()
      })
      return new Promise<never>(() => {})
    }).catch(() => "caught")
    parent.abort()
    await aborted
    expect(nodeAborted, "cancelling the parent (turn) signal aborts the in-flight node").toBe(true)
    void p
  }),
)

it.live("a HANG in a FAN-OUT never stalls the whole fan-out (null slot, sibling resolves)", () =>
  Effect.promise(async () => {
    const { sink } = recorder()
    const okOpts = optsFor()
    const hangGen = {
      forward: (_ai: unknown, _input: unknown, _o: unknown): Promise<{ reply: string }> => new Promise(() => {}),
      getUsage: () => [],
    } as unknown as AxGen<{ message: string }, { reply: string }>
    const { gen: fastGen } = scriptedGen([null], "fast")
    const results = await parallelLimit<{ reply: string }>(
      [
        () => withTimeout("hang-node", 50, okOpts.abortSignal, (s) => hangGen.forward(fakeAi, { message: "q" }, { ...okOpts, abortSignal: s })),
        () => runNode({ nodeId: "ok-node", gen: fastGen, opts: okOpts, onEvent: sink }, fakeAi, { message: "q" }),
      ],
      2,
    )
    expect(results.length, "fan-out keeps slot count").toBe(2)
    expect(results[0], "the hung node is a null slot (timed out, did not stall the fan-out)").toBe(null)
    expect(results[1]?.reply, "the sibling node still resolved").toBe("fast")
  }),
)

it.live("withRetry GIVES UP after the max attempts on a persistent transient and rethrows", () =>
  Effect.promise(async () => {
    const { gen, state } = scriptedGen([statusErr(500), statusErr(500), statusErr(500), statusErr(500)])
    let threw: unknown
    try {
      await withRetry((i) => gen.forward(fakeAi, { message: "q" }, optsFor()).then(() => `try-${i}`), new AbortController().signal)
    } catch (e) {
      threw = e
    }
    expect(threw, "withRetry rethrows after exhausting attempts").toBeDefined()
    expect(state.calls, "withRetry is bounded (<=5 attempts)").toBeLessThanOrEqual(5)
    expect(state.calls, "withRetry actually retried (>=2 calls)").toBeGreaterThanOrEqual(2)
  }),
)
