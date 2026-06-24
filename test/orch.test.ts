// @effect/vitest port of scripts/orch.test.ts — the FORK-ISOLATION proof. Pins the engine's
// load-bearing CONCURRENCY INVARIANT: parallel() nodes each forward over their OWN forked
// AxMemory, so two branches running at once can NEVER mutate each other's multi-turn history.
import type { AxAIService, AxGen } from "@ax-llm/ax"
import { AxMemory } from "@ax-llm/ax"
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { type EmitSink, runNode } from "../src/core/orch-recipes.ts"
import { node, type NodeEvent, type NodeOpts, parallel, pipeline } from "../src/core/orch.ts"

const recorder = () => {
  const events: Array<NodeEvent> = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

// A FAKE AxGen that WRITES into the forked memory it was handed (opts.mem) before returning —
// exactly the multi-turn side effect a real forward() has. This is what lets us prove fork
// isolation: if the engine shared one AxMemory across concurrent nodes, both branches' writes
// would land in the same history.
// ponytail: structural fake over the AxGen surface (only forward() is exercised by node()).
// Upgrade: a typed double implementing the full AxGen interface if the engine calls more methods.
const memWritingGen = (reply: string) =>
  ({
    forward: async (_ai: unknown, input: { tag: string }, o: NodeOpts): Promise<{ reply: string }> => {
      o.mem.addRequest([{ role: "user", content: input.tag }])
      return { reply }
    },
  }) as unknown as AxGen<{ tag: string }, { reply: string }>

const fakeAi = {} as AxAIService

// optsFor() mirrors orch-run.optsFor(): a FRESH AxMemory per call (the fork).
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

const soleTurn = (m: AxMemory): string => {
  const h = m.history(0) as Array<{ role: string; content: unknown }>
  const user = h.find((x) => x.role === "user")
  return typeof user?.content === "string" ? user.content : ""
}

it.effect("node forwards over its own forked opts and returns the reply", () =>
  Effect.promise(async () => {
    const opts = optsFor()
    const out = await node(memWritingGen("L"), opts)(fakeAi, { tag: "node-tag" })
    expect(out.reply, "node returns the gen reply").toBe("L")
    expect(soleTurn(opts.mem), "node forwarded over its own forked mem").toBe("node-tag")
  }),
)

it.effect("FORK ISOLATION via parallel(): each branch's memory holds ONLY its own write", () =>
  Effect.promise(async () => {
    const mems = [optsFor(), optsFor(), optsFor()]
    const tags = ["alpha", "beta", "gamma"]
    const replies = await parallel(mems.map((opts, i) => () => node(memWritingGen(`r${i}`), opts)(fakeAi, { tag: tags[i]! })))
    expect(replies.length === 3 && replies.every((r) => r !== null), "all three branches resolved").toBe(true)
    mems.forEach((opts, i) => {
      expect(soleTurn(opts.mem), `branch ${i} mem holds only its own tag`).toBe(tags[i])
    })
    expect(new Set(mems.map((o) => o.mem)).size, "each branch got a distinct AxMemory instance").toBe(3)
    const allTurns = mems.map((o) => soleTurn(o.mem)).toSorted().join(",")
    expect(allTurns, "each tag landed in exactly one branch").toBe("alpha,beta,gamma")
  }),
)

it.effect("pipeline maps each item through both stages", () =>
  Effect.promise(async () => {
    const out: Array<number> = []
    for await (const v of pipeline([1, 2, 3], async (x: number) => x * 10, async (x: number) => x + 1)) {
      out.push(v as number)
    }
    expect(out.join(","), "pipeline maps each item through both stages").toBe("11,21,31")
  }),
)

it.effect("runNode recipe over a fake gen: start → done, returns reply, fork preserved", () =>
  Effect.promise(async () => {
    const { events, sink } = recorder()
    const opts = optsFor()
    const out = await runNode(
      { nodeId: "rec", gen: memWritingGen("R"), opts, onEvent: sink, phase: "answer" },
      fakeAi,
      { tag: "recipe-tag" },
    )
    expect(out.reply, "runNode reply").toBe("R")
    expect(events.length === 2 && events[0]?.type === "start" && events[1]?.type === "done", "runNode emits start then done").toBe(true)
    expect(soleTurn(opts.mem), "runNode's node forwarded over its forked mem").toBe("recipe-tag")
  }),
)
