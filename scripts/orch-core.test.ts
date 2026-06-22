#!/usr/bin/env bun
// Headless orch test (ponytail: non-trivial logic leaves a check). Plain asserts,
// no framework — same assert-fixture style as design-check.test / ponytail-debt.test.
//
// Drives the 5 CORE prims (node / parallel / pipeline / emit / allocate) + two
// recipes (runNode, adversarialVerify) with a FAKE AxGen — NO LLM, NO network — and
// asserts the NodeEvent stream and result shapes. This is the first exercise of the
// orchestration engine off-LLM: it pins the verify-before-accept flow's contract.
import type { AxAIService, AxGen } from "@ax-llm/ax"
import { adversarialVerify, type EmitSink, MAX_CONCURRENCY, parallelLimit, runNode } from "../src/orch-recipes.ts"
import { allocate, BudgetExhaustedError, type NodeOpts, type NodeEvent, parallel, pipeline } from "../src/orch.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

// A FAKE AxGen: node() only ever calls gen.forward(ai, input, opts), so a structural
// stub with forward() is a faithful stand-in. usageTokens lets a node charge a budget
// without a real getUsage() probe. Cast through unknown — the test owns this shape.
// ponytail: structural fake over the full AxGen surface. Upgrade: a typed test double
// implementing the real AxGen interface if the engine starts calling more methods.
const fakeGen = <O>(reply: O, opts: { fail?: boolean; usageTokens?: number } = {}) => {
  let lastUsage: { totalTokens: number } | undefined
  return {
    forward: async (_ai: unknown, _input: unknown, _o: unknown): Promise<O> => {
      if (opts.fail) throw new Error("fake node failure")
      if (opts.usageTokens !== undefined) lastUsage = { totalTokens: opts.usageTokens }
      return reply
    },
    getUsage: () => (lastUsage === undefined ? [] : [{ tokens: lastUsage }]),
  } as unknown as AxGen<any, O>
}
const fakeAi = {} as AxAIService

// A minimal NodeOpts — never used by the fake forward(), but the recipe API requires it.
const opts = {} as NodeOpts

