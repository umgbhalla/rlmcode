#!/usr/bin/env bun
// Headless test of the DETERMINISTIC MOCK layer (src/mock.ts + src/mock-ai.ts). NO
// Cloudflare, NO network, NO terminal-control yet — this pins the mock ITSELF: (1) the
// canned AI drives a REAL ax tool loop (tool_calls step → tool result → final reply with
// reasoning_content), yielding the EXACT scripted strings + usage; (2) the canned
// NodeEvent feed renders through the REAL velocity-tree renderer (flatten) into a stable
// unicode frame. Plain asserts, no framework — rlmcode fixture style (see orch-cost.test).
import { ax } from "@ax-llm/ax"
import { makeMockAI, MOCK_FIXTURE, MOCK_MODEL } from "../../src/core/mock-ai.ts"
import { MOCK_NODES } from "../../src/core/mock.ts"
import { BASE_TOOLS } from "../../src/core/tools.ts"
import type { NodeEvent } from "../../src/core/orch.ts"
import type { OrchNode, OrchTree } from "../../src/tui/atoms.ts"
import { flatten } from "../../src/tui/orch-tree.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}
const eq = (got: unknown, want: unknown, msg: string) =>
  assert(got === want, `${msg}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`)

await (async () => {
  // ── 1) The canned AI drives a REAL tool loop deterministically ──────────────────────
  // ax(message -> reply) with the real BASE_TOOLS, forwarded through the mock AI: step 1
  // is a bash tool_call (mock returns functionCalls), ax runs it (harmless echo), then the
  // mock sees the tool result in the prompt and returns the final reply + thought.
  {
    const ai = makeMockAI()
    const gen = ax("message:string -> reply:string", { functions: BASE_TOOLS })
    const out = (await gen.forward(ai, { message: "how many matches in src?" }, { maxSteps: 5 })) as { reply?: string }
    eq(out.reply, MOCK_FIXTURE.reply, "mock drives the real tool loop to the canned reply")

    // reasoning_content (thinking) + usage are deterministic off the same run. The loop ran
    // TWO chat() steps (tool call + final), so ax's cumulative usage = 2× the per-step
    // canned triple — a fixed, non-network number either way.
    const usage = (gen as { getUsage?: () => unknown }).getUsage?.()
    const last = Array.isArray(usage) ? (usage[usage.length - 1] as { tokens?: { totalTokens?: number; reasoningTokens?: number } }) : undefined
    eq(last?.tokens?.totalTokens, MOCK_FIXTURE.tokens.totalTokens * 2, "canned total tokens (2 steps)")
    eq(last?.tokens?.reasoningTokens, MOCK_FIXTURE.tokens.reasoningTokens * 2, "canned reasoning (thinking) tokens (2 steps)")
  }

  // ── 2) The canned AI's raw chat() is call-shape deterministic ───────────────────────
  // First call (no tool result yet) ⇒ a tool_call step carrying the thought; a follow-up
  // call WITH a tool result in the prompt ⇒ the final reply. Asserted directly so the
  // determinism contract is pinned independent of ax's loop internals.
  {
    const ai = makeMockAI()
    const sys = { role: "system" as const, content: "x" }
    const user = { role: "user" as const, content: "hi" }
    const step1 = (await ai.chat({ chatPrompt: [sys, user], model: MOCK_MODEL })) as { results: ReadonlyArray<{ functionCalls?: Array<unknown>; thought?: string; content?: string }> }
    assert((step1.results[0]?.functionCalls?.length ?? 0) === 1, "step 1 returns one canned tool call")
    eq(step1.results[0]?.thought, MOCK_FIXTURE.thought, "step 1 carries reasoning_content (thought)")

    const toolMsg = { role: "function" as const, functionId: "call_mock_1", result: "mock" }
    const step2 = (await ai.chat({ chatPrompt: [sys, user, toolMsg], model: MOCK_MODEL })) as { results: ReadonlyArray<{ content?: string; functionCalls?: Array<unknown> }> }
    eq(step2.results[0]?.content, MOCK_FIXTURE.reply, "step 2 (tool result present) returns the final reply")
    assert((step2.results[0]?.functionCalls?.length ?? 0) === 0, "final reply has no further tool calls")
  }

  // ── 3) The canned NodeEvent feed renders a STABLE unicode tree frame ────────────────
  // Reduce MOCK_NODES into an OrchTree (the same fold the atoms sink applies), then render
  // through the REAL flatten() — proving the canned feed draws ├─ └─ │ connectors with
  // each child nested under its parent and the run-total token sum.
  {
    const tree = foldNodes(MOCK_NODES)
    const rows = flatten(tree, new Set(tree.roots)) // expand all so the full tree shows
    const frame = rows.map((r) => `${r.prefix}${r.glyph} ${r.label}`).join("\n")
    const want = [
      "◌ orchestrate",
      "├─ ✓ plan",
      "├─ ◌ research",
      "│  ├─ ✓ auth",
      "│  ├─ ✓ db",
      "│  └─ ✗ api",
      "└─ ✓ judge",
    ].join("\n")
    eq(frame, want, "canned NodeEvent feed renders the velocity unicode tree frame")
    eq(tree.totalTokens, 1200 + 3100 + 900 + 500, "run-total tokens = sum of per-node done tokens")
    eq(tree.nodes["api"]?.status, "error", "errored node carries error status")
  }
})()

if (failed > 0) {
  console.error(`mock.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("mock.test: all pass ✓")

// The OrchTree fold the atoms sink applies, reproduced here as test fixture assembly: a
// start adds the node (root iff no parentId), done/error settles it + folds tokens. The
// RENDER (flatten) is the real renderer — only the tree assembly is local.
function foldNodes(events: ReadonlyArray<NodeEvent>): OrchTree {
  const nodes: Record<string, OrchNode> = {}
  const roots: Array<string> = []
  for (const e of events) {
    if (e.type === "start") {
      const node: OrchNode = {
        id: e.nodeId,
        ...(e.parentId !== undefined ? { parentId: e.parentId } : {}),
        label: e.nodeId,
        phase: e.phase,
        status: "running",
      }
      nodes[e.nodeId] = node
      if (e.parentId === undefined && !roots.includes(e.nodeId)) roots.push(e.nodeId)
    } else if (e.type === "done") {
      const prev = nodes[e.nodeId]
      if (prev) nodes[e.nodeId] = { ...prev, status: "done", result: String(e.result), ...(e.tokens !== undefined ? { tokens: e.tokens } : {}) }
    } else if (e.type === "error") {
      const prev = nodes[e.nodeId]
      if (prev) nodes[e.nodeId] = { ...prev, status: "error", result: String(e.cause) }
    }
  }
  const totalTokens = Object.values(nodes).reduce((s, n) => s + (n.tokens ?? 0), 0)
  return { nodes, roots, totalTokens }
}
