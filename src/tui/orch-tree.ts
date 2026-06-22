// PURE TUI helper: flatten an OrchTree into ordered, connector-prefixed rows for a
// velocity unicode-tree render (├─ │ └─). No React, no Effect, no IO — a total
// function over the immutable OrchTree shape, so it is trivially golden-testable
// (see scripts/orch-tree-render.test.ts). NodeRow consumes a Row and renders one
// <text> per node header; all tree geometry lives HERE, not in nested padding boxes.
//
// PRESERVES every current NodeView feature: each Row carries the per-node TOOL ring
// (`tools`), the collapsed-only owned-tool COUNT label, the token badge, the status
// glyph/color, and the ▾/▸ expander state. The owning chat.tsx renders the tools
// under the node, indented by `bodyPrefix` so they hang inside the tree.
import type { Msg, OrchNode, OrchTree } from "../atoms.ts"

type ToolMsg = Extract<Msg, { kind: "tool" }>

// One flattened tree row = one orchestration node. `prefix` is the precomputed
// connector string (├─ / └─ / │ continuation / blanks); `bodyPrefix` is the
// continuation stem the node's expanded body (its owned tool rows) aligns under.
// The rest carries everything chat.tsx's NodeRow needs to draw the row WITHOUT
// re-walking the tree.
export type Row = {
  readonly id: string
  readonly prefix: string // connector cell for THIS node's header line ("" for roots)
  readonly bodyPrefix: string // stem under this node, where its owned tool rows hang
  readonly glyph: string
  readonly color: string
  readonly label: string
  readonly summary: string
  readonly tokens: number | undefined
  readonly tools: readonly ToolMsg[] // PER-NODE TOOL ROUTING: this node's OWN tool steps
  readonly toolsLabel: string // collapsed-only "N tools" summary (empty when none)
  readonly hasKids: boolean
  readonly hasDetail: boolean // expandable = owns tools OR has child nodes
  readonly expanded: boolean
}

const glyphOf = (s: OrchNode["status"]) => (s === "running" ? "◌" : s === "error" ? "✗" : "✓")
const colorOf = (s: OrchNode["status"]) => (s === "error" ? "#f38ba8" : s === "done" ? "#a6e3a1" : "#7f849c")
const summaryOf = (n: OrchNode): string => (n.status === "running" ? n.phase || "running…" : (n.result ?? n.phase))

// Collapsed-only per-node meta: owned-tool count (this node OWNS its tools).
const toolsLabelOf = (n: OrchNode): string => {
  const c = n.tools?.length ?? 0
  return c > 0 ? `${c} tool${c > 1 ? "s" : ""}` : ""
}

// parent->children index in first-seen (insertion) order; only edges whose parent
// exists are kept. Mirrors the old chat.tsx childrenIndex so render order is stable.
const childrenIndex = (orch: OrchTree): Record<string, string[]> => {
  const idx: Record<string, string[]> = {}
  for (const id of Object.keys(orch.nodes)) {
    const p = orch.nodes[id]!.parentId
    if (p !== undefined && orch.nodes[p] !== undefined) (idx[p] ??= []).push(id)
  }
  return idx
}

// One 3-col cell per NON-ROOT ancestor: "   " if that ancestor was its parent's last
// child (its branch already closed) or "│  " if not (the vertical guide continues).
const stemOf = (ancestors: readonly boolean[]): string => ancestors.map((last) => (last ? "   " : "│  ")).join("")

// Connector PREFIX for a NON-ROOT node header: the ancestor stem plus this node's own
// cell — "└─ " when it is its parent's last child, else "├─ ".
const prefixOf = (ancestors: readonly boolean[], isLast: boolean): string => stemOf(ancestors) + (isLast ? "└─ " : "├─ ")

/**
 * Flatten an OrchTree into ordered Row[] for the unicode-tree render. Walks roots
 * then children (first-seen order), computing each row's connector prefix from its
 * non-root ancestor last-child flags. Roots carry no connector. A COLLAPSED node
 * (expanded===false) hides its subtree — its descendant rows are not emitted. A node
 * is "expanded" when running (live auto-expand) or present in `expNodes`; a node with
 * no detail (no kids AND no owned tools) is trivially expanded (collapse is moot).
 */
export const flatten = (orch: OrchTree, expNodes: ReadonlySet<string>): Row[] => {
  const kids = childrenIndex(orch)
  const rows: Row[] = []

  // `ancestors` = last-child flags for NON-ROOT ancestors (empty for roots and their
  // direct children — a root contributes no column). `isLast` = is this node its
  // parent's last child (false/ignored for roots, which carry no connector).
  const walk = (id: string, ancestors: readonly boolean[], isLast: boolean, isRoot: boolean) => {
    const n = orch.nodes[id]
    if (n === undefined) return
    const children = kids[id] ?? []
    const hasKids = children.length > 0
    const tools = (n.tools ?? []) as readonly ToolMsg[]
    const hasDetail = hasKids || tools.length > 0
    const expanded = n.status === "running" || expNodes.has(id) || !hasDetail
    // The stem children/body hang under: a root adds no column; a non-root extends the
    // ancestor stem by its own "│  "/"   " cell (open vs closed branch).
    const childAncestors = isRoot ? ancestors : [...ancestors, isLast]
    rows.push({
      id,
      prefix: isRoot ? "" : prefixOf(ancestors, isLast),
      bodyPrefix: stemOf(childAncestors),
      glyph: glyphOf(n.status),
      color: colorOf(n.status),
      label: n.label,
      summary: summaryOf(n),
      tokens: n.tokens,
      tools,
      toolsLabel: toolsLabelOf(n),
      hasKids,
      hasDetail,
      expanded,
    })
    if (!expanded) return // collapsed: hide the subtree
    children.forEach((cid, i) => walk(cid, childAncestors, i === children.length - 1, false))
  }

  orch.roots.forEach((rid) => walk(rid, [], false, true))
  return rows
}
