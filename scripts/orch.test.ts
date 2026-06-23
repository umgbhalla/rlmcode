#!/usr/bin/env bun
// Headless orch test — the FORK-ISOLATION proof (ponytail: non-trivial logic leaves
// a check). Plain asserts, no framework — same assert-fixture style as
// design-check.test / ponytail-debt.test / orch-core.test.
//
// Where orch-core.test pins the NodeEvent / result SHAPES, this file pins the engine's
// load-bearing CONCURRENCY INVARIANT: parallel() nodes each forward over their OWN
// forked AxMemory, so two branches running at once can NEVER mutate each other's
// multi-turn history. It drives node + parallel + pipeline + the runNode() recipe with a
// FAKE AxGen — NO LLM, NO network — whose forward() actually WRITES into opts.mem, then
// asserts every branch's memory holds only its own write (no cross-branch bleed).
import type { AxAIService, AxGen } from "@ax-llm/ax"
import { AxMemory } from "@ax-llm/ax"
import { runNode, type EmitSink } from "../src/core/orch-recipes.ts"
import { type NodeOpts, node, type NodeEvent, parallel, pipeline } from "../src/core/orch.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

// A recording sink: captures every NodeEvent so we can assert lifecycle order.
const recorder = () => {
  const events: Array<NodeEvent> = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

// A FAKE AxGen that WRITES into the forked memory it was handed (opts.mem) before
// returning — exactly the multi-turn side effect a real forward() has. This is what
// lets us prove fork isolation: if the engine shared one AxMemory across concurrent
// nodes, both branches' writes would land in the same history.
// ponytail: structural fake over the AxGen surface (only forward() is exercised by
// node()). Upgrade: a typed double implementing the full AxGen interface if the engine
// starts calling more methods on the gen.
const memWritingGen = (reply: string) =>
  ({
    forward: async (_ai: unknown, input: { tag: string }, o: NodeOpts): Promise<{ reply: string }> => {
      // The branch records its own request into ITS forked memory.
      o.mem.addRequest([{ role: "user", content: input.tag }])
      return { reply }
    },
  }) as unknown as AxGen<{ tag: string }, { reply: string }>

const fakeAi = {} as AxAIService

// optsFor() mirrors orch-run.optsFor(): a FRESH AxMemory per call (the fork). The other
// fields are inert under the fake forward(), so minimal stubs suffice.
const optsFor = (): NodeOpts =>
  ({
    mem: new AxMemory(),
    sessionId: "test",
    tracer: undefined,
    traceContext: undefined,
    maxSteps: 1,
    stream: false,
    abortSignal: new AbortController().signal,
  }) as unknown as NodeOpts

// Read the single user turn a branch wrote into its forked memory (or "" if empty).
const soleTurn = (m: AxMemory): string => {
  const h = m.history(0) as Array<{ role: string; content: unknown }>
  const user = h.find((x) => x.role === "user")
  return typeof user?.content === "string" ? user.content : ""
}

await (async () => {
  // 1) node — the only thing that calls the gen — forwards over its opts and returns
  // the reply. Drives the core primitive directly (no recipe wrapper).
  {
    const opts = optsFor()
    const out = await node(memWritingGen("L"), opts)(fakeAi, { tag: "node-tag" })
    assert(out.reply === "L", `node returns the gen reply, got ${JSON.stringify(out)}`)
    assert(soleTurn(opts.mem) === "node-tag", "node forwarded over its own forked mem")
  }

  // 2) FORK ISOLATION via parallel() — the headline invariant. Three branches run
  // concurrently, each with its OWN forked AxMemory, each writing a distinct tag. After
  // the fan-out, every branch's memory must hold ONLY its own tag — proving no branch
  // mutated another's history (which a shared AxMemory would have caused).
  {
    const mems = [optsFor(), optsFor(), optsFor()]
    const tags = ["alpha", "beta", "gamma"]
    const replies = await parallel(
      mems.map((opts, i) => () => node(memWritingGen(`r${i}`), opts)(fakeAi, { tag: tags[i]! })),
    )
    assert(replies.length === 3 && replies.every((r) => r !== null), "all three branches resolved")
    // Each branch sees only its own write.
    mems.forEach((opts, i) => {
      assert(soleTurn(opts.mem) === tags[i], `branch ${i} mem holds only its own tag, got "${soleTurn(opts.mem)}"`)
    })
    // And the memories are distinct instances (the fork, not one shared object).
    assert(new Set(mems.map((o) => o.mem)).size === 3, "each branch got a distinct AxMemory instance")
    // Cross-check: no branch's tag leaked into a sibling's history.
    const allTurns = mems.map((o) => soleTurn(o.mem)).toSorted().join(",")
    assert(allTurns === "alpha,beta,gamma", `each tag landed in exactly one branch, got ${allTurns}`)
  }

  // 3) pipeline — each item flows stage→stage independently (no barrier); values map.
  {
    const out: Array<number> = []
    for await (const v of pipeline([1, 2, 3], async (x: number) => x * 10, async (x: number) => x + 1)) {
      out.push(v as number)
    }
    assert(out.join(",") === "11,21,31", `pipeline maps each item through both stages, got ${out.join(",")}`)
  }

  // 4) runNode() recipe over a fake gen — start → done, returns the reply, and the node
  // still forwarded over the recipe-supplied forked mem (recipe doesn't break the fork).
  {
    const { events, sink } = recorder()
    const opts = optsFor()
    const out = await runNode(
      { nodeId: "rec", gen: memWritingGen("R"), opts, onEvent: sink, phase: "answer" },
      fakeAi,
      { tag: "recipe-tag" },
    )
    assert(out.reply === "R", `runNode reply, got ${JSON.stringify(out)}`)
    assert(events.length === 2 && events[0]?.type === "start" && events[1]?.type === "done", "runNode emits start then done")
    assert(soleTurn(opts.mem) === "recipe-tag", "runNode's node forwarded over its forked mem")
  }
})()

if (failed > 0) {
  console.error(`orch.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch.test: all pass ✓")
