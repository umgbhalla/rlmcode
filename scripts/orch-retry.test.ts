#!/usr/bin/env bun
// Headless TRANSIENT-RESILIENCE test (ponytail: non-trivial logic leaves a check). Plain
// asserts, no framework — same assert-fixture style as orch-core.test / orch.test. NO LLM,
// NO network: fake nodes (a gen that throws a transient error N times then succeeds; one
// that hangs; one that throws a logic error) drive withRetry / withTimeout / resilientNode.
//
// Pins the three load-bearing invariants of the retry-timeout feature:
//   (1) RETRY recovers a transient (429/5xx/network/timeout) failure.
//   (2) TIMEOUT fires on a hang (a node that never resolves) → NodeTimeoutError, and the
//       fan-out maps it to a null slot (never stalls the whole fan-out).
//   (3) LOGIC errors (AxFunctionError / BudgetExhaustedError) are NOT retried (fail fast).
import { AxFunctionError, type AxAIService, type AxGen } from "@ax-llm/ax"
// Fast, deterministic backoff so the headless test runs in well under a second. These must
// be set BEFORE orch-recipes.ts is evaluated (it reads them at module-load), so we set them
// here and dynamic-import the recipes below — static imports would hoist above this.
process.env.RLM_NODE_BACKOFF_MS = "2"
process.env.RLM_NODE_RETRIES = "2"
const { NodeTimeoutError, parallelLimit, resilientNode, runNode, withRetry, withTimeout } = await import("../src/core/orch-recipes.ts")
type EmitSink = import("../src/core/orch-recipes.ts").EmitSink
const { BudgetExhaustedError } = await import("../src/core/orch.ts")
type NodeOpts = import("../src/core/orch.ts").NodeOpts
type NodeEvent = import("../src/core/orch.ts").NodeEvent

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

const fakeAi = {} as AxAIService

// A NodeOpts whose abortSignal is real (resilientNode forks a child off it). The other
// fields are inert under the fake forward(), so minimal stubs suffice.
const optsFor = (signal: AbortSignal = new AbortController().signal): NodeOpts =>
  ({ mem: {}, sessionId: "test", tracer: undefined, traceContext: undefined, maxSteps: 1, stream: false, abortSignal: signal }) as unknown as NodeOpts

