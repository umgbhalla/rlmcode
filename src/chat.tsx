// opentui (React) chat, inline mode. Interactive, collapsible transcript:
//   - each turn shows user + final reply; the middle steps (tools + narration)
//     collapse by default. In-progress turns auto-expand so you watch it work.
//   - per-tool rows expand to an explicit, tool-specific detail body.
//   list view : ↑/↓ move, Enter open, n new, q quit
//   chat view : type + Enter send · ↑/↓ move focus · Enter toggle (empty input)
//               · click a ▸/▾ header to toggle · ← / Esc back to list
import { RegistryProvider, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { createCliRenderer, SyntaxStyle } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { projectDocLoaded } from "./agent.ts"
import { appAtom, busyAtom, type Msg, newSessionAtom, sendAtom, type SessionView } from "./atoms.ts"
import { toolLabel, toolPreview, toolSummary } from "./toolui.ts"

const projectDoc = projectDocLoaded
const mdStyle = SyntaxStyle.create()

type ToolMsg = Extract<Msg, { kind: "tool" }>
type Turn = { idx: number; user: string; steps: Msg[]; final: string | null }
type Focusable = { kind: "turn"; idx: number } | { kind: "tool"; id: string }

const oneLine = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
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
        t.steps = [...t.steps.slice(0, i), ...t.steps.slice(i + 1)]
        break
      }
    }
  }
  return turns
}

const toolsUsed = (steps: Msg[]) =>
  [...new Set(steps.filter((s): s is ToolMsg => s.kind === "tool").map((s) => toolLabel(s.name, s.args).split("(")[0]!))].join(", ")

function Spinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((x) => x + 1), 80)
    return () => clearInterval(t)
  }, [])
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  return <text fg="#ffd166">{`${frames[i % frames.length]} thinking…`}</text>
}

function ToolView({ m, expanded, focused, onToggle }: { m: ToolMsg; expanded: boolean; focused: boolean; onToggle: () => void }) {
  const running = m.status === "running"
  const color = m.status === "error" ? "#f38ba8" : m.status === "ok" ? "#a6e3a1" : "#7f849c"
  const mark = running ? "◌" : m.status === "error" ? "✗" : "⏺"
  const label = toolLabel(m.name, m.args)
  const summary = running ? "running…" : toolSummary(m.name, m.result, m.status === "error")
  const preview = expanded && !running ? toolPreview(m.name, m.args, m.result, m.status === "error") : []
  return (
    <box flexDirection="column">
      <text fg={color} onMouseDown={onToggle as any}>
        {`    ${mark} `}
        <span fg={focused ? "#ffd166" : "#cdd6f4"}>{label}</span>
        <span fg="#585b70">{`  ${summary}`}</span>
        {!running ? <span fg="#585b70">{expanded ? "  ▾" : "  ▸"}</span> : <span> </span>}
      </text>
      {preview.map((p, i) => (
        <text key={i} fg={p.tone === "add" ? "#a6e3a1" : p.tone === "del" ? "#f38ba8" : "#6c7086"}>
          {`      ${p.tone === "add" ? "+" : p.tone === "del" ? "-" : "│"} ${oneLine(p.text, 100)}`}
        </text>
      ))}
    </box>
  )
}

function TurnView({
  t,
  expanded,
  expTools,
  focused,
  onToggleTurn,
  onToggleTool,
}: {
  t: Turn
  expanded: boolean
  expTools: Set<string>
  focused: Focusable | undefined
  onToggleTurn: () => void
  onToggleTool: (id: string) => void
}) {
  const turnFocused = focused?.kind === "turn" && focused.idx === t.idx
  return (
    <box flexDirection="column">
      <text fg="#66aaff">{`› ${t.user}`}</text>
      {t.steps.length > 0 && (
        <box flexDirection="column">
          <text fg={turnFocused ? "#ffd166" : "#7f849c"} onMouseDown={onToggleTurn as any}>
            {`  ${expanded ? "▾" : "▸"} ${t.steps.length} step${t.steps.length > 1 ? "s" : ""}`}
            {!expanded ? `   ${toolsUsed(t.steps)}` : ""}
          </text>
          {expanded &&
            t.steps.map((s, i) =>
              s.kind === "tool" ? (
                <ToolView
                  key={s.id}
                  m={s}
                  expanded={expTools.has(s.id)}
                  focused={focused?.kind === "tool" && focused.id === s.id}
                  onToggle={() => onToggleTool(s.id)}
                />
              ) : (
                <text key={i} fg="#9399b2">{`    · ${oneLine(s.text)}`}</text>
              ),
            )}
        </box>
      )}
      {t.final !== null ? (
        <box flexDirection="row">
          <text fg="#a6e3a1">{"⏺ "}</text>
          <markdown content={t.final} syntaxStyle={mdStyle} />
        </box>
      ) : (
        <Spinner />
      )}
    </box>
  )
}

