// opentui (React) chat, inline mode. Interactive, collapsible transcript:
//   - each turn shows user + final reply; the middle steps (tools + narration)
//     collapse by default. In-progress turns auto-expand so you watch it work.
//   - per-tool rows expand to a tool-specific detail body (edits render a real
//     <diff>); cheap reads/searches whose summary says it all get no expander.
//   list view : ↑/↓ move, Enter open, n new, q quit
//   chat view : type + Enter send · shift+Enter newline · ↑/↓ history (empty)
//               · PgUp/PgDn/Home/End scroll · click a ▸/▾ to expand
//               · Esc back (idle) / Esc-twice interrupt (busy) · select to copy
import { RegistryProvider, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { createCliRenderer, decodePasteBytes } from "@opentui/core"
import { createRoot, useBlur, useFocus, useKeyboard, useSelectionHandler, useTerminalDimensions } from "@opentui/react"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { abortTurn } from "../app/default-agent.ts"
import { appAtom, busyAtom, busySessionsAtom, deleteSessionAtom, MODEL, newSessionAtom, sendAtom } from "./atoms.ts"
import { copyToClipboard } from "./clipboard.ts"
import { history } from "./history.ts"
import { makeSyntaxStyle, theme } from "./theme.ts"
import { ThemeProvider, useTheme, useThemeSwitcher } from "./theme-context.tsx"
import { FocusGutter, ToolView } from "./tool-view.tsx"
import { type Row as OrchRow } from "./orch-tree.ts"
import { ActionBar, shortCwd } from "./shell.tsx"
import { Composer, useComposerFocus } from "./composer.tsx"
import { AssistantReply, ErrorCard, QueuedCard, ThinkingPart, UserCard } from "./messages.tsx"
import { useMessageQueue } from "./queue.ts"
import { type Option, useDialogSelect } from "./dialog-select.tsx"
import { type AcItem, Autocomplete, useAutocomplete } from "./autocomplete.tsx"
import { type Command, Palette } from "./palette.tsx"
import { MODELS, type ModelName } from "../app/default-agent.ts"
import { DialogOverlays, printableChar, useDialogs } from "./dialogs.tsx"
import { WhichKey } from "./which-key.tsx"
import { activeBindings, type Bind, dispatch, type KeyEventLike, matchesChord, useModeStack } from "./keys.ts"
import { activeRetry, orchFocusables, WorkflowPart, workflowRows } from "./workflow.tsx"
import { turnPropsEqual } from "./turn-memo.ts"
import { List, NewPill, SessionHeader } from "./header.tsx"
import { fmtTokens, groupSummary, groupSteps, INDENT, navKeyName, oneLine, sessionTokens, SPIN_FRAMES, statusBar, toTurns, toolsUsed, type Turn } from "./chat-model.ts"

// The shared syntax style for the reply <markdown> + the tool <diff> is built INSIDE App via
// useMemo keyed on the active theme name (theme.ts makeSyntaxStyle over the LIVE palette), so a
// theme switch rebuilds it (the SyntaxStyle captures hex at registerStyle time — it can't auto-
// update on the in-place palette mutation). It's threaded into TurnView as a prop (and into NodeRow
// via the renderNode closure), and is part of the memo comparator so a settled turn recolors on a
// switch (a new style identity) but NOT on the busy tick (a stable identity across ticks).

// Enter submits, Shift+Enter inserts a newline (override textarea defaults, which
// are Enter=newline / Cmd+Enter=submit).
const inputKeys = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
] as any

// Animated working state for the input placeholder. Ticks only while busy; the
// frame + elapsed seconds read as a little idle→working→done state machine right
// on the prompt's left edge (no transcript dangle).
function useWorking(busy: boolean): { frame: string; elapsed: number } {
  const [tick, setTick] = useState(0)
  const startRef = useRef(0)
  useEffect(() => {
    if (!busy) return
    startRef.current = Date.now()
    setTick(0)
    const t = setInterval(() => setTick((x) => x + 1), 80)
    return () => clearInterval(t)
  }, [busy])
  return { frame: SPIN_FRAMES[tick % SPIN_FRAMES.length]!, elapsed: busy ? Math.floor((Date.now() - startRef.current) / 1000) : 0 }
}

// The keyboard-focus gutter (FocusGutter) + the per-tool row (ToolView, with the matured
// inline-vs-block + per-tool detail + output-collapse) live in tool-view.tsx, imported above —
// TurnView + NodeRow render the SAME ToolView for the main turn's steps and a node's owned tools.

// STATIC-COMMIT (claude_code): TurnView is wrapped in React.memo with the turnPropsEqual
// comparator (turn-memo.ts) so a SETTLED turn does NOT repaint on the ~12×/s busy tick — only
// the in-flight turn + the composer redraw. TurnViewImpl is the unchanged render; the memo is a
// pure perf wrapper (no logic/shape change). Below, `export const TurnView = memo(...)`.
function TurnViewImpl({
  t,
  first,
  expanded,
  expTools,
  expNodes,
  focusedKey,
  cols,
  frame,
  syntaxStyle,
  onToggleTurn,
  onToggleTool,
  renderNode,
}: {
  t: Turn
  first: boolean
  expanded: boolean
  expTools: Set<string>
  expNodes: ReadonlySet<string>
  focusedKey: string | undefined
  cols: number
  frame: string
  // The shared SyntaxStyle (App rebuilds it on a theme switch); threaded in so a settled turn
  // recolors on a switch (a new identity flows through the memo comparator) but not on the busy tick.
  syntaxStyle: unknown
  onToggleTurn: () => void
  onToggleTool: (id: string) => void
  // INLINE NODE-TREE: App injects the node-row renderer (NodeRow, which owns the per-node
  // ToolView + expansion/focus wiring) so WorkflowPart can hang the tree under this turn.
  renderNode: (row: OrchRow) => React.ReactNode
}) {
  const [hoverSteps, setHoverSteps] = useState(false)
  const stepsFocused = focusedKey === `turn:${t.idx}`
  // An interrupted / errored turn surfaces as a "⚠ …" reply (atoms.ts catchCause). Carry
  // the tool-row red convention up to the final reply so failure isn't painted success-green.
  const failed = t.final !== null && t.final.startsWith("⚠")
  return (
    <box flexDirection="column" style={{ marginTop: first ? 0 : 1 }}>
      <UserCard text={t.user} />
      {t.steps.length > 0 && (
        <box flexDirection="column" style={{ paddingLeft: INDENT }}>
          <text
            fg={hoverSteps || stepsFocused ? theme.text : theme.muted}
            selectable={false}
            onMouseDown={onToggleTurn as any}
            onMouseOver={(() => setHoverSteps(true)) as any}
            onMouseOut={(() => setHoverSteps(false)) as any}
          >
            <FocusGutter focused={stepsFocused} />
            {`${expanded ? "▾" : "▸"} ${t.steps.length} step${t.steps.length > 1 ? "s" : ""}`}
            {!expanded ? `   ${toolsUsed(t.steps)}` : ""}
          </text>
          {expanded && (
            <box flexDirection="column" style={{ paddingLeft: INDENT }}>
              {groupSteps(t.steps).map((it, i) => {
                if (it.kind === "group") return <text key={`g${i}`} fg={theme.dim}>{`⊙ ${groupSummary(it.tools)}`}</text>
                const s = it.m
                if (s.kind === "tool")
                  return (
                    <ToolView
                      key={s.id}
                      m={s}
                      expanded={expTools.has(s.id)}
                      focused={focusedKey === `tool:${s.id}`}
                      cols={cols}
                      frame={frame}
                      syntaxStyle={syntaxStyle}
                      onToggle={() => onToggleTool(s.id)}
                    />
                  )
                return <text key={i} fg={theme.subtext}>{`· ${oneLine(s.text)}`}</text>
              })}
            </box>
          )}
        </box>
      )}
      {/* ASSISTANT CARD (PART_MAPPING dispatch, opencode :1556-1637 ported): reasoning part →
          ThinkingPart, then text part → AssistantReply (with the "▣ model · duration" footer)
          OR, when the reply is an interrupted/errored "⚠ …", the red ErrorCard instead. The
          reasoning is SETTLED once the turn stops streaming; its duration = the turn wall-clock. */}
      <ThinkingPart thinking={t.thinking} settled={!(t.streaming ?? false)} durationMs={t.meta?.ms} />
      {t.final !== null && !(t.final === "" && (t.streaming ?? false)) ? (
        failed ? (
          <ErrorCard text={t.final} />
        ) : (
          <AssistantReply
            text={t.final}
            meta={t.meta}
            streaming={t.streaming ?? false}
            fmtTokens={fmtTokens}
            renderBody={(content, streaming) => <markdown content={content} syntaxStyle={syntaxStyle as any} streaming={streaming} internalBlockMode="top-level" />}
          />
        )
      ) : null}
      {/* INLINE NODE-TREE (opencode-ux-blueprint Option B): a workflow turn renders its
          orchestration node-tree HERE, right after the reply — so the fan-out reads as part
          of THIS turn's answer. A non-workflow turn carries no `workflow` ⇒ no block. */}
      {t.workflow && (
        <WorkflowPart
          orch={t.workflow}
          rows={workflowRows(t.workflow, expNodes)}
          fmtTokens={fmtTokens}
          indent={INDENT}
          renderRow={renderNode}
        />
      )}
    </box>
  )
}

