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
// A live orchestration node (orch.emit NodeEvents, projected from the activity bus).
// status: running until a done/error event lands; result holds the done payload or
// error cause (clipped upstream). roots preserves first-seen order of top-level nodes.
export type OrchNode = {
  readonly id: string
  readonly parentId?: string
  readonly label: string
  readonly phase: string
  readonly status: "running" | "done" | "error"
  readonly result?: string
}
export type OrchTree = { readonly nodes: Readonly<Record<string, OrchNode>>; readonly roots: readonly string[] }
export type SessionView = { readonly id: string; readonly title: string; readonly messages: readonly Msg[]; readonly orch?: OrchTree }
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

    const orchPatch = (fn: (t: OrchTree) => OrchTree) => {
      const cur = get(appAtom)
      get.set(appAtom, {
        ...cur,
        sessions: cur.sessions.map((x) => (x.id === id ? { ...x, orch: fn(x.orch ?? { nodes: {}, roots: [] }) } : x)),
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
          orchPatch((t) => {
            const prev = t.nodes[a.nodeId]
            // parentId is carried on start; on delta/done/error it's undefined, so
            // ALWAYS keep the previously-known parentId — a child that resolves
            // before its parent's start event never drops its edge.
            const parentId = a.parentId ?? prev?.parentId
            if (a.event === "start") {
              const node: OrchNode = {
                id: a.nodeId,
                parentId,
                label: a.detail ?? a.nodeId,
                phase: a.detail ?? "",
                status: prev?.status ?? "running",
                result: prev?.result,
              }
              const isRoot = parentId === undefined
              return {
                nodes: { ...t.nodes, [a.nodeId]: node },
                roots: isRoot && !t.roots.includes(a.nodeId) ? [...t.roots, a.nodeId] : t.roots,
              }
            }
            // delta/done/error update an existing node in place; ignore unknown ids.
            if (prev === undefined) return t
            const next: OrchNode =
              a.event === "done"
                ? { ...prev, parentId, status: "done", result: a.detail }
                : a.event === "error"
                  ? { ...prev, parentId, status: "error", result: a.detail }
                  : { ...prev, parentId } // delta: streaming chunk, no status change (tree shows phase only)
            return { ...t, nodes: { ...t.nodes, [a.nodeId]: next } }
          })
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
