// MESSAGE CARDS — the per-turn transcript chrome, extracted from chat.tsx so the card look
// (opencode session/index.tsx:1424-1637, ported Solid→React) lives in one file and chat.tsx
// stays under budget. Three cards:
//   - <UserCard>: the user message — a left-border accent card, paddingLeft=2 (opencode
//     UserMessage :1457-1476: border=["left"], borderColor=agent-color, paddingLeft=2).
//   - <AssistantReply>: the assistant reply — content paddingLeft=3 / marginTop=1, then a
//     "▣ model · duration" footer line (opencode AssistantMessage :1612-1634). The reply body
//     is the PART_MAPPING text part; thinking is the reasoning part (rendered by <ThinkingPart>).
//   - <ErrorCard>: an errored/interrupted reply — a RED left-border card (opencode :1595-1609
//     borderColor=theme.error), so a failure is unmissable instead of painted success-green.
//
// PART_MAPPING dispatch (opencode :1556-1570/:1640): the assistant card walks its parts and
// dispatches each by type → component. rlmcode's Turn carries the assistant content as a small,
// fixed part list (reasoning? + text), so AssistantReply renders the dispatch inline rather
// than mapping a dynamic Part[] — same shape (reasoning above text, footer after), no Solid
// <Dynamic>. The tool parts stay in chat.tsx's step stream (grouped + collapsible there).
import { useState } from "react"
import { TextAttributes } from "@opentui/core"
import { theme } from "./theme.ts"

const INDENT = 2 // transcript nesting (matches chat.tsx INDENT)

// opencode Locale.duration (util/locale.ts:39): ms → a compact "Ns"/"Nms"/"Nm Ns" label for the
// reasoning summary. The reasoning's wall-clock = the turn's wall-clock (meta.ms) — the model
// reasons then answers within the one turn — so we read that for the settled "Thought · 1.2s".
const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

// "▣ model · duration" footer (opencode AssistantMessage :1612-1634). Pure string so the
// frame gate reads it identically. The model is the per-turn meta.model; duration is the
// wall-clock the turn took. Extra provenance (tokens / finishReason / budget) rides after.
export const assistantFooter = (
  m: { readonly model: string; readonly ms: number; readonly tokens?: number | undefined; readonly finishReason?: string | undefined; readonly budget: boolean },
  fmtTokens: (n: number) => string,
): string => {
  const parts: string[] = [m.model, `${(m.ms / 1000).toFixed(1)}s`]
  if (typeof m.tokens === "number") parts.push(fmtTokens(m.tokens))
  if (m.finishReason && m.finishReason !== "stop") parts.push(m.finishReason === "length" ? "truncated (max tokens)" : m.finishReason)
  if (m.budget) parts.push("stopped: step budget — answer may be incomplete")
  return parts.join(" · ")
}

// USER CARD — left-border accent card, paddingLeft=2 (opencode UserMessage :1457-1476). The
// whole prompt sits inside the card; the accent border + indent reads as "you said".
export function UserCard({ text }: { text: string }) {
  return (
    <box border={["left"]} borderColor={theme.accent} style={{ paddingLeft: INDENT, width: "100%" }}>
      <text fg={theme.text}>{text}</text>
    </box>
  )
}