// STATIC-COMMIT: the memoized TurnView the transcript actually renders. turnPropsEqual
// (turn-memo.ts) skips the re-render for a SETTLED turn whose render-relevant inputs (content,
// cols, first, and the focus/expansion state scoped to its OWN rows) are unchanged — so the
// busy-tick `frame` prop (the spinner, ~12×/s) can't repaint settled scrollback. The in-flight
// turn is never settled, so it always re-renders; the comparator is a pure perf wrapper.
const TurnView = memo(TurnViewImpl, turnPropsEqual)

// Orchestration node tree (orch.emit) as a VELOCITY UNICODE TREE: pure flatten()
// (src/tui/orch-tree.ts) walks roots→children and precomputes each node's ├─/└─/│
// connector prefix; here we render one <text> per Row plus that node's OWNED tool
// steps hung under its continuation stem. Collapsible — running nodes auto-expand so
// you watch the fan-out live; settled subtrees collapse on click (omitted by flatten).

// COST-METER per-node token badge — its own component so the guard/format logic lives
// outside NodeRow (keeps NodeRow under the cyclomatic budget). Renders nothing for an
// unsettled / untracked node.
function NodeTokens({ tokens, hot }: { tokens: number | undefined; hot: boolean }) {
  if (typeof tokens !== "number" || tokens <= 0) return null
  return <span fg={hot ? theme.muted : theme.faint}>{`  ${fmtTokens(tokens)}`}</span>
}

// Shared props for NodeRow + its owned-tool body.
type NodeRowProps = {
  row: OrchRow
  expTools: Set<string>
  onToggle: (id: string) => void
  onToggleTool: (id: string) => void
  focusedKey: string | undefined
  cols: number
  frame: string
  syntaxStyle: unknown // the shared SyntaxStyle (rebuilt on a theme switch) for the node's owned-tool diffs
}

// One flattened node header line: connector prefix + glyph + label + summary + token
// badge + collapsed-only tool-count + ▾/▸. The prefix (├─/└─/│/blanks) renders in a
// muted guide color so the tree structure reads at a glance. Clickable/hoverable when
// the node has detail (owns tools or has children) — toggles its collapse state.
function NodeHeader({ row, hot, focused, frame, setHover, onToggle }: {
  row: OrchRow
  hot: boolean
  focused: boolean
  frame: string
  setHover: (v: boolean) => void
  onToggle: () => void
}) {
  const { prefix, color, glyph, label, summary, tokens, toolsLabel, hasDetail, expanded } = row
  const mark = glyph === "◌" ? frame : glyph // running nodes animate (was a motionless ◌)
  return (
    <text
      fg={color}
      selectable={false}
      onMouseDown={(hasDetail ? onToggle : undefined) as any}
      onMouseOver={(hasDetail ? (() => setHover(true)) : undefined) as any}
      onMouseOut={(() => setHover(false)) as any}
    >
      <FocusGutter focused={focused} />
      {prefix ? <span fg={hot ? theme.muted : theme.dim}>{prefix}</span> : null}
      <span fg={hot ? theme.white : color}>{`${mark} `}</span>
      <span fg={hot ? theme.white : theme.text}>{label}</span>
      {summary ? <span fg={hot ? theme.subtext : theme.muted}>{`  ${oneLine(summary)}`}</span> : null}
      <NodeTokens tokens={tokens} hot={hot} />
      {/* collapsed-only: show the owned-tool count so a node's work is visible without expanding */}
      {!expanded && toolsLabel ? <span fg={hot ? theme.subtext : theme.muted}>{`  ${toolsLabel}`}</span> : null}
      {hasDetail ? <span fg={hot ? theme.text : theme.muted}>{expanded ? "  ▾" : "  ▸"}</span> : null}
    </text>
  )
}

// Render one flattened tree row: its header line, then (when expanded) its OWNED tool
// steps, each reusing ToolView and indented under the node's continuation stem so the
// per-node tool ring hangs INSIDE the tree. Child nodes are NOT rendered here — flatten
// already emitted them as their own rows; this keeps the tree a flat <text> list.
function NodeRow(p: NodeRowProps) {
  const [hover, setHover] = useState(false)
  const { row } = p
  const hot = row.hasDetail && hover
  const focused = p.focusedKey === `node:${row.id}`
  return (
    <box flexDirection="column">
      <NodeHeader row={row} hot={hot} focused={focused} frame={p.frame} setHover={setHover} onToggle={() => p.onToggle(row.id)} />
      {row.expanded && row.tools.length > 0 && (
        <box flexDirection="column">
          {row.tools.map((m) => (
            <box key={m.id} flexDirection="row">
              {/* align owned tools under their node: the 2-cell focus gutter + body stem + connector */}
              <text fg={theme.dim} selectable={false}>{`  ${row.bodyPrefix}   `}</text>
              <box style={{ flexGrow: 1, flexShrink: 1 }}>
                <ToolView m={m} expanded={p.expTools.has(m.id)} focused={p.focusedKey === `tool:${m.id}`} cols={p.cols} frame={p.frame} syntaxStyle={p.syntaxStyle} onToggle={() => p.onToggleTool(m.id)} />
              </box>
            </box>
          ))}
        </box>
      )}
    </box>
  )
}

