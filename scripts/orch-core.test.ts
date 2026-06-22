#!/usr/bin/env bun
// Headless orch test (ponytail: non-trivial logic leaves a check). Plain asserts,
// no framework — same assert-fixture style as design-check.test / ponytail-debt.test.
//
// Drives the 5 CORE prims (leaf / parallel / pipeline / emit / allocate) + two
// recipes (agent, adversarialVerify) with a FAKE AxGen — NO LLM, NO network — and
// asserts the NodeEvent stream and result shapes. This is the first exercise of the
// orchestration engine off-LLM: it pins the verify-before-accept flow's contract.
import type { AxAIService, AxGen } from "@ax-llm/ax"
import { adversarialVerify, agent, type EmitSink } from "../src/orch-recipes.ts"
import { allocate, BudgetExhaustedError, type LeafOpts, type NodeEvent, parallel, pipeline } from "../src/orch.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

// A FAKE AxGen: leaf() only ever calls gen.forward(ai, input, opts), so a structural
// stub with forward() is a faithful stand-in. usageTokens lets a node charge a budget
// without a real getUsage() probe. Cast through unknown — the test owns this shape.
// ponytail: structural fake over the full AxGen surface. Upgrade: a typed test double
// implementing the real AxGen interface if the engine starts calling more methods.
const fakeGen = <O>(reply: O, opts: { fail?: boolean; usageTokens?: number } = {}) => {
  let lastUsage: { totalTokens: number } | undefined
  return {
    forward: async (_ai: unknown, _input: unknown, _o: unknown): Promise<O> => {
      if (opts.fail) throw new Error("fake leaf failure")
      if (opts.usageTokens !== undefined) lastUsage = { totalTokens: opts.usageTokens }
      return reply
    },
    getUsage: () => (lastUsage === undefined ? [] : [{ tokens: lastUsage }]),
  } as unknown as AxGen<any, O>
}
const fakeAi = {} as AxAIService

// A minimal LeafOpts — never used by the fake forward(), but the recipe API requires it.
const opts = {} as LeafOpts

// A recording sink: captures every NodeEvent so we can assert the lifecycle order.
const recorder = () => {
  const events: NodeEvent[] = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

await (async () => {
  // 1) leaf via the agent() recipe — happy path: start → done, returns the reply.
  {
    const { events, sink } = recorder()
    const out = await agent(
      { nodeId: "n1", gen: fakeGen({ reply: "hi" }), opts, onEvent: sink, phase: "answer" },
      fakeAi,
      { message: "q" },
    )
    assert(out.reply === "hi", `agent reply, got ${JSON.stringify(out)}`)
    assert(events.length === 2, `agent emits 2 events, got ${events.length}`)
    assert(events[0]?.type === "start" && events[0].nodeId === "n1", "agent first event is start/n1")
    assert(events[1]?.type === "done", "agent second event is done")
  }

  // 2) agent() failure path: start → error, then rethrows.
  {
    const { events, sink } = recorder()
    let threw = false
    try {
      await agent({ nodeId: "boom", gen: fakeGen({ reply: "x" }, { fail: true }), opts, onEvent: sink }, fakeAi, {})
    } catch {
      threw = true
    }
    assert(threw, "agent rethrows leaf failure")
    assert(events[0]?.type === "start" && events[1]?.type === "error", "agent emits start then error")
  }

  // 3) agent() charges the budget from the leaf's usage after forward returns.
  {
    const { sink } = recorder()
    const budget = allocate(100)
    await agent(
      { nodeId: "b", gen: fakeGen({ reply: "ok" }, { usageTokens: 30 }), opts, onEvent: sink, budget, usageOf: (g) => (g as { getUsage(): Array<{ tokens: { totalTokens: number } }> }).getUsage().at(-1)?.tokens },
      fakeAi,
      {},
    )
    assert((await budget.spent()) === 30, `budget charged 30, got ${await budget.spent()}`)
    assert((await budget.remaining()) === 70, `budget remaining 70, got ${await budget.remaining()}`)
  }

  // 4) allocate(): crossing total throws BudgetExhaustedError; freeze() throws too.
  {
    const b = allocate(10)
    let tag: string | undefined
    try {
      b.charge({ totalTokens: 11 })
    } catch (e) {
      tag = (e as BudgetExhaustedError)._tag
    }
    assert(tag === "BudgetExhaustedError", `over-budget throws BudgetExhaustedError, got ${tag}`)
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
