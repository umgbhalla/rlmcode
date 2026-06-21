// Effect "interface" for the opentui UI. Serializable view state lives in one
// atom; effectful actions (new session, send turn) run on the tracing runtime,
// so calling them from React both updates the UI and emits traces/logs/metrics.
import { AxMemory } from "@ax-llm/ax"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Tracer from "effect/Tracer"
import * as Atom from "effect/unstable/reactivity/Atom"
import { turn } from "./agent.ts"
import { appRuntime } from "./otel.ts"
import { sessionsRT } from "./sessions.ts"

const MODEL = "@cf/moonshotai/kimi-k2.7-code"

export type Msg = { readonly who: "you" | "kimi"; readonly text: string }
export type SessionView = { readonly id: string; readonly title: string; readonly messages: readonly Msg[] }
export type View = "list" | "chat"
export type AppState = {
  readonly view: View
  readonly activeId: string | null
  readonly cursor: number
  readonly sessions: readonly SessionView[]
}

export const appAtom = Atom.make<AppState>({
  view: "list",
  activeId: null,
  cursor: 0,
  sessions: [],
}).pipe(Atom.keepAlive)

let seq = 0
const newId = () => `s${++seq}-${Date.now().toString(36)}`

/** Create a session: AxMemory + long-lived chat.session root span, then open it. */
export const newSessionAtom = appRuntime.fn((_: void, get) =>
  Effect.gen(function* () {
    const id = newId()
    // Open+close a brief root span to establish the session's traceId/rootSpanId,
    // then keep an ExternalSpan handle so every later turn (a separate fiber)
    // parents to it -> one shared trace per session.
    const parent = yield* Effect.useSpan(
      "chat.session",
      { kind: "server", attributes: { "session.id": id, "gen_ai.request.model": MODEL } },
      (span) => Effect.succeed(Tracer.externalSpan({ traceId: span.traceId, spanId: span.spanId, sampled: true })),
    )
    sessionsRT.set(id, { mem: new AxMemory(), parent })
    const s = get(appAtom)
    const view: SessionView = { id, title: `session ${s.sessions.length + 1}`, messages: [] }
    get.set(appAtom, {
      view: "chat",
      activeId: id,
      cursor: s.sessions.length,
      sessions: [...s.sessions, view],
    })
    yield* Effect.logInfo("session.new").pipe(Effect.annotateLogs({ "session.id": id }))
  }),
)

/** Send a message in the active session: append user -> traced turn -> append reply. */
export const sendAtom = appRuntime.fn((message: string, get) =>
  Effect.gen(function* () {
    const text = message.trim()
    const s = get(appAtom)
    if (text.length === 0 || s.activeId === null) return
    const id = s.activeId
    const rt = sessionsRT.get(id)
    if (rt === undefined) return

    const patch = (fn: (m: readonly Msg[]) => readonly Msg[]) => {
      const cur = get(appAtom)
      get.set(appAtom, {
        ...cur,
        sessions: cur.sessions.map((x) => (x.id === id ? { ...x, messages: fn(x.messages) } : x)),
      })
    }

    patch((m) => [...m, { who: "you", text }])
    const reply = yield* turn(rt.mem, rt.parent, id)(text).pipe(
      Effect.catchCause((c) => Effect.succeed(`⚠ ${Cause.pretty(c)}`)),
    )
    patch((m) => [...m, { who: "kimi", text: reply }])
  }),
)
