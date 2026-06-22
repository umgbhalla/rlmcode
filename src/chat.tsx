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
import { createCliRenderer, decodePasteBytes, RenderableEvents, SyntaxStyle } from "@opentui/core"
import { createRoot, useBlur, useFocus, useKeyboard, useSelectionHandler, useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { abortTurn, projectDocLoaded } from "./agent.ts"
import { appAtom, busyAtom, deleteSessionAtom, type Msg, newSessionAtom, type OrchTree, sendAtom, type SessionView, type TurnMeta } from "./atoms.ts"
import { copyToClipboard } from "./clipboard.ts"
import { history } from "./history.ts"
import { type PreviewLine, toolDiff, toolHasBody, toolIcon, toolLabel, toolPreview, toolSummary } from "./toolui.ts"
import { flatten, type Row as OrchRow } from "./tui/orch-tree.ts"

const projectDoc = projectDocLoaded
const mdStyle = SyntaxStyle.create()

// Enter submits, Shift+Enter inserts a newline (override textarea defaults, which
// are Enter=newline / Cmd+Enter=submit).
const inputKeys = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
] as any

type ToolMsg = Extract<Msg, { kind: "tool" }>
type Turn = { idx: number; user: string; steps: Msg[]; final: string | null; meta?: TurnMeta | undefined }

