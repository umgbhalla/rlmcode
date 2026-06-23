// WORKFLOW PART — the orchestration node-tree, rendered INLINE under the turn that
// produced it (opencode-ux-blueprint Option B; opencode PART_MAPPING dispatch
// session/index.tsx:1556/:1640). Previously the tree painted as ONE session-level block
// pinned below ALL turns; now each workflow turn carries its own OrchTree (Turn.workflow)
// and renders the tree right after its reply — so the fan-out reads as part of THAT turn's
// answer, and a plain (non-workflow) turn renders NO orchestration block at all.
//
// This file owns the node-tree CHROME extracted from chat.tsx (the velocity unicode tree:
// flatten() → NodeRow[] → Σ footer) so chat.tsx stays under budget. It reuses the pure
// flatten() (orch-tree.ts) + the orchSigma footer; node rows are rendered by a caller-
// injected renderRow so the per-node ToolView wiring stays in chat.tsx.
import type { OrchTree } from "./atoms.ts"
import { flatten, type Row as OrchRow } from "./orch-tree.ts"
import { theme } from "./theme.ts"

// VELOCITY CAP — max fan-out children shown per node at once (running + most-recent
// settled); older ones collapse into one "┄ +N earlier" row. ~ORCH_CONCURRENCY worth, so
// the tree shows roughly what's in flight + just-finished, not a 100-branch wall.
export const ORCH_MAX_SHOWN = Number(process.env.RLM_ORCH_MAX_SHOWN ?? 8)

// COST-METER token formatter shared with chat.tsx's turn meta — kept here as the type so
// WorkflowPart can format the Σ footer without importing back into chat.tsx.
type FmtTokens = (n: number) => string

// Only worth showing the orchestration tree when there's real fan-out — more than one
// node, or a node that owns tools. A plain turn emits a SINGLE childless, tool-less root
// node that just mirrors the reply; rendering it repeats the thought and triples the token
// count (turn meta + node badge + Σ) for nothing. (Trivial-orch redundancy.)
const orchWorthShowing = (orch: OrchTree): boolean => {
  const nodes = Object.values(orch.nodes)
  return nodes.length > 1 || nodes.some((n) => (n.tools?.length ?? 0) > 0)
}

// Show the orch tree only on real fan-out (has roots + worth-showing). Narrows `orch`
// so callers get a defined tree. Drives BOTH the inline render AND whether the orch rows
// join the Tab focus ring (a non-workflow turn must contribute neither).
export const computeShowOrch = (orch: OrchTree | undefined): orch is OrchTree =>
  orch !== undefined && orch.roots.length > 0 && orchWorthShowing(orch)

// RATE-LIMIT VISIBILITY: the live retry status of the FIRST node currently backing off (or null
// when none is). Drives the COMPOSER's rate-limit note — so while a background node retries a 429
// the status row SHOWS "⏳ rate-limited · retry 2/3 · 4s" instead of a bare "thinking…", making the
// throttle visible at the turn level too (not just buried in the tree). Pure; scans the node map.
export const activeRetry = (orch: OrchTree | undefined): string | null => {
  if (orch === undefined) return null
  for (const n of Object.values(orch.nodes)) if (n.status === "running" && n.retry) return n.retry
  return null
}

// Σ footer summary: the live run total — COST-METER tokens (preserved from orch.totalTokens)
// · node count · error count. Computed over the whole node map (not just visible rows) so a
// collapsed subtree still counts toward the totals.
export const orchSigma = (orch: OrchTree, fmtTokens: FmtTokens): string => {
  const nodes = Object.values(orch.nodes)
  const errors = nodes.filter((n) => n.status === "error").length
  const parts = [`Σ ${fmtTokens(orch.totalTokens)}`, `${nodes.length} node${nodes.length === 1 ? "" : "s"}`]
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

// Orchestration rows that join the Tab focus ring, in render order. A collapsible node
// (hasDetail) exposes a `node:<id>` key so it can be collapsed/expanded from the keyboard;
// each EXPANDED node's owned tools then expose a `tool:<id>` key (same key as transcript
// tools). Collapsed nodes are absent from `rows` (flatten omits their subtree) so their
// tools stay out of the ring. Empty for a non-workflow turn (computeShowOrch gates the call).
export const orchFocusables = (rows: ReadonlyArray<OrchRow>): Array<string> => {
  const out: Array<string> = []
  for (const r of rows) {
    if (r.hasDetail) out.push(`node:${r.id}`)
    if (r.expanded) for (const m of r.tools) out.push(`tool:${m.id}`)
  }
  return out
}

// Flatten a turn's workflow tree into the velocity-capped Row[] the inline render + focus
// ring share. Pure; kept here so chat.tsx doesn't re-derive the cap argument.
export const workflowRows = (orch: OrchTree, expNodes: ReadonlySet<string>): Array<OrchRow> => flatten(orch, expNodes, ORCH_MAX_SHOWN)

// WORKFLOW PART — the inline orchestration block: an "orchestration" section header, the
// velocity unicode tree (one row per flattened node, drawn by the injected renderRow), and
// the Σ run-total footer. Rendered by TurnView AFTER the reply, ONLY when the turn carries a
// worth-showing workflow (computeShowOrch). The node rows are injected (renderRow) so the
// per-node ToolView wiring + expansion/focus state stay owned by chat.tsx.
export function WorkflowPart({
  orch,
  rows,
  fmtTokens,
  indent,
  renderRow,
}: {
  orch: OrchTree
  rows: ReadonlyArray<OrchRow>
  fmtTokens: FmtTokens
  indent: number
  renderRow: (row: OrchRow) => React.ReactNode
}) {
  return (
    <box flexDirection="column" style={{ marginTop: 1, paddingLeft: 1 }}>
      <text fg={theme.muted}>orchestration</text>
      {/* VELOCITY UNICODE TREE: one flat <text> per flattened Row, connectors precomputed
          by flatten() — no nested padding boxes. */}
      <box flexDirection="column" style={{ paddingLeft: indent }}>
        {rows.map((row) => renderRow(row))}
        {/* Σ footer: live run total — tokens · nodes · errors (COST-METER total preserved). */}
        <text fg={theme.dim}>{orchSigma(orch, fmtTokens)}</text>
      </box>
    </box>
  )
}
