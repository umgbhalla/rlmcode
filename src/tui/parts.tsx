// PART MODEL + PART_RENDER REGISTRY (A1 — the SPINE). opencode models an Assistant message as an
// interleaved `AssistantContent[]` tagged union (Text|Reasoning|Tool) dispatched through a
// `PART_MAPPING[type]` registry (message-part.tsx:189/:1273); a sub-agent is a `task` tool part
// (§9). rlmcode used to hand-promote `final`/`thinking` out of a flat `steps[]` and render the
// turn body as an ad-hoc inline sequence (ThinkingPart → items.map(ToolGroupView) → AssistantReply
// → WorkflowPart) in chat.tsx's TurnView. This file replaces that ad-hoc sequence with a STRUCTURED
// `Part[]` (assembled ONCE in chat-model.toTurns) + a `PART_RENDER` registry keyed on `kind`.
//
// CRITICAL — RENDER BYTE-IDENTICAL: A1 is a DATA + DISPATCH refactor, NOT a look change. Each
// renderer below emits the EXACT JSX the old inline TurnView did, in the same order, so every
// captured frame (transcript / tool-grouping / assembly / thinking-streaming / node-tree) stays
// byte-identical. The part array is positional-ordered exactly like the old render: reasoning
// (thinking) → context-group/tool/text steps (the groupSteps `items`) → the final text reply →
// the task (workflow). `toTurns` builds it; TurnView maps it through PART_RENDER[kind].
import type { ReactNode } from "react"
import type { Row as OrchRow } from "./orch-tree.ts"
import { fmtTokens, groupSummary, oneLine, type Part, type StepItem } from "./chat-model.ts"
import { AssistantReply, ErrorCard, ThinkingPart } from "./messages.tsx"
import { ToolView } from "./tool-view.tsx"
import { theme } from "./theme.ts"
import { WorkflowPart } from "./workflow.tsx"

// THE PART UNION (opencode AssistantContent[] mapped onto rlmcode) is defined in chat-model.ts (the
// DATA layer, no JSX) — this file owns the RENDERERS. A turn's render body is an ordered Part[]
// (chat-model.Part) — each kind independently addressable + dispatched through PART_RENDER[kind]:
//   - reasoning : the model's reasoning_content (the old `thinking` field) → ThinkingPart.
//   - tool      : ONE assembly-grouped step unit (a tool row OR a collapsed explore group OR a
//                 narration line) — the `StepItem` from groupSteps, rendered by the shared step
//                 dispatch (renderStepItem) so the look is identical to the old ToolGroupView.
//   - text      : the assistant reply prose (the old promoted `final`) + the model·duration footer,
//                 OR — when the reply is an interrupted/errored "⚠ …" — the red ErrorCard.
//   - task      : a sub-agent fan-out — the orch tree OWNED by this turn (the old `Turn.workflow`),
//                 rendered by the EXISTING compact tree + detail pane (WorkflowPart), unchanged.

// The per-render context the registry threads into the renderers — the live focus/expansion +
// layout + injected closures TurnView used to thread inline. Kept as one object so a new part kind
// reads only what it needs (and the registry signature stays stable as kinds are added).
export type PartCtx = {
  readonly expTools: Set<string>
  readonly focusedKey: string | undefined
  readonly cols: number
  readonly perToolBudget: number
  readonly frame: string
  readonly syntaxStyle: unknown
  readonly detailKey: string | null
  readonly onToggleTool: (id: string) => void
  readonly renderNode: (row: OrchRow) => ReactNode
  readonly renderBody: (content: string, streaming: boolean) => ReactNode
}

