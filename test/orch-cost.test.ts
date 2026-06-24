// @effect/vitest port of scripts/orch-cost.test.ts — pins the cost-meter path end-to-end
// WITHOUT an LLM: a FAKE AxGen + a FAKE usageOf, driven through runNode(). Asserts each
// node's done NodeEvent carries its OWN per-node tokens, the shared Budget tallies the run
// total, and the same OrchTree fold the UI uses reproduces the per-node + total sums.
import type { AxAIService, AxGen, AxGenIn, AxGenOut } from "@ax-llm/ax"
import { AxMemory } from "@ax-llm/ax"
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { type EmitSink, runNode } from "../src/core/orch-recipes.ts"
import { allocate, type BudgetUsage, type NodeEvent, type NodeOpts, tokensOf } from "../src/core/orch.ts"

const recorder = () => {
  const events: Array<NodeEvent> = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

const fakeGen = (reply: AxGenOut) => ({ forward: async () => reply }) as unknown as AxGen<AxGenIn, AxGenOut>
const fakeAi = {} as AxAIService
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

// The OrchTree fold the UI (atoms.installSink) uses, reproduced so the test pins the same
// arithmetic the footer renders.
type TreeNode = { id: string; tokens?: number }
const foldTree = (events: ReadonlyArray<NodeEvent>): { nodes: Record<string, TreeNode>; totalTokens: number } => {
  const nodes: Record<string, TreeNode> = {}
  for (const e of events) {
    if (e.type === "start") nodes[e.nodeId] ??= { id: e.nodeId }
    else if (e.type === "done") nodes[e.nodeId] = { id: e.nodeId, ...(e.tokens !== undefined ? { tokens: e.tokens } : {}) }
  }
  const totalTokens = Object.values(nodes).reduce((s, n) => s + (n.tokens ?? 0), 0)
  return { nodes, totalTokens }
}

it.effect("tokensOf prefers totalTokens, else sums parts, undefined → 0", () =>
  Effect.sync(() => {
    expect(tokensOf({ totalTokens: 318 }), "tokensOf prefers totalTokens").toBe(318)
    expect(tokensOf({ promptTokens: 40, completionTokens: 60 }), "tokensOf sums parts when no total").toBe(100)
    expect(tokensOf(undefined), "tokensOf(undefined) === 0").toBe(0)
  }),
)

it.effect("runNode stamps per-node tokens on the done event AND charges the budget", () =>
  Effect.promise(async () => {
    const { events, sink } = recorder()
    const budget = allocate(Number.POSITIVE_INFINITY)
    const usage: BudgetUsage = { promptTokens: 100, completionTokens: 200, totalTokens: 300 }
    await runNode(
      { nodeId: "n1", gen: fakeGen({ reply: "ok" }), opts: optsFor(), onEvent: sink, budget, usageOf: () => usage },
      fakeAi,
      { message: "hi" },
    )
    const done = events.find((e) => e.type === "done")
    expect(done?.type === "done" && done.tokens === 300, "runNode done event carries per-node tokens").toBe(true)
    expect(await budget.spent(), "budget tallied the node usage").toBe(300)
  }),
)

it.effect("per-node + run total over a multi-node fan-out: each done own tokens, fold == budget", () =>
  Effect.promise(async () => {
    const { events, sink } = recorder()
    const budget = allocate(Number.POSITIVE_INFINITY)
    const usages = [318_000, 42_000, 7_500]
    for (let i = 0; i < usages.length; i++) {
      await runNode(
        {
          nodeId: `branch-${i}`,
          gen: fakeGen({ reply: `r${i}` }),
          opts: optsFor(),
          onEvent: sink,
          budget,
          usageOf: () => ({ totalTokens: usages[i]! }),
        },
        fakeAi,
        { message: `task ${i}` },
      )
    }
    const dones = events.filter((e) => e.type === "done") as Array<Extract<NodeEvent, { type: "done" }>>
    expect(dones.length, "three done events").toBe(3)
    usages.forEach((u, i) => {
      const d = dones.find((e) => e.nodeId === `branch-${i}`)
      expect(d?.tokens, `branch-${i} per-node tokens === ${u}`).toBe(u)
    })
    const expectedTotal = usages.reduce((a, b) => a + b, 0)
    expect(await budget.spent(), `budget run total === ${expectedTotal}`).toBe(expectedTotal)
    const tree = foldTree(events)
    expect(tree.totalTokens, `OrchTree fold total === ${expectedTotal}`).toBe(expectedTotal)
    expect(tree.nodes["branch-0"]?.tokens, "tree node-0 holds its own tokens").toBe(318_000)
  }),
)