// THINKING (reasoning part of the assistant message): the model's reasoning_content. The
// PART_MAPPING reasoning part, ported from opencode's ReasoningPart + ReasoningHeader
// (session/index.tsx:1584-1689) with the COLLAPSE behavior:
//   - WHILE the turn is in flight (settled=false): the reasoning is live — render it OPEN, dim +
//     italic, headed by a "Thinking…" spinner-less label (it streams in place; no toggle yet).
//   - ONCE SETTLED: collapse to a single clickable header line "▸ Thought · <duration>"; the body
//     (the full reasoning) hides until the row is expanded → "▾ Thought · <duration>". Default
//     COLLAPSED so the settled transcript stays compact and the layout never shifts. `durationMs`
//     is the turn wall-clock (meta.ms) — the reasoning's duration summary opencode shows.
// Nothing renders when there's no reasoning.
export function ThinkingPart({ thinking, settled, durationMs }: { thinking: string | undefined; settled: boolean; durationMs: number | undefined }) {
  const [expanded, setExpanded] = useState(false)
  if (thinking === undefined || thinking.length === 0) return null
  // LIVE: still thinking — show it open, no toggle (it's actively streaming in).
  if (!settled) {
    return (
      <box flexDirection="column" style={{ marginTop: 1, paddingLeft: INDENT }}>
        <text fg={theme.busy}>{"Thinking…"}</text>
        <text fg={theme.faint} attributes={TextAttributes.ITALIC}>{thinking}</text>
      </box>
    )
  }
  // SETTLED: a collapsible "Thought" block — header toggles, body shows only when expanded.
  const dur = typeof durationMs === "number" ? ` · ${fmtDuration(durationMs)}` : ""
  return (
    <box flexDirection="column" style={{ marginTop: 1, paddingLeft: INDENT }}>
      <text fg={theme.muted} selectable={false} onMouseDown={(() => setExpanded((v) => !v)) as any}>
        {`${expanded ? "▾" : "▸"} Thought${dur}`}
      </text>
      {expanded ? (
        <box flexDirection="column" style={{ paddingLeft: INDENT }}>
          <text fg={theme.faint} attributes={TextAttributes.ITALIC}>{thinking}</text>
        </box>
      ) : null}
    </box>
  )
}

// ASSISTANT REPLY — the text part + the "▣ model · duration" footer. Content is at
// paddingLeft=3 / marginTop=1 (opencode AssistantMessage content :1556-1570 + :1612). While
// streaming, render plain text + █ cursor (markdown mid-stream is janky); markdown once
// settled. An errored/interrupted reply ("⚠ …") routes to <ErrorCard> by the caller, not here.
export function AssistantReply({
  text,
  meta,
  streaming,
  fmtTokens,
  renderBody,
}: {
  text: string
  meta: { readonly model: string; readonly ms: number; readonly tokens?: number | undefined; readonly finishReason?: string | undefined; readonly budget: boolean } | undefined
  streaming: boolean
  fmtTokens: (n: number) => string
  // Markdown renderer injected by chat.tsx (carries its shared SyntaxStyle), so this file
  // stays free of the renderer's <markdown> + style wiring.
  renderBody: (content: string, streaming: boolean) => React.ReactNode
}) {
  // No leading marker — the reply body renders straight at paddingLeft=3 (aligned with the
  // thinking + footer), not pushed in behind a ⏺/▣ badge. Cleaner, opencode-plain.
  // LIVE markdown: render the body through the streaming markdown renderer the WHOLE time —
  // opentui's <markdown streaming> (wired in renderBody) re-parses incrementally as the text
  // grows and tolerates incomplete markdown (open code fences / half tables), so the reply
  // renders as MARKDOWN live, not plain-text-then-reflow. (opencode session/index.tsx:1761.)
  return (
    <box flexDirection="column" style={{ marginTop: 1, paddingLeft: 3 }}>
      {renderBody(text, streaming)}
      {meta && (
        <box style={{ marginTop: 1 }}>
          <text fg={meta.budget ? theme.busy : theme.muted}>{assistantFooter(meta, fmtTokens)}</text>
        </box>
      )}
    </box>
  )
}

// ERROR CARD — an errored / interrupted reply (atoms catchCause surfaces a "⚠ …" reply). A RED
// left-border card (opencode AssistantMessage error :1595-1609 borderColor=theme.error),
// paddingLeft=2, marginTop=1 — so a failure is unmissable, not painted success-green.
export function ErrorCard({ text }: { text: string }) {
  return (
    <box
      flexDirection="column"
      border={["left"]}
      borderColor={theme.error}
      style={{ marginTop: 1, paddingLeft: INDENT, width: "100%" }}
    >
      <text fg={theme.error}>{text}</text>
    </box>
  )
}
