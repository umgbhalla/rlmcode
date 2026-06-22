#!/usr/bin/env bun
// Golden test for the VELOCITY UNICODE TREE flatten() (src/tui/orch-tree.ts). Plain
// asserts, no framework (ax2 style — see design-check.test.ts). Builds a known tree
// (fan-out + nested children + an error node + a COLLAPSED settled subtree) and asserts
// the EXACT connector prefixes (├─ │ └─ blanks), render order, and the per-node payload
// (glyph, tools ring, collapsed tool-count label, expansion) the renderer depends on.
import type { Msg, OrchNode, OrchTree } from "../src/tui/atoms.ts"
import { flatten, type Row } from "../src/tui/orch-tree.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}
const eq = (got: unknown, want: unknown, msg: string) =>
  assert(got === want, `${msg}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`)

type ToolMsg = Extract<Msg, { kind: "tool" }>
const tool = (id: string): ToolMsg => ({ kind: "tool", id, name: "bash", args: "", status: "ok", result: "ok" })

// Fixture mirroring the DESIRED SHAPE: orchestrate → {plan, research → {3 agents}, judge}.
// `research` fans out 3 children (one error), `judge` is a leaf. We mark `research` settled
// (done) and toggle its collapse via expNodes to exercise both expanded + collapsed walks.
const N = (n: Partial<OrchNode> & { id: string }): OrchNode => ({
  label: n.id,
  phase: "",
  status: "done",
  ...n,
})
const nodes: Record<string, OrchNode> = {
  orchestrate: N({ id: "orchestrate", label: "orchestrate", status: "running", phase: "fan-out" }),
  plan: N({ id: "plan", parentId: "orchestrate", label: "plan", result: "decomposed into 3 subtasks", tokens: 1200 }),
  research: N({ id: "research", parentId: "orchestrate", label: "research (parallel ×3)", status: "running", phase: "running", tools: [tool("t1"), tool("t2")] }),
  auth: N({ id: "auth", parentId: "research", label: "agent:auth-flow", result: "found 12 refs", tokens: 3100 }),
  db: N({ id: "db", parentId: "research", label: "agent:db-schema", status: "running", phase: "reading models.ts" }),
  api: N({ id: "api", parentId: "research", label: "agent:api-routes", status: "error", result: "rate_limited 429", tokens: 800 }),
  judge: N({ id: "judge", parentId: "orchestrate", label: "judge", status: "running", phase: "scoring 3 candidates" }),
}
const orch: OrchTree = {
  nodes,
  roots: ["orchestrate"],
  totalTokens: 1200 + 3100 + 800,
}

// --- expanded walk (research running => auto-expands; no manual expansion needed) ----------
const rows = flatten(orch, new Set())
const byId = (id: string): Row => rows.find((r) => r.id === id)!

// render order = roots → children, first-seen
eq(
  rows.map((r) => r.id).join(","),
  "orchestrate,plan,research,auth,db,api,judge",
  "render order (roots → children, first-seen)",
)

// EXACT connector prefixes — the core of the golden test.
eq(byId("orchestrate").prefix, "", "root carries no connector")
eq(byId("plan").prefix, "├─ ", "first child of root = ├─")
eq(byId("research").prefix, "├─ ", "middle child of root = ├─")
eq(byId("judge").prefix, "└─ ", "last child of root = └─")
// nested under `research` (a NON-last child of root): its stem continues with "│  ".
eq(byId("auth").prefix, "│  ├─ ", "first nested child under a non-last branch")
eq(byId("db").prefix, "│  ├─ ", "middle nested child under a non-last branch")
eq(byId("api").prefix, "│  └─ ", "last nested child under a non-last branch")

// glyphs reflect status (running ◌ / done ✓ / error ✗)
eq(byId("orchestrate").glyph, "◌", "running glyph")
eq(byId("plan").glyph, "✓", "done glyph")
eq(byId("api").glyph, "✗", "error glyph")

// summaries: running shows phase, settled shows result
eq(byId("plan").summary, "decomposed into 3 subtasks", "settled summary = result")
eq(byId("db").summary, "reading models.ts", "running summary = phase")

