#!/usr/bin/env bun
// LIVE CF-Kimi verification for the workflow({script}) ULTRACODE tool — the REAL gate that the
// model-authored-script path WORKS end-to-end against the real @cf/moonshotai/kimi-k2.7-code
// service. tsc proves it compiles; this proves a real script runs in-process, its NODES render
// (NodeEvents on the activity bus), and a NON-EMPTY real result comes back.
//
// Two proofs, mirroring the user's ask:
//   (a) FAN-OUT + JUDGE — a script that does phase('fan'); const rs = await parallel([...3 agent
//       nodes...]); return await judge(rs.filter(Boolean)). Asserts 3 agent nodes + a judge node
//       rendered and a real synthesized answer came back.
//   (b) rlm() BLOB-MINE — a script that does return await rlm(BIG_BLOB, '…/auth route…'). Asserts
//       the buried fact (registerAuthRoute) comes back — the rlm node-kind works AS a prim.
//
// GATED behind AX2_LIVE=1 (costs nothing in normal lint). Run:
//   AX2_LIVE=1 bun --env-file=.env scripts/workflow-live.test.ts   (or `bun run live:workflow`)
import { type AxAIService } from "@ax-llm/ax"
import { type Activity, setActivitySink } from "../src/core/activity.ts"
import { WORKFLOW_TOOLS } from "../src/core/workflow.ts"
import { buildLiveAi } from "./orch-live.test.ts"

const live = process.env.AX2_LIVE === "1"
if (!live) {
  console.log("workflow-live.test: skipped (set AX2_LIVE=1 to run the real CF-Kimi workflow proof)")
  process.exit(0)
}

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

// Drive the REAL workflow tool (WORKFLOW_TOOLS[0]) — the exact AxFunction the model calls in chat
// — with a captured node-event sink so we can ASSERT the script's nodes rendered in the OrchTree.
type NodeRec = { nodeId: string; event: string; parentId?: string; detail?: string }
const runWorkflowLive = async (
  script: string,
  liveAi: AxAIService,
): Promise<{ reply: string; nodes: NodeRec[] }> => {
  const tool = WORKFLOW_TOOLS.find((t) => t.name === "workflow")
  if (!tool?.func) throw new Error("workflow tool not found in WORKFLOW_TOOLS")
  const nodes: NodeRec[] = []
  setActivitySink((a: Activity) => {
    if (a.kind === "node") nodes.push({ nodeId: a.nodeId, event: a.event, parentId: a.parentId, detail: a.detail })
  })
  try {
    const out = await tool.func(
      { script },
      { sessionId: "live-wf", ai: liveAi, abortSignal: new AbortController().signal },
    )
    return { reply: String(out ?? ""), nodes }
  } finally {
    setActivitySink(null)
  }
}

// A real result is a non-empty string that is NOT one of the handler's failure sentinels.
const isReal = (s: string): boolean => {
  const t = s.trim()
  if (t.length === 0) return false
  return !/^(workflow failed:|partial:|error:|\(workflow returned no value\))/i.test(t)
}

const fmtNodes = (nodes: NodeRec[]): string =>
  nodes.map((n) => `    ${n.event} ${n.nodeId}${n.detail ? ` — ${n.detail}` : ""}`).join("\n")

await (async () => {
  const liveAi = buildLiveAi()

  // (a) FAN-OUT + JUDGE — Kimi-authored shape: fan 3 distinct one-liner candidates, judge picks one.
  console.log("\n(a) workflow({script}) — FAN-OUT + JUDGE (real CF-Kimi, in-process script)")
  const scriptA = [
    "phase('fan');",
    "const rs = await parallel([",
    "  () => agent('Reply with ONLY a one-line JS arrow function that reverses a string. No prose.'),",
    "  () => agent('Reply with ONLY a one-line JS expression using spread + reverse + join to reverse a string. No prose.'),",
    "  () => agent('Reply with ONLY a one-line JS using Array.from + reverse + join to reverse a string. No prose.'),",
    "]);",
    "phase('judge');",
    "return await judge(rs.filter(Boolean), 'Pick the single clearest correct one-line string-reverse. Return it verbatim.');",
  ].join("\n")
  console.log("AUTHORED SCRIPT:\n" + scriptA.split("\n").map((l) => "    " + l).join("\n"))
  const a = await runWorkflowLive(scriptA, liveAi)
  console.log("NODE EVENTS:\n" + fmtNodes(a.nodes))
  console.log("RESULT:\n    " + a.reply.replace(/\n/g, "\n    "))
  const aStarts = a.nodes.filter((n) => n.event === "start")
  assert(isReal(a.reply), `(a) returned a real synthesized answer (got: ${JSON.stringify(a.reply.slice(0, 120))})`)
  assert(/reverse/i.test(a.reply), "(a) the judged answer mentions reverse (a real string-reverse one-liner)")
  assert(aStarts.length >= 4, `(a) >= 4 node starts rendered (3 agent + judge), got ${aStarts.length}`)
  assert(a.nodes.some((n) => /judge/i.test(n.detail ?? "")), "(a) a judge node rendered in the tree")
  assert(a.nodes.some((n) => n.event === "done"), "(a) at least one node reported done in the tree")

  // (b) rlm() BLOB-MINE — a buried fact in a large module string, mined by the rlm() node-kind.
  console.log("\n(b) workflow({script}) — rlm() BLOB-MINE (real CF-Kimi, rlm node-kind as a prim)")
  const blobLines: string[] = []
  for (let i = 0; i < 60; i += 1) blobLines.push(`function helper${i}(x){ return x + ${i}; } // util ${i}`)
  blobLines.splice(
    37,
    0,
    "function registerAuthRoute(app){ app.post('/auth/login', loginHandler) } // <-- the auth route registrar",
  )
  const blob = blobLines.join("\n")
  const scriptB = [
    "const BLOB = " + JSON.stringify(blob) + ";",
    "return await rlm(BLOB, 'which function registers the /auth route? name it.');",
  ].join("\n")
  console.log("AUTHORED SCRIPT:\n    const BLOB = <" + blobLines.length + "-fn module>;")
  console.log("    return await rlm(BLOB, 'which function registers the /auth route? name it.');")
  const b = await runWorkflowLive(scriptB, liveAi)
  console.log("NODE EVENTS:\n" + fmtNodes(b.nodes))
  console.log("RESULT:\n    " + b.reply.replace(/\n/g, "\n    "))
  assert(isReal(b.reply), `(b) rlm() returned a real answer (got: ${JSON.stringify(b.reply.slice(0, 120))})`)
  assert(/registerAuthRoute/.test(b.reply), "(b) the buried fact (registerAuthRoute) came back from the rlm node")
  assert(b.nodes.length > 0, "(b) the rlm node rendered events in the tree")
})()

if (failures > 0) {
  console.error(`\nworkflow-live.test: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log("\nworkflow-live.test: all pass ✓")