// TOOL-GROUP UNIT (W3.1, fixes F2/F3): renders ONE assembly-time StepItem — a collapsed explore
// GROUP as the single "⊙ explored N (…)" summary row, a TOOL step as the bounded ToolView, or a
// narration line. The grouping authority (toolui.groupSteps) is run ONCE at assembly (toTurns →
// t.items), so this is pure presentation over the already-grouped unit; the SAME unit shape is what
// the node Activity reuses, so a node's explore run renders identically to a turn's. (Moved here
// verbatim from chat.tsx's ToolGroupView so the part registry owns the step dispatch.)
const renderStepItem = (it: StepItem, ctx: PartCtx): ReactNode => {
  if (it.kind === "group") return <text fg={theme.dim}>{`⊙ ${groupSummary(it.tools)}`}</text>
  const s = it.m
  if (s.kind === "tool")
    return (
      <ToolView
        m={s}
        expanded={ctx.expTools.has(s.id)}
        focused={ctx.focusedKey === `tool:${s.id}`}
        cols={ctx.cols}
        bodyBudget={ctx.perToolBudget}
        frame={ctx.frame}
        syntaxStyle={ctx.syntaxStyle}
        onToggle={() => ctx.onToggleTool(s.id)}
      />
    )
  return <text fg={theme.subtext}>{`· ${oneLine(s.text)}`}</text>
}

// PART_RENDER — the dispatch registry keyed on `kind` (opencode PART_MAPPING[type], message-part.tsx
// :189). A new part kind is added by registering a renderer here, never by editing a switch in
// TurnView. Each renderer emits the EXACT JSX the old inline TurnView did (byte-identical render).
type PartRender = (part: Part, ctx: PartCtx) => ReactNode
export const PART_RENDER: Record<Part["kind"], PartRender> = {
  // REASONING (opencode ReasoningPartDisplay) → ThinkingPart (the collapsible "▸ Thought" block).
  reasoning: (part, _ctx) =>
    part.kind === "reasoning" ? <ThinkingPart thinking={part.thinking} settled={part.settled} durationMs={part.durationMs} /> : null,
  // TOOL → the shared assembly-grouped step dispatch (ToolView / explore group / narration).
  tool: (part, ctx) => (part.kind === "tool" ? renderStepItem(part.item, ctx) : null),
  // TEXT → the assistant reply card (AssistantReply with the model·duration footer) OR, when the
  // reply is an interrupted/errored "⚠ …", the red ErrorCard (carrying the tool-row red convention
  // up to the final reply so a failure isn't painted success-green). Mirrors TurnView's old branch.
  text: (part, ctx) =>
    part.kind === "text"
      ? part.failed
        ? <ErrorCard text={part.text} />
        : (
            <AssistantReply
              text={part.text}
              meta={part.meta}
              streaming={part.streaming}
              fmtTokens={fmtTokens}
              renderBody={ctx.renderBody}
            />
          )
      : null,
  // TASK (opencode `task` tool part, §9) — a sub-agent fan-out. The orch tree DESCENDS one level:
  // it is the body of this part, rendered by the EXISTING compact tree + detail pane (WorkflowPart),
  // unchanged. (Today a turn carries at most one task part — the session orch attached by toTurns.)
  task: (part, ctx) =>
    part.kind === "task"
      ? (
          <WorkflowPart
            orch={part.orch}
            rows={part.rows}
            fmtTokens={fmtTokens}
            indent={INDENT_PARTS}
            detailKey={ctx.detailKey}
            frame={ctx.frame}
            renderRow={ctx.renderNode}
          />
        )
      : null,
}

// Single source of truth for the task-part indent (the old TurnView passed INDENT from chat-model).
// Kept here so parts.tsx doesn't reach back into chat.tsx; matches chat-model.INDENT (2).
const INDENT_PARTS = 2

// A stable key for a rendered part (React list key). reasoning/text/task carry a fixed id; a tool
// part keys on its grouped unit exactly as the old TurnView items.map key did (group summary / tool
// id / narration text) so the list reconciliation is unchanged.
export const partKey = (part: Part): string => {
  switch (part.kind) {
    case "reasoning":
      return part.id
    case "text":
      return part.id
    case "task":
      return part.id
    case "tool":
      return part.item.kind === "group"
        ? `g:${groupSummary(part.item.tools)}`
        : part.item.m.kind === "tool"
          ? part.item.m.id
          : `narr:${oneLine(part.item.m.text)}`
  }
}
