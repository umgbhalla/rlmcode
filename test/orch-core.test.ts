// @effect/vitest port of scripts/orch-core.test.ts — drives the 5 CORE prims (node /
// parallel / pipeline / emit / allocate) + two recipes (runNode, adversarialVerify) with a
// FAKE AxGen — NO LLM, NO network — and asserts the NodeEvent stream and result shapes.
// The hand-rolled `let failed=0`+assert() IIFE is now it.effect cases (Effect.promise wraps
// the Promise-returning prims; the assertions are vitest expect()). Equivalent coverage.
import type { AxAIService, AxGen } from "@ax-llm/ax"
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  adversarialVerify,
  type EmitSink,
  MAX_CONCURRENCY,
  parallelLimit,
  runNode,
} from "../src/core/orch-recipes.ts"
import { allocate, BudgetExhaustedError, type NodeEvent, type NodeOpts, parallel, pipeline } from "../src/core/orch.ts"

const makeFakeSkeptic =
  (vote: boolean | "throw") =>
  async (_answer: string): Promise<boolean> => {
    if (vote === "throw") throw new Error("skeptic crashed")
    return vote
  }

// A FAKE AxGen: node() only ever calls gen.forward(ai, input, opts), so a structural stub
// with forward() is a faithful stand-in. usageTokens lets a node charge a budget without a
// real getUsage() probe. Cast through unknown — the test owns this shape.
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
  const events: Array<NodeEvent> = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

it.effect("runNode happy path: start → done, returns the reply", () =>
  Effect.promise(async () => {
    const { events, sink } = recorder()
    const out = await runNode(
      { nodeId: "n1", gen: fakeGen({ reply: "hi" }), opts, onEvent: sink, phase: "answer" },
      fakeAi,
      { message: "q" },
    )
    expect(out.reply, `runNode reply, got ${JSON.stringify(out)}`).toBe("hi")
    expect(events.length, "runNode emits 2 events").toBe(2)
    expect(events[0]?.type === "start" && events[0].nodeId === "n1", "runNode first event is start/n1").toBe(true)
    expect(events[1]?.type, "runNode second event is done").toBe("done")
  }),
)

it.effect("runNode failure path: start → error, then rethrows", () =>
  Effect.promise(async () => {
    const { events, sink } = recorder()
    let threw = false
    try {
      await runNode({ nodeId: "boom", gen: fakeGen({ reply: "x" }, { fail: true }), opts, onEvent: sink }, fakeAi, {})
    } catch {
      threw = true
    }
    expect(threw, "runNode rethrows node failure").toBe(true)
    expect(events[0]?.type === "start" && events[1]?.type === "error", "runNode emits start then error").toBe(true)
  }),
)

it.effect("runNode charges the budget from the node's usage after forward returns", () =>
  Effect.promise(async () => {
    const { sink } = recorder()
    const budget = allocate(100)
    await runNode(
      {
        nodeId: "b",
        gen: fakeGen({ reply: "ok" }, { usageTokens: 30 }),
        opts,
        onEvent: sink,
        budget,
        usageOf: (g) => (g as { getUsage(): Array<{ tokens: { totalTokens: number } }> }).getUsage().at(-1)?.tokens,
      },
      fakeAi,
      {},
    )
    expect(await budget.spent(), "budget charged 30").toBe(30)
    expect(await budget.remaining(), "budget remaining 70").toBe(70)
  }),
)

