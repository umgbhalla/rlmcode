// @effect/vitest port of scripts/orch-tree-render.test.ts — golden test for the VELOCITY
// UNICODE TREE flatten() (src/tui/orch-tree.ts). Builds known trees and asserts the EXACT
// connector prefixes (├─ │ └─ blanks), render order, and per-node payload (status-dot glyph, the
// right-aligned cost meter, the owned-tool ring, expansion) the renderer depends on. Pure logic.
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Msg, OrchNode, OrchTree } from "../src/tui/atoms.ts"
import { flatten, type Row } from "../src/tui/orch-tree.ts"

type ToolMsg = Extract<Msg, { kind: "tool" }>
const tool = (id: string): ToolMsg => ({ kind: "tool", seq: 0, id, name: "bash", args: "", status: "ok", result: "ok" })

const N = (n: Partial<OrchNode> & { id: string }): OrchNode => ({ label: n.id, phase: "", status: "done", ...n })
const nodes: Record<string, OrchNode> = {
  orchestrate: N({ id: "orchestrate", label: "orchestrate", status: "running", phase: "fan-out" }),
  plan: N({ id: "plan", parentId: "orchestrate", label: "plan", result: "decomposed into 3 subtasks", tokens: 1200 }),
  research: N({ id: "research", parentId: "orchestrate", label: "research (parallel ×3)", status: "running", phase: "running", tools: [tool("t1"), tool("t2")] }),
  auth: N({ id: "auth", parentId: "research", label: "agent:auth-flow", result: "found 12 refs", tokens: 3100 }),
  db: N({ id: "db", parentId: "research", label: "agent:db-schema", status: "running", phase: "reading models.ts" }),
  api: N({ id: "api", parentId: "research", label: "agent:api-routes", status: "error", result: "rate_limited 429", tokens: 800 }),
  judge: N({ id: "judge", parentId: "orchestrate", label: "judge", status: "running", phase: "scoring 3 candidates" }),
}
const orch: OrchTree = { nodes, roots: ["orchestrate"], totalTokens: 1200 + 3100 + 800 }

it.effect("expanded walk: render order, connectors, glyphs, summaries, tool ring, ascii", () =>
  Effect.sync(() => {
    const rows = flatten(orch, new Set())
    const byId = (id: string): Row => rows.find((r) => r.id === id)!

    expect(rows.map((r) => r.id).join(","), "render order (roots → children, first-seen)").toBe("orchestrate,plan,research,auth,db,api,judge")

    expect(byId("orchestrate").prefix, "root carries no connector").toBe("")
    expect(byId("plan").prefix, "first child of root = ├─").toBe("├─ ")
    expect(byId("research").prefix, "middle child of root = ├─").toBe("├─ ")
    expect(byId("judge").prefix, "last child of root = └─").toBe("└─ ")
    expect(byId("auth").prefix, "first nested child under a non-last branch").toBe("│  ├─ ")
    expect(byId("db").prefix, "middle nested child under a non-last branch").toBe("│  ├─ ")
    expect(byId("api").prefix, "last nested child under a non-last branch").toBe("│  └─ ")

    // STATUS DOTS (render-target): ● running / ✓ done / ✗ error (the compact one-liner glyphs).
    expect(byId("orchestrate").glyph, "running glyph (status dot)").toBe("●")
    expect(byId("plan").glyph, "done glyph").toBe("✓")
    expect(byId("api").glyph, "error glyph").toBe("✗")

    expect(byId("plan").summary, "settled summary = result").toBe("decomposed into 3 subtasks")
    expect(byId("db").summary, "running summary = phase").toBe("reading models.ts")

    // COST METER (render-target): the RIGHT-ALIGNED "Nk tok · N tools" — research owns 2 tools, no
    // tokens, so its cost meter is "2 tools"; plan has 1.2k tokens, no tools, so it's "1.2k tok".
    expect(byId("research").tools.length, "owned tools carried on the row (for the detail pane)").toBe(2)
    expect(byId("research").cost, "cost meter = tool count when no tokens").toBe("2 tools")
    expect(byId("plan").cost, "cost meter = token spend when no tools").toBe("1.2k tok")
    expect(byId("research").hasDetail, "node with tools+kids is selectable for the detail pane").toBe(true)
    expect(byId("research").expanded, "running node auto-expands its subtree").toBe(true)

    const ascii = rows.map((r) => `${r.prefix}${r.glyph} ${r.label}`).join("\n")
    const wantAscii = [
      "● orchestrate",
      "├─ ✓ plan",
      "├─ ● research (parallel ×3)",
      "│  ├─ ✓ agent:auth-flow",
      "│  ├─ ● agent:db-schema",
      "│  └─ ✗ agent:api-routes",
      "└─ ● judge",
    ].join("\n")
    expect(ascii, "full unicode-tree ascii render").toBe(wantAscii)
  }),
)

it.effect("collapsed walk: settled+unexpanded node omits its subtree; expNodes re-expands", () =>
  Effect.sync(() => {
    const settled: OrchTree = { ...orch, nodes: { ...nodes, research: { ...nodes.research!, status: "done", result: "3 agents done" } } }
    const collapsed = flatten(settled, new Set())
    expect(collapsed.map((r) => r.id).join(","), "collapsed node omits its subtree").toBe("orchestrate,plan,research,judge")
    expect(collapsed.find((r) => r.id === "research")!.expanded, "settled, unexpanded node is collapsed").toBe(false)

    const reexpanded = flatten(settled, new Set(["research"]))
    expect(reexpanded.map((r) => r.id).join(","), "expNodes re-expands the collapsed subtree").toBe("orchestrate,plan,research,auth,db,api,judge")
    expect(reexpanded.find((r) => r.id === "api")!.prefix, "re-expanded last child keeps └─").toBe("│  └─ ")
  }),
)

it.effect("velocity cap: wide fan-out keeps last N + a collapse marker; a running child is never hidden", () =>
  Effect.sync(() => {
    const wideNodes: Record<string, OrchNode> = {
      root: N({ id: "root", label: "root", status: "running" }),
      c1: N({ id: "c1", parentId: "root" }),
      c2: N({ id: "c2", parentId: "root" }),
      c3: N({ id: "c3", parentId: "root" }),
      c4: N({ id: "c4", parentId: "root" }),
      c5: N({ id: "c5", parentId: "root" }),
    }
    const wide: OrchTree = { nodes: wideNodes, roots: ["root"], totalTokens: 0 }
    expect(flatten(wide, new Set()).map((r) => r.id).join(","), "no cap shows all children").toBe("root,c1,c2,c3,c4,c5")
    const capped = flatten(wide, new Set(), 2)
    expect(capped.map((r) => r.id).join(","), "velocity cap keeps last 2, collapses the rest").toBe("root,root/__more,c4,c5")
    expect(capped.find((r) => r.id === "root/__more")!.label, "marker counts the hidden children").toBe("+3 earlier")
    expect(capped.find((r) => r.id === "c5")!.prefix, "last shown child keeps └─ after the marker").toBe("└─ ")
    const wideRun: OrchTree = { ...wide, nodes: { ...wideNodes, c1: { ...wideNodes.c1!, status: "running" } } }
    expect(flatten(wideRun, new Set(), 2).map((r) => r.id).join(","), "running child kept despite being oldest").toBe("root,root/__more,c1,c5")
  }),
)
