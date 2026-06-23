// MATURE TOOL RENDER — the per-tool transcript chrome, extracted from chat.tsx (opencode
// session/index.tsx:1714-2534 ToolPart + the per-tool components, ported Solid→React) so the
// status-conditional render + the per-tool bodies + the output-collapse live in ONE file and
// chat.tsx stays under budget. THREE render modes, chosen by a pure PART_MAPPING-style dispatch
// (toolui.toolRenderMode):
//   - INLINE (running / no-output): a single dim line — glyph + label + summary, NO body, NO
//     expander (opencode InlineTool). A running tool animates its spinner frame + elapsed.
//   - BLOCK (settled, has output): the header line PLUS an expandable body — a synthesized
//     <diff> for edit/write, else the per-tool preview COLLAPSED to the first N lines + a
//     "+N more" affordance (opencode BlockTool + collapseToolOutput; Shell keeps 10 lines,
//     others 3). Click / Enter on the focused row toggles the full body.
//   - ERROR: a RED left-border card (opencode the error branch) so a failure is unmissable.
// Per-tool DETAIL (toolui.toolDetail) rides the header for the high-signal tools — Shell shows
// its workdir + a non-zero exit, Read shows the line count loaded — matching opencode's Shell /
// Read renderers. The node-tree (orch-tree.ts) is the SUBAGENT/Task surface (a node IS a
// sub-agent: its status glyph + retry-on-error + token badge already render there); this file
// owns the leaf TOOL rows the subagent and the main turn both produce.
import { useState } from "react"
import { theme } from "./theme.ts"
import type { Msg } from "./atoms.ts"
import {
  collapseMax,
  type PreviewLine,
  toolDetail,
  toolDiff,
  toolHasBody,
  toolIcon,
  toolLabel,
  toolPreview,
  toolRenderMode,
  toolSummary,
} from "./toolui.ts"

type ToolMsg = Extract<Msg, { kind: "tool" }>

const INDENT = 2 // transcript nesting (matches chat.tsx INDENT)

// Whole-second elapsed since a wall-clock start (undefined start -> 0). Recomputed each render
// (the busy tick re-renders ~12×/s while a tool runs, so a running tool's "running 12s" advances).
const elapsedSec = (startedAt: number | undefined): number =>
  typeof startedAt === "number" ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0

const statusColor = (status: ToolMsg["status"]): string =>
  status === "error" ? theme.error : status === "ok" ? theme.ok : theme.muted
const previewColor = (tone: PreviewLine["tone"]): string => (tone === "add" ? theme.ok : tone === "del" ? theme.error : theme.dim)
const previewSign = (tone: PreviewLine["tone"]): string => (tone === "add" ? "+" : tone === "del" ? "-" : "│")

// Keyboard-focus gutter: a leading "❯ " ONLY when this row is the Tab-ring focus (never on mere
// hover) — keyboard focus visually distinct from a mouse-over. Two cells wide so focused/unfocused
// rows stay column-aligned.
export const FocusGutter = ({ focused }: { focused: boolean }) =>
  focused ? <span fg={theme.focus}>{"❯ "}</span> : <span fg={theme.faint}>{"  "}</span>

// The header line — glyph + label + per-tool summary + (settled) per-tool DETAIL + ▾/▸. A running
// tool shows the live spinner frame + elapsed; the format is the contract the frame gates assert
// (`✗ Bash(missing-bin)  error`, `→ Read(src/auth.ts)`), so the glyph/label/summary order is fixed.
// `canExpand` = the body OVERFLOWS its collapsed cap (so a ▾/▸ "show more / less" is offered);
// a body that fits the cap shows in full with no expander (nothing to reveal).
function ToolHeader({ m, expanded, canExpand, focused, frame, onToggle }: { m: ToolMsg; expanded: boolean; canExpand: boolean; focused: boolean; frame: string; onToggle: () => void }) {
  const [hover, setHover] = useState(false)
  const running = m.status === "running"
  const isError = m.status === "error"
  const color = statusColor(m.status)
  const mark = running ? frame : isError ? "✗" : toolIcon(m.name)
  const el = running ? elapsedSec(m.startedAt) : 0
  const summary = running ? (el > 0 ? `running ${el}s` : "running…") : toolSummary(m.name, m.result, isError)
  const detail = running ? "" : toolDetail(m.name, m.args, m.result, isError)
  const hot = canExpand && (hover || focused) // hover OR keyboard-focused -> brighten
  return (
    <text
      fg={color}
      selectable={false}
      onMouseDown={(canExpand ? onToggle : undefined) as any}
      onMouseOver={(canExpand ? (() => setHover(true)) : undefined) as any}
      onMouseOut={(() => setHover(false)) as any}
    >
      <FocusGutter focused={focused} />
      <span fg={hot ? theme.white : color}>{`${mark} `}</span>
      <span fg={hot ? theme.white : theme.text}>{toolLabel(m.name, m.args)}</span>
      <span fg={hot ? theme.subtext : theme.faint}>{`  ${summary}`}</span>
      {detail ? <span fg={hot ? theme.subtext : theme.muted}>{`  ${detail}`}</span> : null}
      {canExpand ? <span fg={hot ? theme.text : theme.muted}>{expanded ? "  ▾" : "  ▸"}</span> : null}
    </text>
  )
}

