#!/usr/bin/env bun
// Headless COST-METER test (ponytail: non-trivial logic leaves a check). Plain asserts,
// no framework — same assert-fixture style as orch.test / orch-core.test.
//
// Pins the cost-meter path end-to-end WITHOUT an LLM: a FAKE AxGen + a FAKE usageOf that
// returns a chosen usage triple, driven through runNode() and structuredPipeline(). It
// asserts (1) each node's done NodeEvent carries its OWN per-node tokens (tokensOf of the
// usage triple), (2) the shared Budget tallies the run total, and (3) the same OrchTree
// fold the UI uses (sum of every node's tokens) reproduces the per-node + total sums.
import type { AxAIService, AxGen, AxGenIn, AxGenOut } from "@ax-llm/ax"
import { AxMemory } from "@ax-llm/ax"
import { runNode, type EmitSink } from "../src/core/orch-recipes.ts"
import { allocate, type BudgetUsage, type NodeOpts, type NodeEvent, tokensOf } from "../src/core/orch.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

const recorder = () => {
  const events: NodeEvent[] = []
  const sink: EmitSink = (e) => events.push(e)
  return { events, sink }
}

// A FAKE AxGen whose forward() just returns a fixed reply — no LLM, no network. The
// usage is supplied OUT OF BAND via the usageOf reader (below), exactly as a real gen's
// getUsage() would feed readUsageOf. Structural fake over the AxGen surface (only
// forward() is exercised by node()).
const fakeGen = (reply: AxGenOut) =>
  ({ forward: async () => reply }) as unknown as AxGen<AxGenIn, AxGenOut>

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

// The OrchTree fold the UI (atoms.installSink) uses: a done event sets the node's tokens,
// the run total is the sum over every node. Reproduced here so the test pins the same
// arithmetic the footer renders.
type TreeNode = { id: string; tokens?: number }
const foldTree = (events: readonly NodeEvent[]): { nodes: Record<string, TreeNode>; totalTokens: number } => {
  const nodes: Record<string, TreeNode> = {}
  for (const e of events) {
    if (e.type === "start") nodes[e.nodeId] ??= { id: e.nodeId }
    else if (e.type === "done") nodes[e.nodeId] = { id: e.nodeId, ...(e.tokens !== undefined ? { tokens: e.tokens } : {}) }
  }
  const totalTokens = Object.values(nodes).reduce((s, n) => s + (n.tokens ?? 0), 0)
  return { nodes, totalTokens }
}

await (async () => {
  // 0) tokensOf — the per-node derivation: prefer totalTokens, else sum the parts.
  {
    assert(tokensOf({ totalTokens: 318 }) === 318, "tokensOf prefers totalTokens")
    assert(tokensOf({ promptTokens: 40, completionTokens: 60 }) === 100, "tokensOf sums parts when no total")
    assert(tokensOf(undefined) === 0, "tokensOf(undefined) === 0")
  }

  // 1) runNode stamps the per-node tokens on the done event AND charges the budget.
  {
    const { events, sink } = recorder()
    const budget = allocate(Number.POSITIVE_INFINITY)
    const usage: BudgetUsage = { promptTokens: 100, completionTokens: 200, totalTokens: 300 }
    await runNode(
      { nodeId: "n1", gen: fakeGen({ reply: "ok" }), opts: optsFor(), onEvent: sink, budget, usageOf: () => usage },
      fakeAi,
      { message: "hi" },
    )
    const done = events.find((e) => e.type === "done")
    assert(done?.type === "done" && done.tokens === 300, `runNode done event carries per-node tokens, got ${JSON.stringify(done)}`)
    assert((await budget.spent()) === 300, `budget tallied the node usage, got ${await budget.spent()}`)
  }

  // 2) Per-node + run total over a multi-node fan-out: three nodes with distinct usages.
  // Each done carries its own tokens; the tree fold sums to the run total = the budget.
  {
    const { events, sink } = recorder()
    const budget = allocate(Number.POSITIVE_INFINITY)
    const usages = [318_000, 42_000, 7_500]
    for (let i = 0; i < usages.length; i++) {
      await runNode(
        { nodeId: `branch-${i}`, gen: fakeGen({ reply: `r${i}` }), opts: optsFor(), onEvent: sink, budget, usageOf: () => ({ totalTokens: usages[i]! }) },
        fakeAi,
        { message: `task ${i}` },
      )
    }
    const dones = events.filter((e) => e.type === "done") as Extract<NodeEvent, { type: "done" }>[]
    assert(dones.length === 3, `three done events, got ${dones.length}`)
    usages.forEach((u, i) => {
      const d = dones.find((e) => e.nodeId === `branch-${i}`)
      assert(d?.tokens === u, `branch-${i} per-node tokens === ${u}, got ${d?.tokens}`)
    })
    const expectedTotal = usages.reduce((a, b) => a + b, 0)
    assert((await budget.spent()) === expectedTotal, `budget run total === ${expectedTotal}, got ${await budget.spent()}`)
    const tree = foldTree(events)
    assert(tree.totalTokens === expectedTotal, `OrchTree fold total === ${expectedTotal}, got ${tree.totalTokens}`)
    assert(tree.nodes["branch-0"]?.tokens === 318_000, "tree node-0 holds its own tokens")
  }
})()

if (failed > 0) {
  console.error(`orch-cost.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-cost.test: all pass ✓")
