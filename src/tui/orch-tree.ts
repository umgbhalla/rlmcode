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
import type { Msg, OrchNode, OrchTree } from "./atoms.ts"
import { theme } from "./theme.ts"

type ToolMsg = Extract<Msg, { kind: "tool" }>

// COST-METER token formatter for a node's RIGHT-ALIGNED cost meter ("30.1k tok" / "742 tok").
// Kept local (a copy of chat-model.fmtTokens) so orch-tree stays a pure leaf with no UI imports.
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tok` : `${n} tok`)

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
  readonly tools: ReadonlyArray<ToolMsg> // PER-NODE TOOL ROUTING: this node's OWN tool steps (DETAIL pane only)
  readonly cost: string // RIGHT-ALIGNED cost meter: "30.1k tok · 22 tools" (empty when no cost yet)
  readonly failed: number // ERROR BUBBLING (F5): count of this node's FAILED child tools (0 = none)
  readonly phase: string // the node's agentType/phase descriptor (detail-pane status line)
  readonly status: OrchNode["status"]
  readonly hasKids: boolean
  readonly hasDetail: boolean // selectable = owns tools OR has child nodes (drill-down)
  readonly expanded: boolean
}

// STATUS DOT (render-target): a node is a sub-agent, so its status reads as a single dot —
// `●` running (animated to the spinner frame in chat.tsx, like a live agent), `✓` done, `✗`
// error. (`○` pending exists in the union space but the engine starts a node `running`.) The
// RUNNING dot is the sentinel chat.tsx's NodeHeader swaps for the live spinner frame.
export const RUNNING_DOT = "●"
const glyphOf = (s: OrchNode["status"]) => (s === "error" ? "✗" : s === "done" ? "✓" : RUNNING_DOT)
// RATE-LIMIT VISIBILITY + ERROR BUBBLING (F5): error status → red; done → ok; a node currently
// backing off (running + a `retry` status) OR with FAILED child tools reads WARNING (yellow), not
// the muted running color — so a node that's throttled or has failing tools stands out BEFORE its
// detail pane is opened. A clean running node stays muted.
const colorOf = (n: OrchNode) =>
  n.status === "error"
    ? theme.error
    : n.status === "done"
      ? theme.ok
      : n.retry || (n.failedTools ?? 0) > 0
        ? theme.warning
        : theme.muted

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
// RATE-LIMIT VISIBILITY: a node currently backing off carries a `retry` status ("⏳ rate-limited
// · retry 2/3 · 4s") — it WINS the summary cell over the phase, so the live tree SHOWS the 429
// wait instead of a generic "running…". Cleared (back to phase) the moment the node makes progress.
const summaryOf = (n: OrchNode): string => {
  if (n.status === "running") {
    if (n.retry) return n.retry
    return n.phase && n.phase !== n.label && n.phase !== n.id ? n.phase : "running…"
  }
  return humanText(n.result ?? n.phase ?? "")
}

// RIGHT-ALIGNED COST METER (render-target): the node's "Nk tok · N tools" — its OWN token spend
// and the count of tool calls it OWNS (a node IS a sub-agent). Either part is dropped when zero,
// so a tokenless node with tools shows "3 tools" and a tool-less settled node shows "1.2k tok".
// Empty when the node has neither (a fresh running node). This is the ONLY per-node meta the
// compact tree shows — the tools themselves live in the detail pane, never inline.
const costMeterOf = (n: OrchNode): string => {
  const parts: Array<string> = []
  if (typeof n.tokens === "number" && n.tokens > 0) parts.push(fmtTok(n.tokens))
  const c = n.tools?.length ?? 0
  if (c > 0) parts.push(`${c} tool${c === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

// parent->children index in first-seen (insertion) order; only edges whose parent
// exists are kept. Mirrors the old chat.tsx childrenIndex so render order is stable.
const childrenIndex = (orch: OrchTree): Record<string, Array<string>> => {
  const idx: Record<string, Array<string>> = {}
  for (const id of Object.keys(orch.nodes)) {
    const p = orch.nodes[id]!.parentId
    if (p !== undefined && orch.nodes[p] !== undefined) (idx[p] ??= []).push(id)
  }
  return idx
}

// One 3-col cell per NON-ROOT ancestor: "   " if that ancestor was its parent's last
// child (its branch already closed) or "│  " if not (the vertical guide continues).
const stemOf = (ancestors: ReadonlyArray<boolean>): string => ancestors.map((last) => (last ? "   " : "│  ")).join("")

// Connector PREFIX for a NON-ROOT node header: the ancestor stem plus this node's own
// cell — "└─ " when it is its parent's last child, else "├─ ".
const prefixOf = (ancestors: ReadonlyArray<boolean>, isLast: boolean): string => stemOf(ancestors) + (isLast ? "└─ " : "├─ ")

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
  cost: "",
  failed: 0,
  phase: "",
  status: "running",
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
const capChildren = (children: ReadonlyArray<string>, orch: OrchTree, cap: number): { shown: Array<string>; hidden: number } => {
  if (children.length <= cap) return { shown: [...children], hidden: 0 }
  const keep = new Set<string>()
  for (const c of children) if (orch.nodes[c]?.status === "running") keep.add(c)
  for (let i = children.length - 1; i >= 0 && keep.size < cap; i--) keep.add(children[i]!)
  const shown = children.filter((c) => keep.has(c)) // filter preserves first-seen order
  return { shown, hidden: children.length - shown.length }
}

export const flatten = (orch: OrchTree, expNodes: ReadonlySet<string>, maxChildren = Number.POSITIVE_INFINITY): Array<Row> => {
  const kids = childrenIndex(orch)
  const rows: Array<Row> = []

  // `ancestors` = last-child flags for NON-ROOT ancestors (empty for roots and their
  // direct children — a root contributes no column). `isLast` = is this node its
  // parent's last child (false/ignored for roots, which carry no connector).
  const walk = (id: string, ancestors: ReadonlyArray<boolean>, isLast: boolean, isRoot: boolean) => {
    const n = orch.nodes[id]
    if (n === undefined) return
    const children = kids[id] ?? []
    const hasKids = children.length > 0
    const tools = (n.tools ?? []) as ReadonlyArray<ToolMsg>
    // TREE EXPANSION now gates ONLY the child subtree (tools no longer render inline — they live
    // in the detail pane). A childless node is trivially "expanded" (nothing to fold). A running
    // node auto-expands so the live fan-out shows; a settled parent collapses via expNodes.
    // hasDetail = the node is SELECTABLE for a drill-down detail pane (owns tools OR has children
    // OR carries phase/result worth a pane) — every real node qualifies.
    const hasDetail = hasKids || tools.length > 0 || n.phase.length > 0 || n.result !== undefined
    const expanded = n.status === "running" || expNodes.has(id) || !hasKids
    // The stem children/body hang under: a root adds no column; a non-root extends the
    // ancestor stem by its own "│  "/"   " cell (open vs closed branch).
    const childAncestors = isRoot ? ancestors : [...ancestors, isLast]
    rows.push({
      id,
      prefix: isRoot ? "" : prefixOf(ancestors, isLast),
      bodyPrefix: stemOf(childAncestors),
      glyph: glyphOf(n.status),
      color: colorOf(n),
      label: n.label,
      summary: summaryOf(n),
      tokens: n.tokens,
      tools,
      cost: costMeterOf(n),
      failed: n.failedTools ?? 0,
      phase: n.phase,
      status: n.status,
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
    for (const [i, cid] of siblings.entries()) {
      const isLastSib = i === siblings.length - 1
      if (cid === null) rows.push(moreRow(`${id}/__more`, prefixOf(childAncestors, isLastSib), hidden))
      else walk(cid, childAncestors, isLastSib, false)
    }
  }

  for (const rid of orch.roots) walk(rid, [], false, true)
  return rows
}