const oneLine = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// COST-METER token formatter: "318k tok" / "742 tok" (shared by turn meta + orch tree).
const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tok` : `${n} tok`)

// Per-turn provenance only (model lives in the status line, not repeated here).
const fmtMeta = (m: TurnMeta): string => {
  const parts: string[] = [`${(m.ms / 1000).toFixed(1)}s`]
  if (typeof m.tokens === "number") parts.push(fmtTokens(m.tokens))
  if (m.finishReason && m.finishReason !== "stop") parts.push(m.finishReason)
  if (m.budget) parts.push("budget")
  return parts.join(" · ")
}

const INDENT = 2 // single source of truth for transcript nesting

const IDLE_HINT = "↑↓ history · tab focus · enter expand · PgUp/PgDn scroll · ← / esc back"
// Right-side status text + tone for the bottom bar (busy/armed/transient note/idle).
const statusBar = (busy: boolean, armed: boolean, note: string | null): { right: string; tone: string } => {
  if (armed) return { right: "esc again to interrupt", tone: "#f38ba8" }
  if (busy) return { right: "working… · esc interrupt", tone: "#ffd166" }
  if (note) return { right: note, tone: "#a6e3a1" }
  return { right: IDLE_HINT, tone: "#585b70" }
}

function toTurns(messages: readonly Msg[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.kind === "you") turns.push({ idx: turns.length, user: m.text, steps: [], final: null })
    else if (turns.length > 0) turns[turns.length - 1]!.steps.push(m)
  }
  for (const t of turns) {
    for (let i = t.steps.length - 1; i >= 0; i--) {
      const s = t.steps[i]!
      if (s.kind === "agent") {
        t.final = s.text
        t.meta = s.meta
        t.steps = [...t.steps.slice(0, i), ...t.steps.slice(i + 1)]
        break
      }
    }
  }
  return turns
}

const toolsUsed = (steps: Msg[]) =>
  [...new Set(steps.filter((s): s is ToolMsg => s.kind === "tool").map((s) => toolLabel(s.name, s.args).split("(")[0]!))].join(", ")

const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

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

const statusColor = (status: ToolMsg["status"]) =>
  status === "error" ? "#f38ba8" : status === "ok" ? "#a6e3a1" : "#7f849c"
const previewColor = (tone: PreviewLine["tone"]) => (tone === "add" ? "#a6e3a1" : tone === "del" ? "#f38ba8" : "#6c7086")
const previewSign = (tone: PreviewLine["tone"]) => (tone === "add" ? "+" : tone === "del" ? "-" : "│")

// Clickable header row: brightens on hover when the row has a drill-down body.
function ToolHeader({ m, expanded, hasBody, focused, onToggle }: { m: ToolMsg; expanded: boolean; hasBody: boolean; focused: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false)
  const running = m.status === "running"
  const color = statusColor(m.status)
  const mark = running ? "◌" : m.status === "error" ? "✗" : toolIcon(m.name)
  const summary = running ? "running…" : toolSummary(m.name, m.result, m.status === "error")
  const hot = hasBody && (hover || focused) // hover OR keyboard-focused -> brighten
  return (
    <text
      fg={color}
      selectable={false}
      onMouseDown={(hasBody ? onToggle : undefined) as any}
      onMouseOver={(hasBody ? (() => setHover(true)) : undefined) as any}
      onMouseOut={(() => setHover(false)) as any}
    >
      <span fg={hot ? "#ffffff" : color}>{`${mark} `}</span>
      <span fg={hot ? "#ffffff" : "#cdd6f4"}>{toolLabel(m.name, m.args)}</span>
      <span fg={hot ? "#9399b2" : "#585b70"}>{`  ${summary}`}</span>
      {hasBody ? <span fg={hot ? "#cdd6f4" : "#585b70"}>{expanded ? "  ▾" : "  ▸"}</span> : null}
    </text>
  )
}

function ToolView({ m, expanded, focused, cols, onToggle }: { m: ToolMsg; expanded: boolean; focused: boolean; cols: number; onToggle: () => void }) {
  const isError = m.status === "error"
  const hasBody = m.status !== "running" && toolHasBody(m.name, m.result, isError)
  const open = expanded && hasBody
  const diff = open ? toolDiff(m.name, m.args, isError) : null
  const preview = open && !diff ? toolPreview(m.name, m.args, m.result, isError, Math.max(20, cols - 10)) : []
  return (
    <box flexDirection="column" style={{ marginTop: open ? 1 : 0 }}>
      <ToolHeader m={m} expanded={expanded} hasBody={hasBody} focused={focused} onToggle={onToggle} />
      {diff ? (
        <box style={{ paddingLeft: INDENT, paddingTop: 1 }}>
          <diff diff={diff.diff} view={cols > 120 ? "split" : "unified"} filetype={diff.filetype} showLineNumbers syntaxStyle={mdStyle} />
        </box>
      ) : (
        <box flexDirection="column" style={{ paddingLeft: INDENT }}>
          {preview.map((p, i) => (
            <text key={i} fg={previewColor(p.tone)}>{`${previewSign(p.tone)} ${p.text}`}</text>
          ))}
        </box>
      )}
    </box>
  )
}

function TurnView({
  t,
  first,
  expanded,
  expTools,
  focusedKey,
  cols,
  onToggleTurn,
  onToggleTool,
}: {
  t: Turn
  first: boolean
  expanded: boolean
  expTools: Set<string>
  focusedKey: string | undefined
  cols: number
  onToggleTurn: () => void
  onToggleTool: (id: string) => void
}) {
  const [hoverSteps, setHoverSteps] = useState(false)
  const stepsFocused = focusedKey === `turn:${t.idx}`
  return (
    <box flexDirection="column" style={{ marginTop: first ? 0 : 1 }}>
      <box border={["left"]} borderColor="#45475a" style={{ paddingLeft: 1, width: "100%" }}>
        <text fg="#66aaff">{t.user}</text>
      </box>
      {t.steps.length > 0 && (
        <box flexDirection="column" style={{ paddingLeft: INDENT }}>
          <text
            fg={hoverSteps || stepsFocused ? "#cdd6f4" : "#7f849c"}
            selectable={false}
            onMouseDown={onToggleTurn as any}
            onMouseOver={(() => setHoverSteps(true)) as any}
            onMouseOut={(() => setHoverSteps(false)) as any}
          >
            {`${expanded ? "▾" : "▸"} ${t.steps.length} step${t.steps.length > 1 ? "s" : ""}`}
            {!expanded ? `   ${toolsUsed(t.steps)}` : ""}
          </text>
          {expanded && (
            <box flexDirection="column" style={{ paddingLeft: INDENT }}>
              {t.steps.map((s, i) =>
                s.kind === "tool" ? (
                  <ToolView
                    key={s.id}
                    m={s}
                    expanded={expTools.has(s.id)}
                    focused={focusedKey === `tool:${s.id}`}
                    cols={cols}
                    onToggle={() => onToggleTool(s.id)}
                  />
                ) : (
                  <text key={i} fg="#9399b2">{`· ${oneLine(s.text)}`}</text>
                ),
              )}
            </box>
          )}
        </box>
      )}
      {t.final !== null && (
        <box flexDirection="column" style={{ marginTop: 1 }}>
          <box flexDirection="row" style={{ width: "100%" }}>
            <text fg="#a6e3a1">{"⏺ "}</text>
            <box style={{ flexGrow: 1, flexShrink: 1 }}>
              <markdown content={t.final} syntaxStyle={mdStyle} />
            </box>
          </box>
          {t.meta && (
            <box style={{ paddingLeft: INDENT }}>
              <text fg="#585b70">{fmtMeta(t.meta)}</text>
            </box>
          )}
        </box>
      )}
    </box>
  )
}

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
  return <span fg={hot ? "#7f849c" : "#585b70"}>{`  ${fmtTokens(tokens)}`}</span>
}

// Shared props for NodeRow + its owned-tool body.
type NodeRowProps = {
  row: OrchRow
  expTools: Set<string>
  onToggle: (id: string) => void
  onToggleTool: (id: string) => void
  focusedKey: string | undefined
  cols: number
}

// One flattened node header line: connector prefix + glyph + label + summary + token
// badge + collapsed-only tool-count + ▾/▸. The prefix (├─/└─/│/blanks) renders in a
// muted guide color so the tree structure reads at a glance. Clickable/hoverable when
// the node has detail (owns tools or has children) — toggles its collapse state.
function NodeHeader({ row, hot, setHover, onToggle }: {
  row: OrchRow
  hot: boolean
  setHover: (v: boolean) => void
  onToggle: () => void
}) {
  const { prefix, color, glyph, label, summary, tokens, toolsLabel, hasDetail, expanded } = row
  return (
    <text
      fg={color}
      selectable={false}
      onMouseDown={(hasDetail ? onToggle : undefined) as any}
      onMouseOver={(hasDetail ? (() => setHover(true)) : undefined) as any}
      onMouseOut={(() => setHover(false)) as any}
    >
      {prefix ? <span fg={hot ? "#6c7086" : "#45475a"}>{prefix}</span> : null}
      <span fg={hot ? "#ffffff" : color}>{`${glyph} `}</span>
      <span fg={hot ? "#ffffff" : "#cdd6f4"}>{label}</span>
      {summary ? <span fg={hot ? "#9399b2" : "#585b70"}>{`  ${oneLine(summary)}`}</span> : null}
      <NodeTokens tokens={tokens} hot={hot} />
      {/* collapsed-only: show the owned-tool count so a node's work is visible without expanding */}
      {!expanded && toolsLabel ? <span fg={hot ? "#9399b2" : "#585b70"}>{`  ${toolsLabel}`}</span> : null}
      {hasDetail ? <span fg={hot ? "#cdd6f4" : "#585b70"}>{expanded ? "  ▾" : "  ▸"}</span> : null}
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
  return (
    <box flexDirection="column">
      <NodeHeader row={row} hot={hot} setHover={setHover} onToggle={() => p.onToggle(row.id)} />
      {row.expanded && row.tools.length > 0 && (
        <box flexDirection="column">
          {row.tools.map((m) => (
            <box key={m.id} flexDirection="row">
              {/* align owned tools under their node: the node's body stem + one connector cell */}
              <text fg="#45475a" selectable={false}>{`${row.bodyPrefix}   `}</text>
              <box style={{ flexGrow: 1, flexShrink: 1 }}>
                <ToolView m={m} expanded={p.expTools.has(m.id)} focused={p.focusedKey === `tool:${m.id}`} cols={p.cols} onToggle={() => p.onToggleTool(m.id)} />
              </box>
            </box>
          ))}
        </box>
      )}
    </box>
  )
}

function List({ sessions, cursor }: { sessions: readonly SessionView[]; cursor: number }) {
  return (
    <box flexDirection="column" padding={1}>
      <text fg="#888888">SESSIONS · n new · ↑↓ move · enter open · d close · q quit</text>
      {sessions.length === 0 ? (
        <text fg="#666666">no sessions. press n to start.</text>
      ) : (
        sessions.map((s, i) => (
          <text key={s.id} fg={i === cursor ? "#ffd166" : "#cccccc"}>
            {i === cursor ? "▸ " : "  "}
            {s.title}
            {"  "}
            <span fg="#666666">{`${s.messages.length} msg`}</span>
          </text>
        ))
      )}
    </box>
  )
}

// PER-NODE TOOL ROUTING: the orchestration tool rows that join the Tab focus ring,
// derived from the SAME flattened rows the tree renders (render order = focus order).
// Each EXPANDED node's owned tools expose a `tool:<id>` key (same key as transcript
// tools), so toggleFocused drives them unchanged. Collapsed nodes are absent from
// `rows` (flatten omits their subtree) so their tools don't join the ring — correct.
const orchToolFocusables = (rows: readonly OrchRow[]): string[] => {
  const out: string[] = []
  for (const r of rows) if (r.expanded) for (const m of r.tools) out.push(`tool:${m.id}`)
  return out
}

// Σ footer summary: the live run total — COST-METER tokens (preserved from orch.totalTokens)
// · node count · error count. Computed over the whole node map (not just visible rows) so a
// collapsed subtree still counts toward the totals.
const orchSigma = (orch: OrchTree): string => {
  const nodes = Object.values(orch.nodes)
  const errors = nodes.filter((n) => n.status === "error").length
  const parts = [`Σ ${fmtTokens(orch.totalTokens)}`, `${nodes.length} node${nodes.length === 1 ? "" : "s"}`]
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

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
  const setApp = useAtomSet(appAtom)
  const newSession = useAtomSet(newSessionAtom)
  const deleteSession = useAtomSet(deleteSessionAtom)
  const [, send] = useAtom(sendAtom)
  const { width, height } = useTerminalDimensions()

  const [text, setText] = useState("") // mirror of textarea content (for empty-detection)
  const taRef = useRef<any>(null)
  const scrollRef = useRef<any>(null)
  const work = useWorking(busy) // animated placeholder state (frame + elapsed)

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
  const focusedRef = useRef(true)

  useEffect(() => {
    setExpTurns(new Set())
    setExpTools(new Set())
    setHistIdx(null)
    setFocus(0)
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
  const turns = active ? toTurns(active.messages) : []
  // Orchestration tree (only present once orch.emit has fired). flatten() walks the
  // immutable tree into ordered, connector-prefixed Rows (one per visible node) — all
  // tree geometry lives in the pure helper; the render is a flat list of <text> rows.
  const orch = active?.orch
  const orchRows = useMemo(() => (orch ? flatten(orch, expNodes) : []), [orch, expNodes])
  const isExpanded = (t: Turn) => expTurns.has(t.idx) || t.final === null // in-progress auto-expands

  // STICKY SELF-RESTORING FOCUS (focus-sticky): opentui focus is a SINGLE imperative
  // focused-renderable. The composer textarea is the DEFAULT focus owner — but a click
  // on a selectable=false transcript/orch row, a Tab/Enter row toggle, or an
  // orchestration re-render routes focus through the renderer's focusRenderable(), which
  // blur()s the textarea (it loses the highlight AND keystrokes). Renderable.focus()
  // early-returns if already focused, and the static `focused` prop only fires once on
  // mount, so a dep-keyed re-focus MISSES mouse-steal events. Instead we subscribe to the
  // textarea's own BLURRED event and immediately re-claim focus: the composer always wins
  // focus back the instant it's stolen. The Tab cycle is purely VISUAL (focusedKey drives
  // a highlight; keystrokes are intercepted by useKeyboard at the renderer, not the
  // textarea), so there is no "row focus mode" that should hold real focus — the composer
  // is always the rightful owner here. Guarded to the chat view + a live, non-destroyed
  // handle. focus() early-returns when we already hold it, so the initial focus + any
  // re-render is a cheap no-op; only an actual steal triggers the re-claim.
  useEffect(() => {
    const ta = taRef.current
    if (!ta || state.view !== "chat") return
    ta.focus?.()
    const reclaim = () => {
      // Re-focus on the next tick: the steal (focusRenderable) is mid-flight when BLURRED
      // fires, so deferring lets it settle, then we take focus back cleanly.
      queueMicrotask(() => {
        if (state.view === "chat") taRef.current?.focus?.()
      })
    }
    ta.on?.(RenderableEvents.BLURRED, reclaim)
    return () => ta.off?.(RenderableEvents.BLURRED, reclaim)
  }, [state.view])

  // Expandable rows in transcript order = Tab focus ring (turn-steps header, then
  // its tool rows when that turn is expanded). Enter toggles the focused one.
  const focusables: string[] = []
  for (const t of turns) {
    if (t.steps.length > 0) focusables.push(`turn:${t.idx}`)
    if (isExpanded(t)) for (const s of t.steps) if (s.kind === "tool") focusables.push(`tool:${s.id}`)
  }
  // PER-NODE TOOL ROUTING: orchestration node tool rows join the Tab ring too (derived from
  // the same flattened rows). Same `tool:<id>` key as transcript tools, so toggleFocused drives them.
  focusables.push(...orchToolFocusables(orchRows))
  const focusedKey = focusables.length ? focusables[((focus % focusables.length) + focusables.length) % focusables.length] : undefined
  const toggleFocused = () => {
    if (!focusedKey) return
    const [kind, val] = [focusedKey.slice(0, focusedKey.indexOf(":")), focusedKey.slice(focusedKey.indexOf(":") + 1)]
    if (kind === "turn") toggleTurn(Number(val))
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

  const submit = () => {
    let v = taRef.current?.plainText ?? text
    for (const p of pastesRef.current) v = v.split(p.ph).join(p.text)
    pastesRef.current = []
    const t = v.trim()
    setInput("")
    setHistIdx(null)
    draftRef.current = ""
    if (t.length === 0) return
    history.push(t)
    send(t)
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

  const onListKey = (k: any) => {
    if (k.name === "q" || k.name === "escape") return process.exit(0)
    if (k.name === "n") return void newSession()
    // d — close the highlighted session: aborts its turn + frees its sessionsRT entry.
    if (k.name === "d") {
      const target = state.sessions[state.cursor]
      return void (target && deleteSession(target.id))
    }
    if (k.name === "up" || k.name === "k") return setApp((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }))
    if (k.name === "down" || k.name === "j")
      return setApp((s) => ({ ...s, cursor: Math.min(s.sessions.length - 1, s.cursor + 1) }))
    if (k.name === "return") {
      const target = state.sessions[state.cursor]
      if (target) setApp((s) => ({ ...s, view: "chat", activeId: target.id }))
    }
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

  const onChatKey = (k: any) => {
    const empty = text.trim() === ""
    if (k.name === "escape") return handleEscape()
    if (k.name === "left" && empty && !busy) return goToList()
    if (k.name === "tab") return void (focusables.length && setFocus((f) => f + (k.shift ? -1 : 1)))
    // Enter on empty toggles the focused row (textarea onSubmit no-ops on empty).
    if (k.name === "return" && empty && focusedKey) return toggleFocused()
    if (k.name === "pageup") return scrollPage(-1)
    if (k.name === "pagedown") return scrollPage(1)
    if (k.name === "home" && empty) return scrollPage("top")
    if (k.name === "end" && empty) return scrollPage("bottom")
    if (k.name === "up" && histActive()) return recall(-1)
    if (k.name === "down" && histActive()) return recall(1)
    // everything else (typing, cursor moves, submit) is handled by the textarea
  }

  useKeyboard((k) => {
    if (k.ctrl && k.name === "c") return process.exit(0)
    return state.view === "list" ? onListKey(k) : onChatKey(k)
  })

  if (!inChat) {
    return (
      <box flexDirection="column" style={{ height: "100%" }}>
        <List sessions={state.sessions} cursor={state.cursor} />
      </box>
    )
  }

  // ONE status line at the bottom: left = context (model · session), right =
  // live state or key hints. No top bar, no scattered metadata.
  const statusLeft = `kimi · ${active.title}${projectDoc ? ` · ${projectDoc}` : ""}`
  const status = statusBar(busy, armed, note)

  return (
    <box flexDirection="column" style={{ height: "100%" }}>
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
            focusedKey={focusedKey}
            cols={width || 80}
            onToggleTurn={() => toggleTurn(t.idx)}
            onToggleTool={(id) => toggleTool(id)}
          />
        ))}
        {orch && orch.roots.length > 0 && (
          <box flexDirection="column" style={{ marginTop: 1, paddingLeft: 1 }}>
            <text fg="#585b70">orchestration</text>
            {/* VELOCITY UNICODE TREE: one flat <text> per flattened Row, connectors
                precomputed by flatten() — no nested padding boxes. */}
            <box flexDirection="column" style={{ paddingLeft: INDENT }}>
              {orchRows.map((row) => (
                <NodeRow
                  key={row.id}
                  row={row}
                  expTools={expTools}
                  onToggle={toggleNode}
                  onToggleTool={toggleTool}
                  focusedKey={focusedKey}
                  cols={width || 80}
                />
              ))}
              {/* Σ footer: live run total — tokens · nodes · errors (COST-METER total preserved). */}
              <text fg="#6c7086">{orchSigma(orch)}</text>
            </box>
          </box>
        )}
      </scrollbox>
      <box style={{ paddingLeft: 1, paddingRight: 1, paddingTop: 1, width: "100%" }}>
        <box
          border={["left"]}
          borderColor={busy ? "#ffd166" : "#66aaff"}
          style={{ paddingLeft: 1, flexShrink: 0, width: "100%" }}
        >
          <textarea
            ref={taRef}
            width="100%"
            minHeight={1}
            maxHeight={8}
            keyBindings={inputKeys}
            onContentChange={() => setText(taRef.current?.plainText ?? "")}
            onSubmit={submit as any}
            onPaste={onPaste as any}
            focused
            cursorColor="#66aaff"
            focusedTextColor="#cdd6f4"
            placeholder={busy ? `${work.frame} thinking… ${work.elapsed}s · esc to interrupt` : "message kimi"}
            placeholderColor={busy ? "#ffd166" : "#585b70"}
          />
        </box>
      </box>
      <box flexDirection="row" justifyContent="space-between" style={{ paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
        <text fg="#585b70">{statusLeft}</text>
        <text fg={status.tone}>{status.right}</text>
      </box>
    </box>
  )
}

// alternate-screen (default): owns a dedicated screen region -> clean redraws,
// correct anchoring for dynamic/collapsible content (main-screen overwrote).
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
)