// A recording sink: captures every NodeEvent so we can assert the lifecycle order.
const recorder = () => {
  const events: NodeEvent[] = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

await (async () => {
  // 1) node via the runNode() recipe — happy path: start → done, returns the reply.
  {
    const { events, sink } = recorder()
    const out = await runNode(
      { nodeId: "n1", gen: fakeGen({ reply: "hi" }), opts, onEvent: sink, phase: "answer" },
      fakeAi,
      { message: "q" },
    )
    assert(out.reply === "hi", `runNode reply, got ${JSON.stringify(out)}`)
    assert(events.length === 2, `runNode emits 2 events, got ${events.length}`)
    assert(events[0]?.type === "start" && events[0].nodeId === "n1", "runNode first event is start/n1")
    assert(events[1]?.type === "done", "runNode second event is done")
  }

  // 2) runNode() failure path: start → error, then rethrows.
  {
    const { events, sink } = recorder()
    let threw = false
    try {
      await runNode({ nodeId: "boom", gen: fakeGen({ reply: "x" }, { fail: true }), opts, onEvent: sink }, fakeAi, {})
    } catch {
      threw = true
    }
    assert(threw, "runNode rethrows node failure")
    assert(events[0]?.type === "start" && events[1]?.type === "error", "runNode emits start then error")
  }

  // 3) runNode() charges the budget from the node's usage after forward returns.
  {
    const { sink } = recorder()
    const budget = allocate(100)
    await runNode(
      { nodeId: "b", gen: fakeGen({ reply: "ok" }, { usageTokens: 30 }), opts, onEvent: sink, budget, usageOf: (g) => (g as { getUsage(): Array<{ tokens: { totalTokens: number } }> }).getUsage().at(-1)?.tokens },
      fakeAi,
      {},
    )
    assert((await budget.spent()) === 30, `budget charged 30, got ${await budget.spent()}`)
    assert((await budget.remaining()) === 70, `budget remaining 70, got ${await budget.remaining()}`)
  }

  // 3b) runNode() GRACEFUL-FINALIZE CLEANER (the degenerate maxSteps<=1 case): when the
  // first forward returns kimi's RAW tool-call SENTINEL tokens as text (not prose), runNode
  // runs ONE no-tools NUDGE forward on the SAME mem and swaps in the nudged reply ONLY if it
  // is clean. This unit-tests that path off-LLM (the live probe is AX2_LIVE-gated and cannot
  // run in CI). A scripted fake gen returns the sentinel on call 1 and clean prose on call 2,
  // and RECORDS the opts of each forward so we can assert the nudge ran with functionCall:'none'
  // + maxSteps:1 (the last-resort cleaner contract).
  {
    // SENTINEL → CLEAN: call 1 emits raw tool tokens, call 2 (the nudge) emits prose.
    const { events, sink } = recorder()
    const SENTINEL = "<|tool_calls_section_begin|><|tool_call_begin|>read_file"
    const calls: Array<{ input: unknown; opts: { functionCall?: unknown; maxSteps?: unknown } }> = []
    const scriptedGen = (replies: ReadonlyArray<string>) => {
      let i = 0
      return {
        forward: async (_ai: unknown, input: unknown, o: unknown): Promise<{ reply: string }> => {
          calls.push({ input, opts: (o ?? {}) as { functionCall?: unknown; maxSteps?: unknown } })
          return { reply: replies[Math.min(i++, replies.length - 1)]! }
        },
        getUsage: () => [],
      } as unknown as AxGen<any, { reply: string }>
    }
    const out = await runNode(
      { nodeId: "nudge", gen: scriptedGen([SENTINEL, "Here is the plain-prose answer."]), opts, onEvent: sink },
      fakeAi,
      { message: "q" },
    )
    assert(out.reply === "Here is the plain-prose answer.", `runNode swaps in the nudged clean reply, got ${JSON.stringify(out)}`)
    assert(calls.length === 2, `runNode runs exactly ONE nudge forward after a sentinel reply, got ${calls.length} forward(s)`)
    assert(calls[1]?.opts.functionCall === "none", "the nudge forward sets functionCall:'none' (tools disabled)")
    assert(calls[1]?.opts.maxSteps === 1, "the nudge forward caps maxSteps:1 (single last-resort coercion)")
    assert(
      (calls[1]?.input as { message?: string })?.message?.includes("plain prose") === true,
      `the nudge input carries the answer-now prose prompt, got ${JSON.stringify(calls[1]?.input)}`,
    )
    assert(events.some((e) => e.type === "delta" && /raw tool tokens/.test(e.chunk)), "runNode emits the coercion delta before nudging")

    // SENTINEL → SENTINEL: if the nudge ALSO emits raw tokens (a deeper sentinel variant),
    // runNode keeps the ORIGINAL result (never swaps in garbage). The calling code then owns
    // the decision to return a partial / retry at a different cap — runNode does NOT loop.
    // The nudge returns a DISTINCT sentinel variant so a buggy unconditional swap would be
    // caught (the original sentinel and the nudge sentinel differ): runNode must keep the
    // ORIGINAL, proving the swap is guarded on the nudge being clean — not merely non-empty.
    const NUDGE_SENTINEL = "<|tool_call_begin|>glob"
    const calls2: number = await (async () => {
      const { sink: sink2 } = recorder()
      let n = 0
      const alwaysSentinel = {
        forward: async (_ai: unknown, _input: unknown, _o: unknown): Promise<{ reply: string }> => {
          n++
          return { reply: n === 1 ? SENTINEL : NUDGE_SENTINEL }
        },
        getUsage: () => [],
      } as unknown as AxGen<any, { reply: string }>
      const r = await runNode({ nodeId: "stuck", gen: alwaysSentinel, opts, onEvent: sink2 }, fakeAi, { message: "q" })
      assert(r.reply === SENTINEL, `runNode keeps the ORIGINAL sentinel (not the nudge's) when the nudge ALSO emits raw tokens, got ${JSON.stringify(r)}`)
      return n
    })()
    assert(calls2 === 2, `runNode nudges AT MOST once then gives up (no loop), forward count ${calls2}`)
  }

  // 4) allocate() is ADVISORY (soft budget): crossing the SOFT ceiling NEVER throws — it
  // only flips overSoft() (a completed node is never discarded). Only crossing the HARD
  // ceiling, or an explicit freeze(), throws BudgetExhaustedError.
  {
    // soft=10 (no hard) → pure advisory: charge past soft does NOT throw, overSoft() flips.
    const soft = allocate(10)
    let threw = false
    try {
      soft.charge({ totalTokens: 11 })
    } catch {
      threw = true
    }
    assert(!threw, "crossing the SOFT ceiling does NOT throw (advisory)")
    assert(soft.overSoft() === true, "overSoft() is true once spend crosses the soft ceiling")
    assert((await soft.spent()) === 11, `spent reflects the tally past soft, got ${await soft.spent()}`)

    // soft=10, hard=20 → crossing soft nudges (no throw), crossing hard throws.
    const hard = allocate(10, 20)
    let softThrew = false
    try {
      hard.charge({ totalTokens: 15 })
    } catch {
      softThrew = true
    }
    assert(!softThrew && hard.overSoft(), "between soft and hard: no throw, overSoft() true")
    let tag: string | undefined
    try {
      hard.charge({ totalTokens: 10 }) // now 25 > hard 20
    } catch (e) {
      tag = (e as BudgetExhaustedError)._tag
    }
    assert(tag === "BudgetExhaustedError", `crossing the HARD ceiling throws BudgetExhaustedError, got ${tag}`)

    const f = allocate(10)
    let froze = false
    try {
      f.freeze("manual")
    } catch (e) {
      froze = e instanceof BudgetExhaustedError && (e as BudgetExhaustedError).reason === "manual"
    }
    assert(froze, "freeze() throws BudgetExhaustedError with the reason")
  }

  // 5) parallel(): failed slots resolve to null (never reject); survivors filter out.
  {
    const raw = await parallel<string>([
      () => Promise.resolve("a"),
      () => Promise.reject(new Error("x")),
      () => Promise.resolve("c"),
    ])
    assert(raw.length === 3, `parallel keeps slot count, got ${raw.length}`)
    assert(raw[1] === null, "parallel maps a rejected slot to null")
    assert(raw.filter((r): r is string => r !== null).join("") === "ac", "parallel survivors are a,c")
  }

  // 5b) parallelLimit(): BOUNDED fan-out — same null-on-failure contract as parallel,
  // but (a) preserves INPUT ORDER, (b) runs at most `n` thunks concurrently (the rest
  // QUEUE), (c) clamps n to 1..MAX_CONCURRENCY. We instrument every thunk with a shared
  // in-flight counter and assert the peak never exceeds n.
  {
    // ORDER + FAILURE→null: 6 thunks, the odd indices reject; results stay in input order.
    const orderRaw = await parallelLimit<number>(
      Array.from({ length: 6 }, (_, i) => () => (i % 2 === 1 ? Promise.reject(new Error("x")) : Promise.resolve(i))),
      3,
    )
    assert(orderRaw.length === 6, `parallelLimit keeps slot count, got ${orderRaw.length}`)
    assert(orderRaw.join(",") === "0,,2,,4,", `parallelLimit preserves input order + maps failures to null, got ${JSON.stringify(orderRaw)}`)

    // NEVER MORE THAN n IN FLIGHT: 20 thunks, limit 4 — a shared counter tracks concurrent
    // executions; the peak must be <= 4. Each thunk yields (await a macrotask) so the pool
    // is genuinely saturated before any completes.
    const N = 4
    let inFlight = 0
    let peak = 0
    const slow = (i: number) => async (): Promise<number> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return i
    }
    const res = await parallelLimit<number>(Array.from({ length: 20 }, (_, i) => slow(i)), N)
    assert(peak <= N, `parallelLimit never runs more than n=${N} in flight, peak was ${peak}`)
    assert(peak === N, `parallelLimit saturates the pool to n=${N} (peak ${peak}) — proves it QUEUES the rest`)
    assert(res.join(",") === Array.from({ length: 20 }, (_, i) => i).join(","), `parallelLimit returns all 20 in input order, got ${JSON.stringify(res)}`)

    // CLAMP: an out-of-range n is clamped to 1..MAX_CONCURRENCY. n=1000 → still serializes
    // at <= MAX_CONCURRENCY; n=0/NaN falls back to the default. We only assert it does not
    // exceed the input length and preserves order (the clamp itself is exercised by peak<=n).
    let highPeak = 0
    let highInFlight = 0
    const tracked = (i: number) => async (): Promise<number> => {
      highInFlight++
      highPeak = Math.max(highPeak, highInFlight)
      await new Promise((r) => setTimeout(r, 1))
      highInFlight--
      return i
    }
    const clamped = await parallelLimit<number>(Array.from({ length: 10 }, (_, i) => tracked(i)), 1000)
    assert(highPeak <= MAX_CONCURRENCY, `parallelLimit clamps n to <= MAX_CONCURRENCY (${MAX_CONCURRENCY}), peak ${highPeak}`)
    assert(highPeak <= 10, `with 10 thunks the peak is bounded by the thunk count, got ${highPeak}`)
    assert(clamped.join(",") === Array.from({ length: 10 }, (_, i) => i).join(","), "parallelLimit (clamped n) preserves order")

    // n<=0 / non-finite falls back to the default (>=1) and still completes every slot in order.
    const fallback = await parallelLimit<number>(Array.from({ length: 5 }, (_, i) => () => Promise.resolve(i)), 0)
    assert(fallback.join(",") === "0,1,2,3,4", `parallelLimit with n=0 falls back to a sane default, got ${JSON.stringify(fallback)}`)
  }

  // 6) pipeline(): each item flows stage→stage independently (no barrier), values map.
  {
    const out: number[] = []
    for await (const v of pipeline([1, 2, 3], async (x: number) => x * 2, async (x: number) => x + 1)) {
      out.push(v as number)
    }
    assert(out.join(",") === "3,5,7", `pipeline result, got ${out.join(",")}`)
  }

  // 7) adversarialVerify(): produce once, skeptics vote in parallel; majority accepts.
  // A failing skeptic drops out (parallel→null), so 2-of-2 'accept' over 3 still wins.
  {
    const fakeSkeptic =
      (vote: boolean | "throw") =>
      async (_answer: string): Promise<boolean> => {
        if (vote === "throw") throw new Error("skeptic crashed")
        return vote
      }
    const verdict = await adversarialVerify<string>(
      async () => "the answer",
      [fakeSkeptic(true), fakeSkeptic("throw"), fakeSkeptic(true)],
    )
    assert(verdict.value === "the answer", "adversarialVerify returns the produced value")
    assert(verdict.votes.length === 2, `crashed skeptic dropped, got ${verdict.votes.length} votes`)
    assert(verdict.accepted === true, "2 accept votes is a majority → accepted")
  }

  // 8) adversarialVerify(): a real verify-BEFORE-accept rejection — a tie is NOT a
  // majority, so the answer is rejected (the gate orch-run relies on to NOT accept).
  {
    const v = await adversarialVerify<string>(async () => "x", [
      async () => true,
      async () => false,
    ])
    assert(v.accepted === false, "tie (1 accept / 1 reject) is rejected, not accepted")
  }
})()

if (failed > 0) {
  console.error(`orch-core.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-core.test: all pass ✓")