// The BODY of a settled tool — shown by DEFAULT (opencode BlockTool always renders its output),
// COLLAPSED to the first collapseMax(name) lines (Shell 10, others 3) with a "… +M more" footer;
// the row's expander then reveals the full output. A file mutation (edit/write) renders the
// synthesized unified diff through opentui's native <diff> (split when wide, else unified) — a
// diff is already minimal, so it's never line-collapsed.
function ToolBody({ m, isError, expanded, cols, syntaxStyle }: { m: ToolMsg; isError: boolean; expanded: boolean; cols: number; syntaxStyle: unknown }) {
  const diff = toolDiff(m.name, m.args, isError)
  if (diff) {
    return (
      <box style={{ paddingLeft: INDENT, paddingTop: 1 }}>
        <diff diff={diff.diff} view={cols > 120 ? "split" : "unified"} filetype={diff.filetype} showLineNumbers syntaxStyle={syntaxStyle as any} />
      </box>
    )
  }
  // COLLAPSE (single authority): collapsed → cap to collapseMax(name) lines; toolPreview's
  // headLines appends the "… +M more" line itself. Expanded → a large cap shows the full body.
  const max = expanded ? Number.MAX_SAFE_INTEGER : collapseMax(m.name)
  const preview = toolPreview(m.name, m.args, m.result, isError, Math.max(20, cols - 10), max)
  return (
    <box flexDirection="column" style={{ paddingLeft: INDENT }}>
      {preview.map((p, i) => (
        <text key={i} fg={previewColor(p.tone)}>{`${previewSign(p.tone)} ${p.text}`}</text>
      ))}
    </box>
  )
}

// Whether the tool's full body OVERFLOWS its collapsed cap — i.e. there's MORE to reveal, so the
// row offers a ▾/▸ expander. A diff is always "expandable" (the body is the diff, shown in full,
// but kept under the drill-down to stay compact). Pure: counts the full-cap preview's real lines
// (headLines appends no synthetic "… +N" line at the large cap) against collapseMax.
const bodyOverflows = (m: ToolMsg, isError: boolean, cols: number): boolean => {
  if (toolDiff(m.name, m.args, isError)) return true
  const full = toolPreview(m.name, m.args, m.result, isError, Math.max(20, cols - 10), Number.MAX_SAFE_INTEGER)
  return full.length > collapseMax(m.name)
}

// One tool row — the status-conditional render (opencode ToolPart, session/index.tsx:1714-2202).
// `toolRenderMode` (the pure PART_MAPPING-style dispatch) picks the mode:
//   - inline → a dim one-line header, NO body (a RUNNING or no-output tool);
//   - block  → header + a COLLAPSED body (first N lines + "… +M more"), expandable to full;
//   - error  → a RED left-border card: header + the (collapsed) error body.
export function ToolView({ m, expanded, focused, cols, frame, syntaxStyle, onToggle }: {
  m: ToolMsg
  expanded: boolean
  focused: boolean
  cols: number
  frame: string
  // the shared SyntaxStyle for the native <diff> (chat.tsx mdStyle), passed in so this file stays
  // free of the theme.makeSyntaxStyle wiring (same seam messages.tsx uses for renderBody).
  syntaxStyle: unknown
  onToggle: () => void
}) {
  const isError = m.status === "error"
  const mode = toolRenderMode(m.name, m.status, m.result)
  const showBody = mode === "block" || (mode === "error" && toolHasBody(m.name, m.result, true))
  const canExpand = showBody && bodyOverflows(m, isError, cols)
  const header = <ToolHeader m={m} expanded={expanded} canExpand={canExpand} focused={focused} frame={frame} onToggle={onToggle} />
  const body = (
    <>
      {header}
      {showBody ? <ToolBody m={m} isError={isError} expanded={expanded} cols={cols} syntaxStyle={syntaxStyle} /> : null}
    </>
  )
  // ERROR CARD: a failed tool gets a RED left-border card (not a dim one-liner) so a failure is
  // unmissable. Two concrete boxes — a conditional-undefined `border` prop trips
  // exactOptionalPropertyTypes, and `as const` makes the array readonly (BorderSides[] is mutable).
  return mode === "error" ? (
    <box flexDirection="column" border={["left"]} borderColor={theme.error} style={{ marginTop: showBody ? 1 : 0, paddingLeft: 1 }}>
      {body}
    </box>
  ) : (
    <box flexDirection="column" style={{ marginTop: showBody ? 1 : 0 }}>
      {body}
    </box>
  )
}