// Wrap the focus cursor over the focusable-row ring (empty ring ⇒ none). Pure; extracted
// from App so the cursor-wrap ternary doesn't count against App's complexity budget.
const pickFocused = (keys: readonly string[], cursor: number): string | undefined =>
  keys.length ? keys[((cursor % keys.length) + keys.length) % keys.length] : undefined

// Per-id expansion toggle set (orch nodes). Encapsulates the Set + reset-on-session.
const useNodeExpansion = (resetKey: unknown) => {
  const [expNodes, setExpNodes] = useState<Set<string>>(new Set())
  useEffect(() => setExpNodes(new Set()), [resetKey])
  const toggleNode = (id: string) =>
    setExpNodes((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  return { expNodes, toggleNode }
}

function App() {
  const state = useAtomValue(appAtom)
  const busy = useAtomValue(busyAtom)
  const busySessions = useAtomValue(busySessionsAtom)
  const setApp = useAtomSet(appAtom)
  const newSession = useAtomSet(newSessionAtom)
  const deleteSession = useAtomSet(deleteSessionAtom)
  const [, send] = useAtom(sendAtom)
  const { width, height } = useTerminalDimensions()
  const t = useTheme() // termcast-style hook accessor onto the resolved palette (same tokens as the `theme` const)
  // THEME SWITCH (the picker): the active name (also the mdStyle rebuild key), the ordered registry
  // names, and the switch action (live mutate + state bump + persist — theme-context.tsx).
  const themeCtl = useThemeSwitcher()
  // The shared SyntaxStyle, rebuilt ONLY when the theme name changes (stable across busy ticks). A
  // theme switch mutates the live palette in place, but a SyntaxStyle captures its hex at register
  // time, so it must be rebuilt; keying the memo on the name does exactly that.
  const mdStyle = useMemo(() => makeSyntaxStyle(), [themeCtl.name])

  const [text, setText] = useState("") // mirror of textarea content (for empty-detection)
  const taRef = useRef<any>(null)
  const scrollRef = useRef<any>(null)
  const work = useWorking(busy) // animated placeholder state (frame + elapsed)
  // QUEUED MESSAGE (opencode pending-prompt): a message submitted WHILE a turn is in flight is HELD
  // (UI-local, so Msg/session shapes stay UNCHANGED) and AUTO-SENT once the turn settles, instead
  // of firing a second concurrent turn. The hook (queue.ts) owns the pending slot + the flush /
  // session-drop effects; `queued` drives the dim "↑ queued" card (QueuedCard), `sendOrQueue` is
  // the busy-aware submit. Extracted to keep App under its complexity budget.
  const { queued, sendOrQueue } = useMessageQueue(busy, state.activeId, send)

  const [expTurns, setExpTurns] = useState<Set<number>>(new Set())
  const [expTools, setExpTools] = useState<Set<string>>(new Set())
  const { expNodes, toggleNode } = useNodeExpansion(state.activeId)
  const [focus, setFocus] = useState(0) // keyboard focus cursor over expandable rows (Tab cycles)
  // prompt history cursor + the live draft stashed when we start recalling
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const draftRef = useRef("")
  // big-paste collapse: marker -> full text, expanded back at submit
  const pastesRef = useRef<{ ph: string; text: string }[]>([])
  // esc-to-interrupt arming + transient header note (copied / interrupt hint)
  const [armed, setArmed] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // list-view `d` arm-then-confirm: holds the session id awaiting a second `d` to close.
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  // SELECTED MODEL — the model the composer NAMES (the model pick sets it). Starts at the default
  // session model id (Kimi); the model picker (useDialogs) swaps it to the other pool entry's id,
  // which the Composer's metadata row renders. A real, visible action — the picked model is shown.
  const [selectedModel, setSelectedModel] = useState<string>(MODEL)
  const focusedRef = useRef(true)
  // MODE STACK (keys.ts) — the single source of truth for which keyboard scope is active. "base"
  // is the composer + transcript-nav mode; opening the command palette / the which-key overlay
  // PUSHES its mode ("palette" / "whichkey") onto the stack, closing POPS it. This REPLACES the
  // pair of standalone `palette`/`whichKey` booleans + the if-chain dispatch: the active mode now
  // gates which registry bindings fire (dispatch below), so a base nav key can't fire under an
  // overlay. The DialogSelect command-palette query/highlight still live in the useDialogSelect
  // CONTROLLER (palModel, built below); the stack only owns which scope is on top.
  const mode = useModeStack()
  const palette = mode.is("palette")
  const whichKey = mode.is("whichkey")
  // SESSION SWITCHER + MODEL PICK (dialogs.tsx) — the two extra pickers, each a thin wrapper over
  // the SAME DialogSelect the palette uses (opencode reuse). Both run on the generic "dialog" mode;
  // `dialogs.kind` ("session" | "model" | null) says which is mounted. The switch action sets the
  // active session (mirrors the palette's old per-session "Switch:" rows); the model action sets the
  // composer-displayed model id. useDialogs owns BOTH controllers + the kind + the "dialog"-mode key
  // rows (spread into the registry below), so chat.tsx stays under the file ceiling.
  const dialogs = useDialogs(state.sessions, state.activeId, selectedModel, mode, {
    onSwitch: (id) => setApp((st) => ({ ...st, view: "chat" as const, activeId: id })),
    onModel: (name: ModelName) => setSelectedModel(MODELS[name].id),
    // THEME PICKER args: the active name (marks the "current" row), the ordered registry names, and
    // the switch action (live mutate + state bump + persist) — all from useThemeSwitcher above.
    theme: { name: themeCtl.name, names: themeCtl.names, onTheme: themeCtl.switch },
  })
  // FOCUS CAPTURE (composer.tsx captureFocus model): true whenever an overlay mode (anything but
  // base) owns the keyboard, so the composer stops reclaiming and yields keystrokes to the
  // registry. This is the gate the captureFocus seam was wired + tested for — now driven off the
  // mode stack (active ≠ base) instead of the OR of the removed booleans. The "dialog" mode (a
  // session/model picker) is ≠ base, so it captures focus exactly like the palette.
  //   AUTOCOMPLETE EXCEPTION: the @-mention / slash popup does NOT capture focus — the user keeps
  // typing INTO the textarea to narrow the query (each keystroke re-syncs the popup), so the
  // textarea must stay focused. Only the popup's NAV keys (↑↓/↵/esc/tab) are intercepted in the
  // global useKeyboard handler below (preventDefault → the textarea never sees them); every
  // printable + backspace falls through to the textarea, which re-fires onContentChange → ac.sync.
  const captureFocus = mode.active !== "base" && mode.active !== "autocomplete"

  useEffect(() => {
    setExpTurns(new Set())
    setExpTools(new Set())
    setHistIdx(null)
    setFocus(0)
    toBottom() // a freshly-switched/opened session lands pinned at its newest row
  }, [state.activeId])

  // focus-gated attention: bell on turn finishing while the terminal is blurred
  useFocus(() => void (focusedRef.current = true))
  useBlur(() => void (focusedRef.current = false))
  const prevBusy = useRef(busy)
  useEffect(() => {
    if (prevBusy.current && !busy && !focusedRef.current) {
      try {
        process.stdout.write("\x07")
      } catch {
        /* ignore */
      }
    }
    prevBusy.current = busy
  }, [busy])

  // copy selected transcript text to clipboard (OSC52 + pbcopy), transient note
  useSelectionHandler((sel: any) => {
    try {
      const t = sel?.getSelectedText?.() ?? ""
      if (copyToClipboard(t)) flash("copied")
    } catch {
      /* ignore */
    }
  })

  const flash = (msg: string) => {
    setNote(msg)
    setTimeout(() => setNote((n) => (n === msg ? null : n)), 2000)
  }

  const active = state.sessions.find((s) => s.id === state.activeId) ?? null
  const inChat = state.view === "chat" && active !== null
  // INLINE NODE-TREE: the session's OrchTree (once orch.emit has fired) is attached by toTurns
  // to the turn that produced it (computeShowOrch-gated), so the tree renders under THAT turn's
  // reply — not in a session-level footer. A non-workflow session has no `workflow` on any turn.
  const orch = active?.orch
  const turns = active ? toTurns(active.messages, orch) : []
  const isExpanded = (t: Turn) => expTurns.has(t.idx) || t.final === null // in-progress auto-expands

  // FOCUS MODEL (captureFocus) — the composer is the DEFAULT focus owner and RECLAIMS focus the
  // instant anything steals it (row click, Tab/Enter toggle, orch re-render) UNLESS a capture
  // owner (dialog / command palette, captureFocus=true) holds it, in which case it YIELDS. This
  // REPLACES the old unconditional BLURRED-reclaim hack: the Tab cycle stays purely VISUAL
  // (focusedKey drives a highlight; keystrokes are intercepted at the renderer), but a palette
  // can now genuinely own focus. The gate + subscription live in composer.tsx (useComposerFocus).
  useComposerFocus(taRef, state.view === "chat", captureFocus)

  // Expandable rows in transcript order = Tab focus ring (turn-steps header, then its tool
  // rows when that turn is expanded). A WORKFLOW turn additionally contributes its inline
  // node-tree rows to the ring (node:<id> collapses a node; tool:<id> drives an owned tool) —
  // ONLY when its WorkflowPart shows (t.workflow set). A non-workflow turn contributes none, so
  // hidden node rows never join the Tab cycle. Enter toggles the focused one.
  const focusables: string[] = []
  for (const t of turns) {
    if (t.steps.length > 0) focusables.push(`turn:${t.idx}`)
    if (isExpanded(t)) for (const s of t.steps) if (s.kind === "tool") focusables.push(`tool:${s.id}`)
    if (t.workflow) focusables.push(...orchFocusables(workflowRows(t.workflow, expNodes)))
  }
  const focusedKey = pickFocused(focusables, focus)
  const toggleFocused = () => {
    if (!focusedKey) return
    const [kind, val] = [focusedKey.slice(0, focusedKey.indexOf(":")), focusedKey.slice(focusedKey.indexOf(":") + 1)]
    if (kind === "turn") toggleTurn(Number(val))
    else if (kind === "node") toggleNode(val)
    else toggleTool(val)
  }

  const toggleTurn = (idx: number) =>
    setExpTurns((s) => {
      const n = new Set(s)
      n.has(idx) ? n.delete(idx) : n.add(idx)
      return n
    })
  const toggleTool = (id: string) =>
    setExpTools((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const setInput = (v: string) => {
    taRef.current?.setText(v)
    setText(v)
  }

  // INLINE NODE-TREE: render one flattened workflow row as a NodeRow (owns the per-node
  // ToolView + the node/tool expansion + focus wiring). Injected into TurnView so the inline
  // tree hangs under the turn that produced it, reusing the SAME NodeRow as the old footer.
  const renderNode = (row: OrchRow) => (
    <NodeRow
      key={row.id}
      row={row}
      expTools={expTools}
      onToggle={toggleNode}
      onToggleTool={toggleTool}
      focusedKey={focusedKey}
      cols={width || 80}
      frame={work.frame}
      syntaxStyle={mdStyle}
    />
  )

  const submit = () => {
    // IME DEFER (P0): under CJK composition the Enter that submits can fire BEFORE the textarea
    // commits the last composed char into plainText — reading synchronously drops or doubles it.
    // Double-defer the read (two microtasks) so the composition commit flushes first, then submit.
    const run = () => {
      let v = taRef.current?.plainText ?? text
      for (const p of pastesRef.current) v = v.split(p.ph).join(p.text)
      pastesRef.current = []
      const t = v.trim()
      setInput("")
      setHistIdx(null)
      draftRef.current = ""
      if (t.length === 0) return
      history.push(t)
      // QUEUE while busy: sendOrQueue (queue.ts) HOLDS the message in the pending slot when a turn
      // is in flight (the hook's busy→idle effect flushes it) instead of starting a concurrent turn;
      // idle ⇒ send immediately. Either way, pin the transcript to the bottom.
      sendOrQueue(t)
      toBottom() // pin the transcript to the new turn (sticky-bottom on submit)
    }
    queueMicrotask(() => queueMicrotask(run))
  }

  const onPaste = (event: any) => {
    try {
      const raw = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      const big = raw.length > 150 || raw.split("\n").length >= 3
      if (!big) return // let the textarea insert it normally
      event.preventDefault?.()
      const ph = `[Pasted ${raw.split("\n").length} lines]`
      pastesRef.current.push({ ph, text: raw })
      taRef.current?.insertText?.(ph)
      setText(taRef.current?.plainText ?? ph)
      flash("paste collapsed")
    } catch {
      /* fall back to default paste */
    }
  }

  // ↑/↓ prompt history, only when the input is empty or we're mid-recall.
  const histActive = () => histIdx !== null || text.trim() === ""
  const recall = (dir: -1 | 1) => {
    const items = history.all()
    if (items.length === 0) return
    if (dir === -1) {
      if (histIdx === null) {
        draftRef.current = text
        const i = items.length - 1
        setHistIdx(i)
        setInput(items[i]!)
      } else if (histIdx > 0) {
        const i = histIdx - 1
        setHistIdx(i)
        setInput(items[i]!)
      }
    } else {
      if (histIdx === null) return
      if (histIdx >= items.length - 1) {
        setHistIdx(null)
        setInput(draftRef.current)
      } else {
        const i = histIdx + 1
        setHistIdx(i)
        setInput(items[i]!)
      }
    }
  }

  // toBottom(): pin the transcript to its newest row. Called on submit + session switch so a
// new turn / a freshly-opened session lands at the bottom (opencode index.tsx:1232-1250 sticky
// toBottom). Deferred a tick so the scrollbox has measured the just-grown content first.
  const toBottom = () => {
    queueMicrotask(() => {
      const sb = scrollRef.current
      if (sb) try { sb.scrollTop = sb.scrollHeight } catch { /* ignore */ }
    })
  }

  const scrollPage = (dir: -1 | 1 | "top" | "bottom") => {
    const sb = scrollRef.current
    if (!sb) return
    const page = Math.max(1, (height || 24) - 6)
    try {
      if (dir === "top") sb.scrollTop = 0
      else if (dir === "bottom") sb.scrollTop = sb.scrollHeight
      else sb.scrollTop = Math.max(0, sb.scrollTop + dir * page)
    } catch {
      /* ignore */
    }
  }

  // LIST-VIEW actions (folded into the registry's base-mode rows below). `d` arms-then-confirms a
  // close (a first `d` arms the highlighted row, a second `d` on the SAME row closes it —
  // destructive + adjacent to nav keys, so it can't fire on one keypress); the cursor moves clear
  // the arm. Extracted as named helpers so the bind table reads as a flat list of {chord → action}.
  const listDelete = () => {
    const target = state.sessions[state.cursor]
    if (!target) return
    if (armedDelete === target.id) return void (deleteSession(target.id), setArmedDelete(null))
    setArmedDelete(target.id)
  }
  const listMove = (d: -1 | 1) =>
    void (setArmedDelete(null), setApp((s) => ({ ...s, cursor: Math.max(0, Math.min(s.sessions.length - 1, s.cursor + d)) })))
  const listOpen = () => {
    const target = state.sessions[state.cursor]
    if (target) setApp((s) => ({ ...s, view: "chat", activeId: target.id }))
  }

  // Graceful quit: tear the renderer down (restores the main screen, disables mouse
  // tracking + bracketed-paste mode) so the terminal isn't left spewing escape garbage —
  // the "unicode pressed" mess. destroy() DEFERS the restore when it fires mid-render (our
  // key handler does), so a bare process.exit() right after killed the process before the
  // restore sequences flushed. Give the deferred teardown a tick to flush, then hard-exit
  // as a fallback (OTel/appRuntime timers can otherwise keep the loop alive and hang quit).
  const quit = () => {
    try {
      renderer.destroy()
    } catch {
      /* ignore — exit regardless */
    }
    setTimeout(() => process.exit(0), 50)
  }

  const goToList = () => {
    setInput("")
    setApp((s) => ({ ...s, view: "list" }))
  }
  // Esc: when busy, first press arms, second interrupts; when idle, back to list.
  const handleEscape = () => {
    if (!busy) return goToList()
    if (armed && state.activeId) return void (abortTurn(state.activeId), setArmed(false))
    setArmed(true)
    setTimeout(() => setArmed(false), 5000)
  }

  // CHAT-VIEW actions folded into the registry's base-mode rows. `empty()` is the composer-empty
  // guard several chat keys share (left→list, Enter→toggle, Home/End scroll) so a key with a draft
  // in the composer falls through to the textarea (cursor move / submit) instead of navigating.
  const empty = () => text.trim() === ""
  const cycleFocus = (e: KeyEventLike) => void (focusables.length && setFocus((f) => f + (e.shift ? -1 : 1)))
  // Enter on empty toggles the focused row (the textarea's onSubmit no-ops on empty); a `when`
  // gate (empty composer AND a focused row) keeps this from stealing the submit Enter.

  // COMMAND REGISTRY — what ⌘K runs. Built from live state each render so "Switch: <session>"
  // reflects the current sessions. Every row here is a REAL action (the user: anything shown
  // must work) — no dead entries. Filtered by the live query (substring, case-insensitive).
  const commands: Command[] = [
    { title: "New session", hint: "n", run: () => void newSession() },
    // SESSION SWITCHER + MODEL PICK via the command palette (opencode reuse): a command OPENS the
    // shared DialogSelect picker rather than the palette inlining one "Switch: <session>" row per
    // session. The run closes the palette FIRST (pop "palette") then opens the dialog (push "dialog")
    // so the two overlays never stack — order matters: opening the dialog before the pop would strand
    // "palette" under "dialog". Switch is listed only with >1 session (nothing to switch to otherwise).
    ...(state.sessions.length > 1
      ? [{ title: "Switch session…", hint: "s", run: () => void (closePalette(), dialogs.openSession()) }]
      : []),
    { title: "Pick model…", hint: "m", run: () => void (closePalette(), dialogs.openModel()) },
    // /theme — open the theme picker (the shared DialogSelect): close the palette FIRST, then open
    // the dialog (same order the session/model pickers use so the overlays never stack). Selecting a
    // theme switches the palette LIVE + persists the choice (dialogs.tsx → useThemeSwitcher().switch).
    { title: "Pick theme…", hint: "t", run: () => void (closePalette(), dialogs.openTheme()) },
    { title: "Session list", hint: "esc", run: goToList },
    ...(active ? [{ title: `Close session: ${active.title}`, run: () => void deleteSession(active.id) }] : []),
    { title: "Scroll to bottom", hint: "End", run: () => scrollPage("bottom") },
    { title: "Scroll to top", hint: "Home", run: () => scrollPage("top") },
    { title: "Quit", hint: "ctrl+c", run: quit },
  ]
  // Each command → a DialogSelect Option whose VALUE is the command's run thunk (so submit()
  // invokes it) and whose hint passes straight through. The controller (useDialogSelect) owns the
  // filter query + highlighted index + the substring filter + ↑↓ wrap that the palette used to
  // hand-roll; chat.tsx just feeds it the live items and routes keystrokes. Rebuilt each render so
  // "Switch: <session>" stays current — a fresh items array only re-derives the filter (cheap), it
  // does NOT reset the selection (that's separate controller state).
  const palItems: Option<() => void>[] = commands.map((c) => ({ title: c.title, value: c.run, hint: c.hint }))
  const palModel = useDialogSelect(palItems, (run) => {
    run()
    closePalette()
  })
  // OPEN/CLOSE an overlay = push/pop its MODE on the stack (keys.ts). Opening the palette resets
  // the controller to a clean slate first (setQuery("") clears the filter AND resets the highlight
  // to the first row), then pushes "palette"; closing pops it and re-clears (so the next open is
  // fresh — the contract the old setPq("")/setPSel(0) pair gave). captureFocus (mode ≠ base) then
  // yields the composer focus to the overlay.
  const openPalette = () => {
    palModel.setQuery("")
    mode.push("palette")
  }
  const closePalette = () => {
    mode.pop("palette")
    palModel.setQuery("")
  }
  // Open the which-key overlay AND swallow the `?` that triggered it: opentui's focused textarea
  // also receives the printable `?` keystroke (the dispatch below doesn't stop the textarea from
  // inserting it), so without this the composer would hold a stray "?" after the overlay opens. The
  // toggle only fires on an EMPTY composer, so clearing it is lossless; deferred a tick (like submit)
  // so it runs AFTER the textarea has inserted the char.
  const openWhichKey = () => {
    mode.push("whichkey")
    queueMicrotask(() => setInput(""))
  }
  const closeWhichKey = () => mode.pop("whichkey")
  // Printable-char guard for the palette filter: a single visible char with no ctrl/meta (so it
  // doesn't swallow Ctrl+K etc.). Shared by the palette's char-append binding.
  const printable = (e: KeyEventLike): string =>
    typeof e.sequence === "string" && e.sequence.length === 1 && e.sequence >= " " && !e.ctrl && !e.meta ? e.sequence : ""

  // AUTOCOMPLETE (wire-autocomplete) — the @-mention / slash popup wired INTO the composer. The
  // controller (autocomplete.tsx useAutocomplete) owns the open/selection/file-load state; chat.tsx
  // owns the trigger DETECTION (onContentChange feeds ac.sync(plainText, cursorOffset) every
  // keystroke), the focus YIELD (the textarea KEEPS focus — captureFocus excludes "autocomplete" —
  // and the popup's nav keys are intercepted in useKeyboard with preventDefault), and the INSERT
  // (onInsert splices the picked "@path "/"/cmd " into the live textarea + restores the cursor).
  //   "/" items = the SAME command registry the palette runs, mapped to the popup's AcItem shape:
  // selecting one INSERTS "/title " as text (opencode's /slash autocomplete inserts the command
  // token; it isn't run from the popup). "@" items = a live repo file walk (the controller's default
  // loadFiles = walkRepoFiles over cwd). One pickable list per trigger, fuzzy-filtered by the query.
  const slashItems: AcItem[] = commands.map((c) => ({
    value: c.title,
    display: `/${c.title}`,
    ...(c.hint !== undefined ? { hint: c.hint } : {}),
    kind: "command" as const,
  }))
  const ac = useAutocomplete({
    commands: slashItems,
    onInsert: ({ text: next, cursor }) => {
      const ta = taRef.current
      ta?.setText?.(next)
      try {
        if (ta) ta.cursorOffset = cursor
      } catch {
        /* cursorOffset setter may be absent in some builds — text still landed */
      }
      setText(next)
    },
  })
  // The popup's open-state drives the MODE STACK: while a trigger is live, "autocomplete" is the
  // active mode (so which-key + the nav-key interception below scope to it); when it closes, the
  // mode pops back to base. Driven off ac.mode (recomputed each render from the live trigger) via an
  // effect so push/pop track the popup exactly. Unlike the palette/dialog modes this one does NOT
  // capture focus (see captureFocus above) — the textarea stays focused for query typing.
  const acOpen = ac.mode !== false
  useEffect(() => {
    if (acOpen) mode.push("autocomplete")
    else mode.pop("autocomplete")
    // eslint-disable-next-line react-hooks/exhaustive-deps — track the popup's open edge only
  }, [acOpen])
  // The composer's content-change handler: mirror the textarea content into `text` (for the empty/
  // history guards) AND feed the autocomplete controller the LIVE (plainText, cursorOffset) so it
  // opens/tracks/closes the popup off the cursor's "@"/"/" trigger. Runs on every keystroke — this
  // is the trigger DETECTION the composer owns (autocomplete.tsx detectTrigger does the pure work).
  const onComposerChange = () => {
    const ta = taRef.current
    const v: string = ta?.plainText ?? ""
    setText(v)
    ac.sync(v, typeof ta?.cursorOffset === "number" ? ta.cursorOffset : v.length)
  }

  // THE REGISTRY — one flat {mode, chord, when, run}[] table, the single source of truth the global
  // useKeyboard dispatches against (REPLACES the onListKey/onChatKey/onPaletteKey/onWhichKeyKey
  // if-chains + the palette/whichKey-boolean ladder). Order = precedence (first match wins, same as
  // the old top-to-bottom ladder), so a SPECIFIC guarded row (empty-composer Enter→toggle) precedes
  // a general one. `mode` scopes each row: base rows fire in the composer/list; the palette/whichkey
  // rows fire ONLY when that overlay's mode is on the stack top — so a base nav key (n / tab / arrow)
  // can NOT fire under a dialog. `when` adds the view/empty/history guards the old chains had inline.
  // The same table feeds which-key (activeBindings projects the active mode's rows to its display).
  const binds: readonly Bind[] = [
    // ── GLOBAL ── Ctrl+C is the mode-INDEPENDENT panic quit (handled pre-dispatch below so it
    // fires in ANY mode, even with a dialog open — matching the old top-of-handler check + opentui's
    // exitOnCtrlC); this row is display-only so which-key still advertises it. Ctrl+K (palette
    // toggle) works from list OR chat in base mode.
    { mode: "base", chord: "ctrl+c", keys: "ctrl+c", desc: "quit", group: "Global", display: true, run: quit },
    { mode: "base", chord: "ctrl+k", keys: "ctrl+k", desc: "command palette", group: "Global", run: openPalette },
    // `?` raises the which-key overlay — chat view, composer EMPTY (read from the textarea's LIVE
    // plainText, not the lagging `text` state, so a "?" ending a sentence types normally; only a `?`
    // on a truly empty composer toggles). Hidden from which-key's own list (it's the toggle itself).
    {
      mode: "base", chord: "?", keys: "?", desc: "toggle this help", group: "Global", hidden: true,
      when: () => inChat && (taRef.current?.plainText ?? "").trim() === "", run: openWhichKey,
    },
    // ── LIST VIEW (base, guarded to view==="list") ──
    { mode: "base", chord: "q", keys: "q", desc: "quit", group: "Session", when: () => state.view === "list", run: quit },
    { mode: "base", chord: "escape", keys: "esc", desc: "quit", group: "Session", hidden: true, when: () => state.view === "list", run: quit },
    { mode: "base", chord: "n", keys: "n", desc: "new session", group: "Session", when: () => state.view === "list", run: () => void newSession() },
    { mode: "base", chord: "d", keys: "d", desc: "close session", group: "Session", when: () => state.view === "list", run: listDelete },
    { mode: "base", chord: "up", keys: "↑↓", desc: "move cursor", group: "Session", when: () => state.view === "list", run: () => listMove(-1) },
    { mode: "base", chord: "k", keys: "k", desc: "move up", group: "Session", hidden: true, when: () => state.view === "list", run: () => listMove(-1) },
    { mode: "base", chord: "down", keys: "↑↓", desc: "move cursor", group: "Session", hidden: true, when: () => state.view === "list", run: () => listMove(1) },
    { mode: "base", chord: "j", keys: "j", desc: "move down", group: "Session", hidden: true, when: () => state.view === "list", run: () => listMove(1) },
    { mode: "base", chord: "return", keys: "↵", desc: "open session", group: "Session", when: () => state.view === "list", run: listOpen },
    // ── CHAT VIEW (base, guarded to inChat) ──
    { mode: "base", chord: "escape", keys: "esc", desc: "back / interrupt", group: "Navigate", when: () => inChat, run: handleEscape },
    { mode: "base", chord: "left", keys: "←", desc: "session list", group: "Navigate", when: () => inChat && empty() && !busy, run: goToList },
    { mode: "base", chord: "tab", keys: "tab", desc: "cycle focus", group: "Navigate", when: () => inChat, run: cycleFocus },
    { mode: "base", chord: "shift+tab", keys: "⇧tab", desc: "cycle focus back", group: "Navigate", hidden: true, when: () => inChat, run: cycleFocus },
    { mode: "base", chord: "return", keys: "↵", desc: "toggle focused row", group: "Navigate", when: () => inChat && empty() && focusedKey !== undefined, run: toggleFocused },
    { mode: "base", chord: "pageup", keys: "pgup", desc: "scroll up", group: "Scroll", when: () => inChat, run: () => scrollPage(-1) },
    { mode: "base", chord: "pagedown", keys: "pgdn", desc: "scroll down", group: "Scroll", when: () => inChat, run: () => scrollPage(1) },
    { mode: "base", chord: "home", keys: "home", desc: "scroll to top", group: "Scroll", when: () => inChat && empty(), run: () => scrollPage("top") },
    { mode: "base", chord: "end", keys: "end", desc: "scroll to bottom", group: "Scroll", when: () => inChat && empty(), run: () => scrollPage("bottom") },
    { mode: "base", chord: "up", keys: "↑↓", desc: "prompt history", group: "Compose", when: () => inChat && histActive(), run: () => recall(-1) },
    { mode: "base", chord: "down", keys: "↑↓", desc: "prompt history", group: "Compose", hidden: true, when: () => inChat && histActive(), run: () => recall(1) },
    // DISPLAY-ONLY (textarea-native): Enter submits / Shift+Enter inserts a newline are handled by
    // the <textarea> itself (inputKeys), NOT the registry — these rows only let which-key advertise
    // them for discovery (dispatch skips `display` rows, so the textarea keeps owning the keystroke).
    { mode: "base", chord: "return", keys: "↵", desc: "send message", group: "Compose", display: true, when: () => inChat, run: () => {} },
    { mode: "base", chord: "shift+return", keys: "⇧↵", desc: "newline", group: "Compose", display: true, when: () => inChat, run: () => {} },
    // ── PALETTE MODE (scopes the keyboard while the command dialog is open) ──
    { mode: "palette", chord: "escape", keys: "esc", desc: "close", group: "Palette", run: closePalette },
    { mode: "palette", chord: "return", keys: "↵", desc: "run command", group: "Palette", run: () => palModel.submit() },
    { mode: "palette", chord: "up", keys: "↑↓", desc: "select", group: "Palette", run: () => palModel.move(-1) },
    { mode: "palette", chord: "down", keys: "↑↓", desc: "select", group: "Palette", hidden: true, run: () => palModel.move(1) },
    { mode: "palette", chord: "home", keys: "home", desc: "first", group: "Palette", run: () => palModel.home() },
    { mode: "palette", chord: "end", keys: "end", desc: "last", group: "Palette", run: () => palModel.end() },
    { mode: "palette", chord: "backspace", keys: "⌫", desc: "edit filter", group: "Palette", run: () => palModel.backspaceQuery() },
    // ── WHICHKEY MODE (read-only hint panel — esc/Enter/? all dismiss it) ──
    { mode: "whichkey", chord: "escape", keys: "esc", desc: "close", group: "Help", run: closeWhichKey },
    { mode: "whichkey", chord: "return", keys: "↵", desc: "close", group: "Help", hidden: true, run: closeWhichKey },
    { mode: "whichkey", chord: "?", keys: "?", desc: "close", group: "Help", hidden: true, run: closeWhichKey },
    // ── AUTOCOMPLETE MODE (the @-mention / slash popup) — DISPLAY-only rows: the textarea KEEPS
    // focus while the popup is open (captureFocus excludes "autocomplete"), so the popup's nav keys
    // are intercepted in the useKeyboard callback below with preventDefault (so the textarea never
    // also moves the cursor / submits), NOT by dispatch. These rows only let which-key advertise the
    // popup's keys for discovery — dispatch skips `display` rows, leaving the callback to route them.
    { mode: "autocomplete", chord: "up", keys: "↑↓", desc: "select", group: "Autocomplete", display: true, run: () => {} },
    { mode: "autocomplete", chord: "return", keys: "↵", desc: "insert", group: "Autocomplete", display: true, run: () => {} },
    { mode: "autocomplete", chord: "escape", keys: "esc", desc: "close", group: "Autocomplete", display: true, run: () => {} },
    // ── DIALOG MODE (session switcher / model pick) — the shared "dialog"-mode key rows live in
    // dialogs.tsx (routed to whichever picker kind is open) and are SPREAD in here so dispatch routes
    // esc/↵/↑↓/home/end/⌫ while a picker is up. They scope the keyboard exactly like the palette rows.
    ...dialogs.binds,
  ]

  useKeyboard((k) => {
    // GLOBAL FIRST: Ctrl+C is the mode-independent graceful quit — handled before mode dispatch so
    // it fires even with a dialog/overlay open (the old handler checked it at the very top; opentui's
    // exitOnCtrlC is the renderer-level backstop). matchesChord keeps the chord grammar in one place.
    if (matchesChord(k, "ctrl+c")) return quit()
    // AUTOCOMPLETE FIRST: while the @-mention / slash popup is open the textarea KEEPS focus (so the
    // user can keep typing to narrow the query), so its nav keys (↑↓/↵/esc/tab) reach BOTH this
    // global handler AND the focused textarea. Route them to the controller and preventDefault so the
    // textarea does NOT also act on them (Enter wouldn't submit, ↑↓ wouldn't move the cursor) — the
    // InternalKeyHandler skips the focused renderable's handler once a global listener preventDefaults
    // (KeyHandler.ts:179). A printable/backspace is NOT a popup nav key, so it falls through to the
    // textarea, which re-fires onContentChange → ac.sync (the query narrows). Runs before dispatch so
    // the controller owns ↵/↑↓/esc while open (dispatch's "autocomplete" rows are display-only).
    if (ac.mode !== false) {
      const nav = navKeyName(k)
      if (nav && ac.onKey(nav)) return void k.preventDefault?.()
    }
    // Then dispatch against the ACTIVE-mode bindings (first match wins). If nothing matched AND the
    // palette is up, a printable char feeds its filter — the palette's only bindings are named keys
    // (esc/↵/↑↓/home/end/⌫), so a visible char never matches one and always falls through to here.
    // (In base mode an unmatched printable just falls to the focused textarea, which inserts it.)
    if (dispatch(k, mode.active, binds)) return
    if (mode.is("palette")) {
      const ch = printable(k)
      if (ch !== "") palModel.appendQuery(ch)
    } else if (mode.is("dialog")) {
      // A dialog's bindings are all named keys (esc/↵/↑↓/home/end/⌫), so a visible char never matches
      // one and falls through to here, feeding the OPEN picker's filter (same path as the palette above).
      const ch = printableChar(k)
      if (ch !== "") dialogs.feedChar(ch)
    }
  })

  if (!inChat) {
    return (
      <box flexDirection="column" style={{ height: "100%" }}>
        <List sessions={state.sessions} cursor={state.cursor} busySessions={busySessions} frame={work.frame} armedDelete={armedDelete} />
        {palette ? <Palette model={palModel} theme={t} /> : null}
        {/* SESSION SWITCHER / MODEL PICK overlays — the same shared DialogSelect, switched by
            dialogs.kind. Reachable from the list view too (⌘K → "Switch session…" / "Pick model…"). */}
        <DialogOverlays dialogs={dialogs} theme={t} />
      </box>
    )
  }

  // FOOTER + COMPOSER data. The composer status row carries the live left hint + the right
  // token/cost · Cmd+K cluster (cost-meter = tokens summed over settled replies + the orch run
  // total). The cwd rides the quiet ActionBar footer below it (left only). cwd is shortened so
  // the bar stays a single line.
  const footerCwd = shortCwd(process.cwd(), process.env.HOME ?? "")
  const sessTokens = sessionTokens(active.messages, orch)
  // RATE-LIMIT VISIBILITY: a node in the active session's orch tree currently backing off (429
  // retry) surfaces its status to the composer (activeRetry), so the throttle shows at the turn
  // level — not just buried in the tree. null when nothing is retrying ⇒ the usual busy/idle row.
  const status = statusBar(busy, armed, note, work, activeRetry(orch))
  // Placeholder stays CLEAN — never the thinking/esc line (that was the duplicate the user hit:
  // it rendered inside the input area on the LEFT while the status row showed it again on the
  // right). The live status now lives ONLY on the right-aligned status row.
  const placeholder = "message kimi"

  return (
    <box flexDirection="column" style={{ height: "100%" }}>
      {/* HEADER-ANCHORS: a ref-light sticky banner pinned at the TOP (flexShrink:0 so it never
          scrolls away). Shows "rlmcode · session <id>" — the id is the SessionView.id, the SAME
          value tagged on the motel chat.session span (session.id), so it doubles as the
          trace-correlation handle. Re-renders only when the active session changes. */}
      <SessionHeader id={active.id} />
      <scrollbox
        ref={scrollRef}
        style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}
        stickyScroll
        stickyStart="bottom"
        scrollY
      >
        {turns.map((t, i) => (
          <TurnView
            key={t.idx}
            t={t}
            first={i === 0}
            expanded={isExpanded(t)}
            expTools={expTools}
            expNodes={expNodes}
            focusedKey={focusedKey}
            cols={width || 80}
            frame={work.frame}
            syntaxStyle={mdStyle}
            onToggleTurn={() => toggleTurn(t.idx)}
            onToggleTool={(id) => toggleTool(id)}
            renderNode={renderNode}
          />
        ))}
        {/* QUEUED PROMPT — a message typed while the turn is busy, held pending below the live
            transcript; the queue hook auto-sends it on busy→idle. Dim "↑ queued" card so it reads
            as waiting-to-send, not a committed turn. The card OWNS the null case (renders nothing
            when queued===null), so App keeps no extra branch. UI-local (Msg/session unchanged). */}
        <QueuedCard text={queued} />
      </scrollbox>
      {/* HEADER-ANCHORS "N new" pill — bottom-right jump-to-latest affordance, shown when the
          transcript is scrolled UP and turns have arrived since you last sat at the bottom. REF-
          DRIVEN (header.tsx NewPill reads scrollRef imperatively + a seen-count ref) — a scroll
          alone never re-renders; it re-evaluates when a new turn lands (turns.length changes) or
          on the busy tick. Anchored above the composer (bottom=6) so it floats over the transcript. */}
      <NewPill scrollRef={scrollRef} turnCount={turns.length} bottom={6} />
      {/* AUTOCOMPLETE popup (wire-autocomplete) — the @-mention / slash menu, an absolute card
          bottom-anchored so it floats just ABOVE the composer (opencode docks it over the prompt).
          Driven by the controller built above; mounts only while a trigger is live (the component
          returns null on mode===false). The textarea KEEPS focus under it (captureFocus excludes
          "autocomplete"); the popup's nav keys are intercepted in useKeyboard. `query` is the live
          textarea text (the controller filters by the post-trigger slice). */}
      <Autocomplete mode={ac.mode} items={ac.items} selected={ac.selected} query={text} theme={t} left={1} bottom={6} width={Math.min(64, Math.max(40, (width || 80) - 4))} />
      {/* COMPOSER (SPEC) — bordered textarea + metadata row (model) + status row (left
          spinner/hint, right token·cost / Cmd+K). flexShrink:0 so it ALWAYS reserves its
          height; the scrollbox (flexGrow:1) absorbs the slack and CLIPS the transcript
          instead of bleeding over the input. Focus = the captureFocus model (useComposerFocus
          above): default owner, reclaims on blur UNLESS a palette captures focus. */}
      <Composer
        taRef={taRef}
        theme={t}
        busy={busy}
        armed={armed}
        model={selectedModel}
        status={{ text: status.right, tone: status.tone, live: status.live }}
        tokens={sessTokens}
        fmtTokens={fmtTokens}
        spinnerFrame={work.frame}
        placeholder={placeholder}
        captureFocus={captureFocus}
        keyBindings={inputKeys}
        onContentChange={onComposerChange}
        onSubmit={submit}
        onPaste={onPaste}
      />
      {/* FOOTER ACTION-BAR — cwd (left only). Pinned flexShrink:0. The token/cost · Cmd+K
          cluster now lives on the composer status row above; the footer keeps the cwd so the
          working directory stays a glance away. Drops opencode's LSP/MCP/permission dots. */}
      <ActionBar cwd={footerCwd} right="" theme={t} />
      {/* ⌘K command palette — absolute overlay on top of the transcript (termcast DialogOverlay).
          Rendered last so it floats over everything; chat.tsx owns its state + key routing. */}
      {palette ? <Palette model={palModel} theme={t} /> : null}
      {/* SESSION SWITCHER / MODEL PICK — the same shared DialogSelect (dialogs.tsx), switched by
          dialogs.kind. Absolute overlays like the palette; chat.tsx owns the open/close via the
          "dialog" mode + routes keys to the active controller. Opened from ⌘K. */}
      <DialogOverlays dialogs={dialogs} theme={t} />
      {/* WHICH-KEY overlay (`?`) — contextual keybind hints, now read straight from the REGISTRY:
          activeBindings("base", binds) projects the base-mode rows whose `when` currently holds to
          the which-key display shape. With inChat true that's exactly the chat-view bindings (the
          list rows' `when` fails) — the overlay shows what you can press RIGHT NOW, no hand-rolled
          duplicate table. Absolute overlay like the palette; presentational only. */}
      {whichKey ? <WhichKey bindings={activeBindings("base", binds)} cols={width || 80} theme={t} /> : null}
    </box>
  )
}

// alternate-screen (default): owns a dedicated screen region -> clean redraws,
// correct anchoring for dynamic/collapsible content (main-screen overwrote).
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(
  <RegistryProvider>
    {/* THEME PROVIDER wraps the whole app so useTheme()/useThemeSwitcher() resolve everywhere and a
        /theme switch re-renders the tree (the live palette mutate + the React state bump together). */}
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </RegistryProvider>,
)