// PER-NODE TOOL RING preserved: research owns 2 tools; expanded => tools carried, body stem set.
eq(byId("research").tools.length, 2, "owned tools carried on the row")
eq(byId("research").toolsLabel, "2 tools", "collapsed tool-count label")
eq(byId("research").bodyPrefix, "│  ", "owned-tool body stem (under a non-last root child)")
eq(byId("research").hasDetail, true, "node with tools+kids is expandable")
eq(byId("research").expanded, true, "running node auto-expands")

// the full rendered tree (prefix+glyph+label) reads as a real velocity tree.
const ascii = rows.map((r) => `${r.prefix}${r.glyph} ${r.label}`).join("\n")
const wantAscii = [
  "◌ orchestrate",
  "├─ ✓ plan",
  "├─ ◌ research (parallel ×3)",
  "│  ├─ ✓ agent:auth-flow",
  "│  ├─ ◌ agent:db-schema",
  "│  └─ ✗ agent:api-routes",
  "└─ ◌ judge",
].join("\n")
eq(ascii, wantAscii, "full unicode-tree ascii render")

// --- collapsed walk: settle `research` (done) and DON'T expand it -> subtree omitted -------
const settled: OrchTree = {
  ...orch,
  nodes: { ...nodes, research: { ...nodes.research!, status: "done", result: "3 agents done" } },
}
const collapsed = flatten(settled, new Set()) // research now done + not in expNodes => collapsed
eq(
  collapsed.map((r) => r.id).join(","),
  "orchestrate,plan,research,judge",
  "collapsed node omits its subtree (auth/db/api dropped)",
)
eq(collapsed.find((r) => r.id === "research")!.expanded, false, "settled, unexpanded node is collapsed")

// re-expanding via expNodes brings the subtree back, with last-child connectors intact.
const reexpanded = flatten(settled, new Set(["research"]))
eq(
  reexpanded.map((r) => r.id).join(","),
  "orchestrate,plan,research,auth,db,api,judge",
  "expNodes re-expands the collapsed subtree",
)
eq(reexpanded.find((r) => r.id === "api")!.prefix, "│  └─ ", "re-expanded last child keeps └─")

// --- VELOCITY CAP: a wide fan-out (5 children) shows only the last N + a collapse marker ---
const wideNodes: Record<string, OrchNode> = {
  root: N({ id: "root", label: "root", status: "running" }),
  c1: N({ id: "c1", parentId: "root" }),
  c2: N({ id: "c2", parentId: "root" }),
  c3: N({ id: "c3", parentId: "root" }),
  c4: N({ id: "c4", parentId: "root" }),
  c5: N({ id: "c5", parentId: "root" }),
}
const wide: OrchTree = { nodes: wideNodes, roots: ["root"], totalTokens: 0 }
// no cap (default Infinity) → every child renders, in order.
eq(flatten(wide, new Set()).map((r) => r.id).join(","), "root,c1,c2,c3,c4,c5", "no cap shows all children")
// cap=2 → the 3 oldest settled collapse into one marker; the last 2 stay (most recent at bottom).
const capped = flatten(wide, new Set(), 2)
eq(capped.map((r) => r.id).join(","), "root,root/__more,c4,c5", "velocity cap keeps last 2, collapses the rest")
eq(capped.find((r) => r.id === "root/__more")!.label, "+3 earlier", "marker counts the hidden children")
eq(capped.find((r) => r.id === "c5")!.prefix, "└─ ", "last shown child keeps └─ after the marker")
// a RUNNING child is always kept even when it's the oldest (live work never hidden).
const wideRun: OrchTree = { ...wide, nodes: { ...wideNodes, c1: { ...wideNodes.c1!, status: "running" } } }
eq(flatten(wideRun, new Set(), 2).map((r) => r.id).join(","), "root,root/__more,c1,c5", "running child kept despite being oldest; cap fills with most-recent settled")

if (failed > 0) {
  console.error(`orch-tree-render.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-tree-render.test: all pass ✓")
