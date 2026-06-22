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
import { theme } from "../theme.ts"

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
const colorOf = (s: OrchNode["status"]) => (s === "error" ? theme.error : s === "done" ? theme.ok : theme.muted)

// A node's settled payload is often a serialized object ({"thought":"…","reply":"…"})
// that, dumped raw into the summary cell, leaks `{"` braces and JSON noise into the
// widest row on screen. Pull the human field out — JSON.parse when whole, else a regex
// for the common keys (results are clipped upstream, so the JSON is frequently truncated
// mid-string and won't parse). Falls back to the raw string when it's plainly not JSON.
const humanText = (s: string): string => {
  const t = s.trim()
  if (!t.startsWith("{") && !t.startsWith("[")) return s
  try {
    const o = JSON.parse(t)
    return String(o?.thought ?? o?.reply ?? o?.result ?? o?.summary ?? s)
  } catch {
    const m = t.match(/"(?:thought|reply|result|summary)"\s*:\s*"((?:[^"\\]|\\.)*)/)
    return m ? m[1]!.replace(/\\"/g, '"').replace(/\\n/g, " ") : s
  }
}

// summary cell: while running, the phase IF it's meaningful (not the placeholder echo of
// the node's own label/id — which rendered the infamous "node node"); else "running…".
// Settled nodes show their payload with the JSON envelope stripped.
const summaryOf = (n: OrchNode): string => {
  if (n.status === "running") return n.phase && n.phase !== n.label && n.phase !== n.id ? n.phase : "running…"
  return humanText(n.result ?? n.phase ?? "")
}

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
// A synthetic "… +N earlier" sibling row standing in for the older fan-out branches we
// collapsed under a velocity cap. Renders like any sibling (so the connectors stay sane)
// but carries no detail and is never expandable.
const moreRow = (id: string, prefix: string, hidden: number): Row => ({
  id,
  prefix,
  bodyPrefix: "",
  glyph: "┄",
  color: theme.faint,
  label: `+${hidden} earlier`,
  summary: "",
  tokens: undefined,
  tools: [],
  toolsLabel: "",
  hasKids: false,
  hasDetail: false,
  expanded: true,
})

// VELOCITY CAP: on a wide fan-out (rlm_workflow can spawn up to 100 branches) the tree
// walls the screen. `maxChildren` caps how many of a node's children render — we ALWAYS
// keep the running ones (that's the live work) plus the most-recent settled, up to the cap,
// and collapse the older settled into one "… +N earlier" row. Default Infinity ⇒ no cap
// (the golden test + small trees are unchanged); chat.tsx passes the real window so only the
// last ~N runs-at-a-time show. Order is preserved (marker sits where the hidden ones were).
const capChildren = (children: readonly string[], orch: OrchTree, cap: number): { shown: string[]; hidden: number } => {
  if (children.length <= cap) return { shown: [...children], hidden: 0 }
  const keep = new Set<string>()
  for (const c of children) if (orch.nodes[c]?.status === "running") keep.add(c)
  for (let i = children.length - 1; i >= 0 && keep.size < cap; i--) keep.add(children[i]!)
  const shown = children.filter((c) => keep.has(c)) // filter preserves first-seen order
  return { shown, hidden: children.length - shown.length }
}

export const flatten = (orch: OrchTree, expNodes: ReadonlySet<string>, maxChildren = Number.POSITIVE_INFINITY): Row[] => {
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
    // VELOCITY CAP: keep running + most-recent settled children up to maxChildren; collapse
    // the older ones into a single "… +N earlier" marker that sits FIRST so the live/recent
    // runs stay at the bottom (where the eye lands). The marker + shown form the sibling set,
    // so the last-child connector flags are computed over them, not the full child list.
    const { shown, hidden } = capChildren(children, orch, maxChildren)
    const siblings: Array<string | null> = hidden > 0 ? [null, ...shown] : shown
    siblings.forEach((cid, i) => {
      const isLastSib = i === siblings.length - 1
      if (cid === null) rows.push(moreRow(`${id}/__more`, prefixOf(childAncestors, isLastSib), hidden))
      else walk(cid, childAncestors, isLastSib, false)
    })
  }

  orch.roots.forEach((rid) => walk(rid, [], false, true))
  return rows
}