const recorder = () => {
  const events: NodeEvent[] = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

// An ax-shaped transient error: a status error carrying a numeric HTTP status (429/5xx).
const statusErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
// An ax-shaped network error: matched by constructor/name (no status).
const networkErr = () => Object.assign(new Error("socket hang up"), { name: "AxAIServiceNetworkError" })

// A fake gen whose forward() throws `throws[callIndex]` (an Error to throw, or null to
// succeed with `reply`). Records its call count so the test can assert attempt counts.
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

await (async () => {
  // 1) withRetry RECOVERS a transient: throw 429 twice, then succeed. With the default 3
  //    attempts, the 3rd attempt returns. We use a fast backoff env so the test is quick
  //    (set below via the module default — backoff base is small enough; we keep delays
  //    tiny by relying on 250ms*2^i but only 2 retries → ~750ms total, acceptable headless).
  {
    const { gen, state } = scriptedGen([statusErr(429), statusErr(503), null], "recovered")
    let retries = 0
    const out = await resilientNode(gen, optsFor(), "n1", fakeAi, { message: "q" }, { onRetry: () => retries++ })
    assert(out.reply === "recovered", `resilientNode returns the recovered reply, got ${JSON.stringify(out)}`)
    assert(state.calls === 3, `resilientNode retried the transient: 3 forward calls, got ${state.calls}`)
    assert(retries === 2, `onRetry fired once per retry (2), got ${retries}`)
  }

  // 1b) a network error is also transient and recovered.
  {
    const { gen, state } = scriptedGen([networkErr(), null], "net-ok")
    const out = await resilientNode(gen, optsFor(), "n1b", fakeAi, { message: "q" })
    assert(out.reply === "net-ok", `network error retried + recovered, got ${JSON.stringify(out)}`)
    assert(state.calls === 2, `network transient retried once, got ${state.calls} calls`)
  }

  // 2) LOGIC errors are NOT retried — AxFunctionError throws on the FIRST failure.
  {
    const funcErr = new AxFunctionError([{ field: "x", message: "bad arg" }])
    const { gen, state } = scriptedGen([funcErr, null], "would-recover")
    let threw: unknown
    try {
      await resilientNode(gen, optsFor(), "n2", fakeAi, { message: "q" })
    } catch (e) {
      threw = e
    }
    assert(threw instanceof AxFunctionError, `AxFunctionError is rethrown, got ${threw}`)
    assert(state.calls === 1, `AxFunctionError is NOT retried (1 call), got ${state.calls}`)
  }

  // 2b) BudgetExhaustedError is NOT retried either.
  {
    const budgetErr = new BudgetExhaustedError("runaway", 100, 50)
    const { gen, state } = scriptedGen([budgetErr, null])
    let threw: unknown
    try {
      await resilientNode(gen, optsFor(), "n2b", fakeAi, { message: "q" })
    } catch (e) {
      threw = e
    }
    assert(threw instanceof BudgetExhaustedError, `BudgetExhaustedError is rethrown, got ${threw}`)
    assert(state.calls === 1, `BudgetExhaustedError is NOT retried (1 call), got ${state.calls}`)
  }

  // 3) TIMEOUT fires on a HANG: withTimeout races a never-resolving run against a short
  //    deadline → NodeTimeoutError, and the forked signal is ABORTED (so the hung work is
  //    cut loose, not left running). We use a tiny timeoutMs directly via withTimeout.
  {
    let nodeAborted = false
    let threw: unknown
    try {
      await withTimeout("hang", 50, new AbortController().signal, (signal) => {
        signal.addEventListener("abort", () => (nodeAborted = true))
        return new Promise<never>(() => {}) // never resolves — a hang.
      })
    } catch (e) {
      threw = e
    }
    assert(threw instanceof NodeTimeoutError, `a hang times out with NodeTimeoutError, got ${threw}`)
    assert(nodeAborted === true, "withTimeout aborts the forked node signal on timeout (cuts the hang loose)")
  }

  // 3b) a CANCELLED parent (turn) STILL aborts the node mid-run (cancel threads through).
  {
    const parent = new AbortController()
    let nodeAborted = false
    // DETERMINISTIC settling (no wall-clock): the run() never resolves and the deadline is 10s,
    // so the race promise won't settle on abort — the actual abort-propagation signal is the
    // FORKED signal's abort event firing. We resolve `aborted` from inside that listener and
    // await it, so the assertion runs exactly when the abort has threaded through (parent →
    // forked controller → forward's signal), not after a fixed sleep.
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
    assert(nodeAborted === true, "cancelling the parent (turn) signal aborts the in-flight node")
    void p // the race stays pending (10s deadline); we don't await it — the abort is what we test
  }

  // 4) a HANG in a FAN-OUT never stalls the whole fan-out: parallelLimit maps the timed-out
  //    node (which throws NodeTimeoutError) to a null slot, while sibling nodes still resolve.
  //    This is the "one hung node aborts + counts as a failure (null)" contract end-to-end.
  {
    const { sink } = recorder()
    const okOpts = optsFor()
    const hangGen = {
      forward: (_ai: unknown, _input: unknown, _o: unknown): Promise<{ reply: string }> => new Promise(() => {}),
      getUsage: () => [],
    } as unknown as AxGen<{ message: string }, { reply: string }>
    const { gen: fastGen } = scriptedGen([null], "fast")
    // The hang node uses a SHORT timeout via env-free direct resilientNode? resilientNode
    // uses LEAF_TIMEOUT_MS (large). To keep the test fast, race the hang via withTimeout
    // with a tiny deadline inside the thunk, mirroring what resilientNode does internally.
    const results = await parallelLimit<{ reply: string }>(
      [
        () => withTimeout("hang-node", 50, okOpts.abortSignal, (s) => hangGen.forward(fakeAi, { message: "q" }, { ...okOpts, abortSignal: s })),
        () => runNode({ nodeId: "ok-node", gen: fastGen, opts: okOpts, onEvent: sink }, fakeAi, { message: "q" }),
      ],
      2,
    )
    assert(results.length === 2, `fan-out keeps slot count, got ${results.length}`)
    assert(results[0] === null, "the hung node is a null slot (timed out, did not stall the fan-out)")
    assert(results[1]?.reply === "fast", `the sibling node still resolved, got ${JSON.stringify(results[1])}`)
  }

  // 5) withRetry GIVES UP after the max attempts on a persistent transient (always 429) and
  //    rethrows the last error — bounded, never infinite.
  {
    const { gen, state } = scriptedGen([statusErr(500), statusErr(500), statusErr(500), statusErr(500)])
    let threw: unknown
    try {
      await withRetry((i) => gen.forward(fakeAi, { message: "q" }, optsFor()).then(() => `try-${i}`), new AbortController().signal)
    } catch (e) {
      threw = e
    }
    assert(threw !== undefined, "withRetry rethrows after exhausting attempts on a persistent transient")
    assert(state.calls <= 5, `withRetry is bounded (<=5 attempts), made ${state.calls} calls`)
    assert(state.calls >= 2, `withRetry actually retried (>=2 calls), made ${state.calls}`)
  }
})()

if (failed > 0) {
  console.error(`orch-retry.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-retry.test: all pass ✓")