function List({ sessions, cursor }: { sessions: readonly SessionView[]; cursor: number }) {
  return (
    <box flexDirection="column" padding={1}>
      <text fg="#888888">SESSIONS · n new · ↑↓ move · enter open · q quit</text>
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

function App() {
  const state = useAtomValue(appAtom)
  const busy = useAtomValue(busyAtom)
  const setApp = useAtomSet(appAtom)
  const newSession = useAtomSet(newSessionAtom)
  const [, send] = useAtom(sendAtom)
  const [text, setText] = useState("")
  const inputRef = useRef<any>(null)

  const [expTurns, setExpTurns] = useState<Set<number>>(new Set())
  const [expTools, setExpTools] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState(0)
  // reset collapse/focus when switching sessions
  useEffect(() => {
    setExpTurns(new Set())
    setExpTools(new Set())
    setFocus(0)
  }, [state.activeId])

  const active = state.sessions.find((s) => s.id === state.activeId) ?? null
  const inChat = state.view === "chat" && active !== null
  const turns = active ? toTurns(active.messages) : []
  const isExpanded = (t: Turn) => expTurns.has(t.idx) || t.final === null // in-progress auto-expands

  const focusables: Focusable[] = []
  for (const t of turns) {
    if (t.steps.length > 0) focusables.push({ kind: "turn", idx: t.idx })
    if (isExpanded(t)) for (const s of t.steps) if (s.kind === "tool") focusables.push({ kind: "tool", id: s.id })
  }
  const focusIdx = Math.min(focus, Math.max(0, focusables.length - 1))
  const focused = focusables[focusIdx]

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

  useKeyboard((k) => {
    if (k.ctrl && k.name === "c") process.exit(0)
    if (state.view === "list") {
      if (k.name === "q" || k.name === "escape") process.exit(0)
      if (k.name === "n") return void newSession()
      if (k.name === "up" || k.name === "k") return setApp((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }))
      if (k.name === "down" || k.name === "j")
        return setApp((s) => ({ ...s, cursor: Math.min(s.sessions.length - 1, s.cursor + 1) }))
      if (k.name === "return") {
        const target = state.sessions[state.cursor]
        if (target) setApp((s) => ({ ...s, view: "chat", activeId: target.id }))
      }
      return
    }
    // chat view
    const typing = text.length > 0
    if (k.name === "escape" || (!typing && k.name === "left")) {
      setText("")
      return setApp((s) => ({ ...s, view: "list" }))
    }
    if (typing) return // let the input handle typing + submit
    if (k.name === "up") return setFocus((f) => Math.max(0, f - 1))
    if (k.name === "down") return setFocus((f) => Math.min(focusables.length - 1, f + 1))
    if (k.name === "return" && focused) {
      if (focused.kind === "turn") toggleTurn(focused.idx)
      else toggleTool(focused.id)
    }
  })

  if (!inChat) {
    return (
      <box flexDirection="column" style={{ height: "100%" }}>
        <List sessions={state.sessions} cursor={state.cursor} />
      </box>
    )
  }

  return (
    <box flexDirection="column" style={{ height: "100%" }}>
      <text fg="#888888" style={{ paddingLeft: 1, paddingTop: 1 }}>
        {`${active.title} · ↑↓ focus · enter/click toggle · ← back${projectDoc ? ` · ${projectDoc} loaded` : ""}`}
      </text>
      <scrollbox style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} stickyScroll stickyStart="bottom" scrollY>
        {turns.map((t) => (
          <TurnView
            key={t.idx}
            t={t}
            expanded={isExpanded(t)}
            expTools={expTools}
            focused={focused}
            onToggleTurn={() => {
              setFocus(focusables.findIndex((f) => f.kind === "turn" && f.idx === t.idx))
              toggleTurn(t.idx)
            }}
            onToggleTool={(id) => {
              setFocus(focusables.findIndex((f) => f.kind === "tool" && f.id === id))
              toggleTool(id)
            }}
          />
        ))}
      </scrollbox>
      <box style={{ paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
        <input
          ref={inputRef}
          value={text}
          onInput={setText}
          onSubmit={
            ((v: string) => {
              send(v)
              setText("")
              // ponytail: opentui treats `value` as initial-only -> imperative reset.
              // Ceiling: bypasses React state for clear. Upgrade: opentui controlled value.
              if (inputRef.current) inputRef.current.value = ""
            }) as any
          }
          focused
          placeholder="message kimi (← back when empty)"
        />
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
