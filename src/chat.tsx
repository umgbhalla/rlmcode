// opentui (React) chat, inline mode, with session management.
//   list view : ↑/↓ (or j/k) move, Enter open session, n new, q/Esc quit
//   chat view : type + Enter to send, ← (empty input) or Esc back to list
// State + actions are Effect atoms (@effect/atom-react); every turn emits a
// trace/log/metric to motel.
import { RegistryProvider, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useState } from "react"
import { appAtom, type Msg, newSessionAtom, sendAtom, type SessionView } from "./atoms.ts"

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

function Chat({ session, busy }: { session: SessionView; busy: boolean }) {
  return (
    <box flexDirection="column" padding={1}>
      <text fg="#888888">{`${session.title} · ← back · esc list`}</text>
      {session.messages.map((m: Msg, i: number) => (
        <text key={i} fg={m.who === "you" ? "#66aaff" : "#55dd88"}>
          {m.who === "you" ? "› " : "🤖 "}
          {m.text}
        </text>
      ))}
    </box>
  )
}

function App() {
  const state = useAtomValue(appAtom)
  const setApp = useAtomSet(appAtom)
  const newSession = useAtomSet(newSessionAtom)
  const [, send] = useAtom(sendAtom)
  const [text, setText] = useState("")

  const active = state.sessions.find((s) => s.id === state.activeId) ?? null
  const inChat = state.view === "chat" && active !== null

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
    if (k.name === "escape" || (k.name === "left" && text.length === 0)) {
      setText("")
      setApp((s) => ({ ...s, view: "list" }))
    }
  })

  return (
    <box flexDirection="column">
      {inChat ? <Chat session={active} busy={false} /> : <List sessions={state.sessions} cursor={state.cursor} />}
      {inChat && (
        <box paddingLeft={1} paddingRight={1}>
          <input
            value={text}
            onInput={setText}
            onSubmit={
              ((v: string) => {
                send(v)
                setText("")
              }) as any
            }
            focused
            placeholder="message kimi (← back when empty)"
          />
        </box>
      )}
    </box>
  )
}

const renderer = await createCliRenderer({ screenMode: "main-screen", exitOnCtrlC: true })
createRoot(renderer).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>,
)