it.effect("runNode graceful-finalize cleaner (maxSteps<=1): sentinel → clean swaps; sentinel → sentinel keeps original", () =>
  Effect.promise(async () => {
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
    expect(out.reply, "runNode swaps in the nudged clean reply").toBe("Here is the plain-prose answer.")
    expect(calls.length, "runNode runs exactly ONE nudge forward after a sentinel reply").toBe(2)
    expect(calls[1]?.opts.functionCall, "the nudge forward sets functionCall:'none'").toBe("none")
    expect(calls[1]?.opts.maxSteps, "the nudge forward caps maxSteps:1").toBe(1)
    expect((calls[1]?.input as { message?: string })?.message?.includes("plain prose"), "nudge input carries the answer-now prompt").toBe(true)
    expect(events.some((e) => e.type === "delta" && /raw tool tokens/.test(e.chunk)), "runNode emits the coercion delta before nudging").toBe(true)

    // SENTINEL → SENTINEL: the nudge ALSO emits raw tokens → runNode keeps the ORIGINAL.
    const NUDGE_SENTINEL = "<|tool_call_begin|>glob"
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
    expect(r.reply, "runNode keeps the ORIGINAL sentinel when the nudge ALSO emits raw tokens").toBe(SENTINEL)
    expect(n, "runNode nudges AT MOST once then gives up (no loop)").toBe(2)
  }),
)

it.effect("allocate() is ADVISORY: soft never throws, hard / freeze throws BudgetExhaustedError", () =>
  Effect.promise(async () => {
    // soft=10 (no hard) → pure advisory.
    const soft = allocate(10)
    let threw = false
    try {
      soft.charge({ totalTokens: 11 })
    } catch {
      threw = true
    }
    expect(threw, "crossing the SOFT ceiling does NOT throw (advisory)").toBe(false)
    expect(soft.overSoft(), "overSoft() is true once spend crosses the soft ceiling").toBe(true)
    expect(await soft.spent(), "spent reflects the tally past soft").toBe(11)

    // soft=10, hard=20 → crossing soft nudges (no throw), crossing hard throws.
    const hard = allocate(10, 20)
    let softThrew = false
    try {
      hard.charge({ totalTokens: 15 })
    } catch {
      softThrew = true
    }
    expect(!softThrew && hard.overSoft(), "between soft and hard: no throw, overSoft() true").toBe(true)
    let tag: string | undefined
    try {
      hard.charge({ totalTokens: 10 }) // now 25 > hard 20
    } catch (e) {
      tag = (e as BudgetExhaustedError)._tag
    }
    expect(tag, "crossing the HARD ceiling throws BudgetExhaustedError").toBe("BudgetExhaustedError")

    const f = allocate(10)
    let froze = false
    try {
      f.freeze("manual")
    } catch (e) {
      froze = e instanceof BudgetExhaustedError && (e as BudgetExhaustedError).reason === "manual"
    }
    expect(froze, "freeze() throws BudgetExhaustedError with the reason").toBe(true)
  }),
)

it.effect("parallel(): failed slots resolve to null (never reject); survivors filter out", () =>
  Effect.promise(async () => {
    const raw = await parallel<string>([
      () => Promise.resolve("a"),
      () => Promise.reject(new Error("x")),
      () => Promise.resolve("c"),
    ])
    expect(raw.length, "parallel keeps slot count").toBe(3)
    expect(raw[1], "parallel maps a rejected slot to null").toBe(null)
    expect(raw.filter((r): r is string => r !== null).join(""), "parallel survivors are a,c").toBe("ac")
  }),
)

