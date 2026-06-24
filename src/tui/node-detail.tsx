// NODE DETAIL PANE (render-target tier 2) — the on-demand pane shown when a tree node is
// SELECTED (Tab/arrow focus) and ENTERED. The tree (orch-tree.ts) is tier 1: structure + status,
// one compact one-liner per node, NO output. This pane is tier 2: a node's own status + activity,
// still NOT the raw tool OUTPUT (that is a further drill-down — Enter on an Activity call row, or
// simply absent). Mirrors motel src/ui/SpanDetailPane.tsx — a tree on one side, a detail view on
// the other, never inline splatter.
//
// What it shows (the target screenshots):
//   - a titled box (the node label);
//   - a STATUS LINE: "<dot> <Status> · <phase>" (the node's agentType/phase descriptor);
//   - the cost line: "<tok> tok · <N> tool calls";
//   - ACTIVITY: "Activity · last <N> of <M> tool calls" + the WINDOWED last-N tool CALL
//     one-liners (toolLabel + truncated args, NO output). Windowed to the tail, never all M.
import type { Msg, OrchNode } from "./atoms.ts"
import { theme } from "./theme.ts"
import { toolLabel } from "./toolui.ts"

type ToolMsg = Extract<Msg, { kind: "tool" }>

// How many recent tool CALLS the Activity window shows (the tail). The target shows "last 3".
const ACTIVITY_WINDOW = 3

// Local formatters (a copy of chat-model.fmtTokens/oneLine) so node-detail does NOT import
// chat-model.ts — chat-model imports workflow.tsx, which imports this file, an import cycle.
const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tok` : `${n} tok`)
const oneLine = (s: string, n = 90): string => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// The status dot + word for the pane status line. Running animates via the injected `frame`.
const statusDot = (s: OrchNode["status"]): string => (s === "error" ? "✗" : s === "done" ? "✓" : "●")
const statusWord = (s: OrchNode["status"]): string => (s === "error" ? "Error" : s === "done" ? "Done" : "Running")
const statusColor = (s: OrchNode["status"]): string => (s === "error" ? theme.error : s === "done" ? theme.ok : theme.busy)

// One Activity row = one tool CALL one-liner: glyph-free "Bash(cmd)" / "Read(path)" with args
// truncated, NEVER the output. A failed call is marked ✗ (red); a still-running one shows "·
// running"; a settled one stays muted. The OUTPUT is a further drill-down, not shown here.
function ActivityRow({ m }: { m: ToolMsg }) {
  const failed = m.status === "error"
  const tag = failed ? "✗ " : m.status === "running" ? "· " : "  "
  const color = failed ? theme.error : theme.subtext
  return (
    <text fg={color} selectable={false}>
      <span fg={failed ? theme.error : theme.faint}>{tag}</span>
      <span fg={color}>{oneLine(toolLabel(m.name, m.args), 64)}</span>
      {m.status === "running" ? <span fg={theme.dim}>{"  running"}</span> : null}
    </text>
  )
}

// STATUS LINE: "<dot> <Status> · <phase>" — the node's live status + its agentType/phase descriptor.
function StatusLine({ node, frame }: { node: OrchNode; frame: string }) {
  const dot = node.status === "running" ? frame : statusDot(node.status)
  const phase = node.phase && node.phase !== node.label ? node.phase : ""
  return (
    <text fg={statusColor(node.status)} selectable={false}>
      <span fg={statusColor(node.status)}>{`${dot} ${statusWord(node.status)}`}</span>
      {phase ? <span fg={theme.muted}>{`  ·  ${oneLine(phase, 48)}`}</span> : null}
      {node.retry ? <span fg={theme.warning}>{`  ·  ${oneLine(node.retry, 48)}`}</span> : null}
    </text>
  )
}

// COST LINE: "<tok> tok · <N> tool calls" (+ ✗ N failed when any tool failed).
function CostLine({ tokens, total, failed }: { tokens: number | undefined; total: number; failed: number }) {
  const hasTok = typeof tokens === "number" && tokens > 0
  return (
    <text fg={theme.muted} selectable={false}>
      {hasTok ? <span fg={theme.muted}>{fmtTokens(tokens!)}</span> : null}
      {hasTok && total > 0 ? <span fg={theme.dim}>{"  ·  "}</span> : null}
      {total > 0 ? <span fg={theme.muted}>{`${total} tool call${total === 1 ? "" : "s"}`}</span> : null}
      {failed > 0 ? <span fg={theme.error}>{`  ·  ✗ ${failed} failed`}</span> : null}
    </text>
  )
}

// The detail pane for ONE selected node. Rendered inline under the tree by the caller; here we own
// the content. `node` is the live OrchNode (full fields); `frame` animates a running dot. Pure
// presentation — no state, no IO. The Activity is the windowed TAIL of tool CALLS, NEVER output.
export function NodeDetail({ node, frame }: { node: OrchNode; frame: string }) {
  const tools = node.tools ?? []
  const total = tools.length
  const shown = tools.slice(Math.max(0, total - ACTIVITY_WINDOW))
  const showResult = node.status === "done" && Boolean(node.result)
  return (
    <box flexDirection="column" border={["left"]} borderColor={theme.focus} style={{ marginTop: 1, paddingLeft: 1 }}>
      {/* TITLE: the node label (accent) so the pane reads as "this node's detail". */}
      <text fg={theme.accent} selectable={false}>{node.label}</text>
      <StatusLine node={node} frame={frame} />
      <CostLine tokens={node.tokens} total={total} failed={node.failedTools ?? 0} />
      {/* LIVE STREAM (F8 per-node): while a node forwards with stream:true, its transient streamed
          text grows here (atoms growNode) and shows as a live tail — isolated from the main
          transcript. Cleared to `result` once the node settles, so it only renders WHILE running. */}
      {node.status === "running" && node.liveText ? (
        <text fg={theme.subtext} selectable={false}>{oneLine(node.liveText, 80)}</text>
      ) : null}
      {/* RESULT (settled, non-error): a single muted line — the node's human payload, clamped. */}
      {showResult ? <text fg={theme.subtext} selectable={false}>{oneLine(node.result!, 80)}</text> : null}
      {/* ACTIVITY: "last N of M tool calls" header + the windowed tail of CALL one-liners. */}
      {total > 0 ? (
        <box flexDirection="column" style={{ marginTop: 1 }}>
          <text fg={theme.dim} selectable={false}>{`Activity · last ${shown.length} of ${total} tool call${total === 1 ? "" : "s"}`}</text>
          {shown.map((m) => (
            <ActivityRow key={m.id} m={m} />
          ))}
        </box>
      ) : null}
    </box>
  )
}
