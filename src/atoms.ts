// Effect "interface" for the opentui UI. Serializable view state lives in one
// atom; effectful actions (new session, send turn) run on the tracing runtime,
// so calling them from React both updates the UI and emits traces/logs/metrics.
import { AxMemory } from "@ax-llm/ax"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Tracer from "effect/Tracer"
import * as Atom from "effect/unstable/reactivity/Atom"
import { setActivitySink } from "./activity.ts"
import { turn } from "./agent.ts"
import { appRuntime } from "./otel.ts"
import { sessionsRT } from "./sessions.ts"

const MODEL = "@cf/moonshotai/kimi-k2.7-code"

// Provenance for a completed reply, rendered as one muted line under the turn.
export type TurnMeta = { readonly model: string; readonly ms: number; readonly tokens?: number; readonly finishReason?: string; readonly budget: boolean }

export type Msg =
  | { readonly kind: "you"; readonly text: string }
  | { readonly kind: "agent"; readonly text: string; readonly meta?: TurnMeta }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly args: string
      readonly status: "running" | "ok" | "error"
      readonly result: string
    }
export type SessionView = { readonly id: string; readonly title: string; readonly messages: readonly Msg[] }
type View = "list" | "chat"
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

// True while a turn is in flight (drives the thinking spinner).
export const busyAtom = Atom.make(false).pipe(Atom.keepAlive)

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

    patch((m) => [...m, { kind: "you", text }])
    get.set(busyAtom, true)

    // Step-by-step activity from ax's native logger: agent narration, tool
    // calls (in-flight), and results (which update the matching row in place).
    setActivitySink((a) => {
      switch (a.kind) {
        case "text":
          patch((m) => [...m, { kind: "agent", text: a.text }])
          break
        case "tool":
          patch((m) => [...m, { kind: "tool", id: a.id, name: a.name, args: a.args, status: "running", result: "" }])
          break
        case "result":
          patch((m) =>
            m.map((x) => (x.kind === "tool" && x.id === a.id ? { ...x, status: a.isError ? "error" : "ok", result: a.result } : x)),
          )
          break
        case "node":
          // ponytail: orchestration node lifecycle is span-only for now; no TUI row.
          // Ceiling: orch nodes are invisible in the transcript. Upgrade: render a
          // collapsible node tree (parentId->nodeId) in chat.tsx (orch-tree).
          break
      }
    })

    const startedAt = Date.now()
    const res = yield* turn(rt.mem, rt.parent, id)(text).pipe(
      // Clean, one-line error instead of dumping the whole Cause/stack.
      Effect.catchCause((c) => {
        const e = Cause.squash(c) as { cause?: { message?: string }; message?: string }
        const raw = e?.cause?.message ?? e?.message ?? String(e)
        const msg = /abort/i.test(raw)
          ? "Interrupted."
          : /max steps reached/i.test(raw)
            ? "Hit the step limit while working — see the steps above. Narrow the task, or ask me to continue."
            : raw.split("\n")[0]!.slice(0, 240)
        return Effect.succeed({ reply: `⚠ ${msg}`, tokens: undefined, finishReason: undefined, budget: false })
      }),
    )

    setActivitySink(null)
    get.set(busyAtom, false)
    const meta: TurnMeta = {
      model: MODEL,
      ms: Date.now() - startedAt,
      tokens: res.tokens,
      finishReason: res.finishReason,
      budget: res.budget,
    }
    patch((m) => [...m, { kind: "agent", text: res.reply, meta }])
  }),
)