it.effect("parallelLimit(): order preserved, failures→null, peak bounded by n, clamped to MAX_CONCURRENCY", () =>
  Effect.promise(async () => {
    // ORDER + FAILURE→null: 6 thunks, odd indices reject; results stay in input order.
    const orderRaw = await parallelLimit<number>(
      Array.from({ length: 6 }, (_, i) => () => (i % 2 === 1 ? Promise.reject(new Error("x")) : Promise.resolve(i))),
      3,
    )
    expect(orderRaw.length, "parallelLimit keeps slot count").toBe(6)
    expect(orderRaw.join(","), "parallelLimit preserves input order + maps failures to null").toBe("0,,2,,4,")

    // NEVER MORE THAN n IN FLIGHT: deterministic gate (no wall-clock) — peak observed when n parked.
    const N = 4
    {
      let inFlight = 0
      let peak = 0
      let openGate!: () => void
      const gate = new Promise<void>((r) => (openGate = r))
      let signalSaturated!: () => void
      const saturated = new Promise<void>((r) => (signalSaturated = r))
      const slow = (i: number) => async (): Promise<number> => {
        inFlight++
        peak = Math.max(peak, inFlight)
        if (inFlight >= N) signalSaturated()
        await gate
        inFlight--
        return i
      }
      const resP = parallelLimit<number>(Array.from({ length: 20 }, (_, i) => slow(i)), N)
      await saturated
      expect(peak, `parallelLimit never runs more than n=${N} in flight`).toBeLessThanOrEqual(N)
      expect(peak, `parallelLimit saturates the pool to n=${N} (proves it QUEUES the rest)`).toBe(N)
      openGate()
      const res = await resP
      expect(res.join(","), "parallelLimit returns all 20 in input order").toBe(Array.from({ length: 20 }, (_, i) => i).join(","))
    }

    // CLAMP: an out-of-range n is clamped to 1..MAX_CONCURRENCY.
    {
      let highInFlight = 0
      let highPeak = 0
      const expectedPeak = Math.min(10, MAX_CONCURRENCY)
      let openGate!: () => void
      const gate = new Promise<void>((r) => (openGate = r))
      let signalSaturated!: () => void
      const saturated = new Promise<void>((r) => (signalSaturated = r))
      const tracked = (i: number) => async (): Promise<number> => {
        highInFlight++
        highPeak = Math.max(highPeak, highInFlight)
        if (highInFlight >= expectedPeak) signalSaturated()
        await gate
        highInFlight--
        return i
      }
      const clampedP = parallelLimit<number>(Array.from({ length: 10 }, (_, i) => tracked(i)), 1000)
      await saturated
      expect(highPeak, `parallelLimit clamps n to <= MAX_CONCURRENCY (${MAX_CONCURRENCY})`).toBeLessThanOrEqual(MAX_CONCURRENCY)
      expect(highPeak, "with 10 thunks the peak is bounded by the thunk count").toBeLessThanOrEqual(10)
      openGate()
      const clamped = await clampedP
      expect(clamped.join(","), "parallelLimit (clamped n) preserves order").toBe(Array.from({ length: 10 }, (_, i) => i).join(","))
    }

    // n<=0 / non-finite falls back to the default (>=1) and still completes every slot in order.
    const fallback = await parallelLimit<number>(Array.from({ length: 5 }, (_, i) => () => Promise.resolve(i)), 0)
    expect(fallback.join(","), "parallelLimit with n=0 falls back to a sane default").toBe("0,1,2,3,4")
  }),
)

it.effect("pipeline(): each item flows stage→stage independently (no barrier), values map", () =>
  Effect.promise(async () => {
    const out: Array<number> = []
    for await (const v of pipeline([1, 2, 3], async (x: number) => x * 2, async (x: number) => x + 1)) {
      out.push(v as number)
    }
    expect(out.join(","), "pipeline result").toBe("3,5,7")
  }),
)

it.effect("adversarialVerify(): produce once, skeptics vote in parallel; majority accepts, crashed drops", () =>
  Effect.promise(async () => {
    const verdict = await adversarialVerify<string>(
      async () => "the answer",
      [makeFakeSkeptic(true), makeFakeSkeptic("throw"), makeFakeSkeptic(true)],
    )
    expect(verdict.value, "adversarialVerify returns the produced value").toBe("the answer")
    expect(verdict.votes.length, "crashed skeptic dropped").toBe(2)
    expect(verdict.accepted, "2 accept votes is a majority → accepted").toBe(true)
  }),
)

it.effect("adversarialVerify(): a tie is NOT a majority → rejected (verify-before-accept)", () =>
  Effect.promise(async () => {
    const v = await adversarialVerify<string>(async () => "x", [async () => true, async () => false])
    expect(v.accepted, "tie (1 accept / 1 reject) is rejected, not accepted").toBe(false)
  }),
)
