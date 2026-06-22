// Effect "interface" for the opentui UI. Serializable view state lives in one
// atom; effectful actions (new session, send turn) run on the tracing runtime,
// so calling them from React both updates the UI and emits traces/logs/metrics.
import { AxMemory } from "@ax-llm/ax"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Tracer from "effect/Tracer"
import * as Atom from "effect/unstable/reactivity/Atom"
import { setActivitySink } from "../core/activity.ts"
import { abortTurn, turn } from "../core/agent.ts"
import { appRuntime } from "../otel.ts"
import { deleteSession, sessionsRT } from "../core/sessions.ts"

const MODEL = "@cf/moonshotai/kimi-k2.7-code"

// Provenance for a completed reply, rendered as one muted line under the turn.
export type TurnMeta = { readonly model: string; readonly ms: number; readonly tokens?: number | undefined; readonly finishReason?: string | undefined; readonly budget: boolean }

export type Msg =
  | { readonly kind: "you"; readonly text: string }
  // STREAMING: `thinking` holds the live/settled reasoning_content (rendered as a collapsible
  // block that auto-folds once `text` starts). `streaming` marks the in-flight reply (drives
  // the cursor + tells sendAtom to FINALIZE this message in place with the authoritative
  // res.reply rather than append a duplicate). Both absent on a plain non-streaming reply.
  | { readonly kind: "agent"; readonly text: string; readonly meta?: TurnMeta; readonly thinking?: string; readonly streaming?: boolean }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly args: string
      readonly status: "running" | "ok" | "error"
      readonly result: string
      // wall-clock ms when the call started; drives the per-tool "running 12s" elapsed.
      readonly startedAt?: number
    }
// A live orchestration node (orch.emit NodeEvents, projected from the activity bus).
// status: running until a done/error event lands; result holds the done payload or
// error cause (clipped upstream). roots preserves first-seen order of top-level nodes.
export type OrchNode = {
  readonly id: string
  readonly parentId?: string | undefined
  readonly label: string
  readonly phase: string
  readonly status: "running" | "done" | "error"
  readonly result?: string | undefined
  // COST-METER: this node's OWN token usage (from its done NodeEvent). undefined until
  // the node settles (or if it ran without budget/usage tracking).
  readonly tokens?: number | undefined
  // PER-NODE TOOL ROUTING: this node's OWN ordered tool steps (a node is its own sub-agent —
  // it OWNS the bash/read/grep it loops). Each step is a tool Msg (call → result, updated in
  // place by id). Populated only for nodes whose forward ran a nodeId-tagged logger
  // (makeNodeLogger). undefined for nodes that ran no tools / the main turn (whose tools live
  // in the transcript). NodeView renders these under the node, reusing ToolView.
  readonly tools?: readonly Extract<Msg, { kind: "tool" }>[]
}
// COST-METER: `totalTokens` is the live RUN TOTAL — the sum of every node's `tokens` as
// done events land. Rendered in the tree footer; never decreases (recompute from nodes).
export type OrchTree = { readonly nodes: Readonly<Record<string, OrchNode>>; readonly roots: readonly string[]; readonly totalTokens: number }
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

// True while ANY turn is in flight (drives the composer spinner of the active session).
export const busyAtom = Atom.make(false).pipe(Atom.keepAlive)

// Which sessions have a turn in flight — the list view needs PER-session liveness, not
// one global boolean (with 2+ sessions a single bool can't say WHICH is working).
export const busySessionsAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive)

const idState = { seq: 0 }
const newId = () => `s${++idState.seq}-${Date.now().toString(36)}`

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

/**
 * Close a session: abort any in-flight turn, DROP its non-serializable runtime objects
 * (the sessionsRT entry — AxMemory + root span handle) so a long-running process doesn't
 * leak dead sessions, and remove its serializable view, fixing the cursor/activeId/view.
 * The sessionsRT Map was previously never cleaned (newSessionAtom set, nothing deleted).
 */
export const deleteSessionAtom = appRuntime.fn((id: string, get) =>
  Effect.gen(function* () {
    const s = get(appAtom)
    const idx = s.sessions.findIndex((x) => x.id === id)
    if (idx === -1) return
    abortTurn(id) // stop a running turn so its fiber doesn't write to a dropped session
    get.set(busySessionsAtom, ((bs) => (bs.delete(id), bs))(new Set(get(busySessionsAtom))))
    deleteSession(id) // LEAK FIX: release the AxMemory + span handle held in sessionsRT
    const sessions = s.sessions.filter((x) => x.id !== id)
    // If we closed the active/last session, fall back to the list; otherwise keep the
    // remaining selection sane (clamp the cursor, drop activeId if it was this one).
    const wasActive = s.activeId === id
    const cursor = Math.max(0, Math.min(sessions.length - 1, s.cursor > idx ? s.cursor - 1 : s.cursor))
    get.set(appAtom, {
      view: wasActive ? "list" : s.view,
      activeId: wasActive ? null : s.activeId,
      cursor,
      sessions,
    })
    yield* Effect.logInfo("session.delete").pipe(Effect.annotateLogs({ "session.id": id }))
  }),
)

// PER-NODE TOOL ROUTING: apply `fn` to a node's OWN tools list within the OrchTree. The node's
// `start` event always precedes its forward (runNode emits start, THEN forwards), so the node
// exists by the time its tools fire; if a tool somehow lands first we synthesize a minimal
// running node so the step is never dropped. Pure/immutable: returns a new tree.
const patchNodeTools = (
  t: OrchTree,
  nodeId: string,
  fn: (tools: readonly Extract<Msg, { kind: "tool" }>[]) => readonly Extract<Msg, { kind: "tool" }>[],
): OrchTree => {
  const prev = t.nodes[nodeId]
  const base: OrchNode = prev ?? { id: nodeId, label: nodeId, phase: "", status: "running" }
  const node: OrchNode = { ...base, tools: fn(base.tools ?? []) }
  const roots = prev === undefined && node.parentId === undefined && !t.roots.includes(nodeId) ? [...t.roots, nodeId] : t.roots
  return { ...t, nodes: { ...t.nodes, [nodeId]: node }, roots }
}

// Wire the activity bus to the live transcript for one in-flight turn: narration/tool/
// result rows patch messages; node events (emitted by the agent's orchestrate tool mid-
// turn) patch the orch tree.
const installSink = (
  patch: (fn: (m: readonly Msg[]) => readonly Msg[]) => void,
  orchPatch: (fn: (t: OrchTree) => OrchTree) => void,
) => {
  // STREAMING: grow the in-flight streaming agent message in place (append to its reply text
  // or its thinking), or start one if the trailing message isn't a live stream. Thinking
  // arrives first (model reasons, then answers), so the first thinkingDelta mints the message
  // with empty text; replyDelta then grows text and chat.tsx auto-folds the thinking block.
  const grow = (m: readonly Msg[], field: "reply" | "thinking", text: string): readonly Msg[] => {
    const last = m[m.length - 1]
    if (last?.kind === "agent" && last.streaming === true) {
      const next: Msg = field === "reply" ? { ...last, text: last.text + text } : { ...last, thinking: (last.thinking ?? "") + text }
      return [...m.slice(0, -1), next]
    }
    const fresh: Msg = field === "reply" ? { kind: "agent", text, streaming: true } : { kind: "agent", text: "", thinking: text, streaming: true }
    return [...m, fresh]
  }
  setActivitySink((a) => {
    switch (a.kind) {
      case "text":
        patch((m) => [...m, { kind: "agent", text: a.text }])
        break
      case "replyDelta":
        patch((m) => grow(m, "reply", a.text))
        break
      case "thinkingDelta":
        patch((m) => grow(m, "thinking", a.text))
        break
      case "tool": {
        const step: Msg = { kind: "tool", id: a.id, name: a.name, args: a.args, status: "running", result: "", startedAt: Date.now() }
        // PER-NODE TOOL ROUTING: a tagged tool (nodeId set) belongs to that orchestration NODE —
        // append it to the node's OWN tools list (NodeView renders it under the node). An untagged
        // tool is the MAIN turn's — append to the transcript (unchanged default).
        if (a.nodeId !== undefined) orchPatch((t) => patchNodeTools(t, a.nodeId!, (tools) => [...tools, step]))
        else patch((m) => [...m, step])
        break
      }
      case "result": {
        const settle = (x: Msg): Msg =>
          x.kind === "tool" && x.id === a.id ? { ...x, status: a.isError ? "error" : "ok", result: a.result } : x
        // Update the matching tool row in place — under the owning node when tagged, else in the
        // transcript. (A result's nodeId mirrors the call's, set by the same per-node logger.)
        if (a.nodeId !== undefined) orchPatch((t) => patchNodeTools(t, a.nodeId!, (tools) => tools.map(settle) as typeof tools))
        else patch((m) => m.map(settle))
        break
      }
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
              ...(parentId !== undefined ? { parentId } : {}),
              label: a.detail ?? a.nodeId,
              phase: a.detail ?? "",
              status: prev?.status ?? "running",
              ...(prev?.result !== undefined ? { result: prev.result } : {}),
              ...(prev?.tokens !== undefined ? { tokens: prev.tokens } : {}),
              // PER-NODE TOOL ROUTING: preserve any tools already collected (a tool can land
              // before/with the start event under concurrency) so the start never drops them.
              ...(prev?.tools !== undefined ? { tools: prev.tools } : {}),
            }
            const isRoot = parentId === undefined
            return {
              nodes: { ...t.nodes, [a.nodeId]: node },
              roots: isRoot && !t.roots.includes(a.nodeId) ? [...t.roots, a.nodeId] : t.roots,
              totalTokens: t.totalTokens,
            }
          }
          // delta/done/error update an existing node in place; ignore unknown ids.
          if (prev === undefined) return t
          const parentPatch = parentId !== undefined ? { parentId } : {}
          const resultPatch = a.detail !== undefined ? { result: a.detail } : {}
          // COST-METER: a done event carries this node's per-node tokens — fold it onto the
          // node, then recompute the run total as the sum of every node's tokens (idempotent:
          // a re-emitted done overwrites the same node's tokens, never double-counts).
          const tokensPatch = a.event === "done" && a.tokens !== undefined ? { tokens: a.tokens } : {}
          const next: OrchNode =
            a.event === "done"
              ? { ...prev, ...parentPatch, status: "done", ...resultPatch, ...tokensPatch }
              : a.event === "error"
                ? { ...prev, ...parentPatch, status: "error", ...resultPatch }
                : { ...prev, ...parentPatch } // delta: streaming chunk, no status change (tree shows phase only)
          const nodes = { ...t.nodes, [a.nodeId]: next }
          const totalTokens = Object.values(nodes).reduce((sum, n) => sum + (n.tokens ?? 0), 0)
          return { ...t, nodes, totalTokens }
        })
        break
    }
  })
}

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
        sessions: cur.sessions.map((x) => (x.id === id ? { ...x, orch: fn(x.orch ?? { nodes: {}, roots: [], totalTokens: 0 }) } : x)),
      })
    }

    patch((m) => [...m, { kind: "you", text }])
    get.set(busyAtom, true)
    get.set(busySessionsAtom, new Set(get(busySessionsAtom)).add(id))

    // Step-by-step activity from ax's native logger: agent narration, tool
    // calls (in-flight), and results (which update the matching row in place).
    installSink(patch, orchPatch)

    const startedAt = Date.now()
    const res = yield* turn(rt.mem, rt.parent, id)(text).pipe(
      // Clean, one-line error instead of dumping the whole Cause/stack.
      Effect.catchCause((c) => {
        const e = Cause.squash(c) as { cause?: { message?: string }; message?: string }
        const raw = e?.cause?.message ?? e?.message ?? String(e)
        // GRACEFUL MAX-STEPS removed the "max steps reached" throw (turn() now finalizes
        // in-loop with tools stripped, never throwing that string), so only abort + the
        // raw first line remain — the old max-steps string-match branch is dead.
        const msg = /abort/i.test(raw) ? "Interrupted." : raw.split("\n")[0]!.slice(0, 240)
        return Effect.succeed({ reply: `⚠ ${msg}`, tokens: undefined, finishReason: undefined, budget: false })
      }),
    )

    setActivitySink(null)
    get.set(busyAtom, false)
    get.set(busySessionsAtom, ((s) => (s.delete(id), s))(new Set(get(busySessionsAtom))))
    const meta: TurnMeta = {
      model: MODEL,
      ms: Date.now() - startedAt,
      tokens: res.tokens,
      finishReason: res.finishReason,
      budget: res.budget,
    }
    // FINALIZE: if the reply streamed live, reconcile that in-flight message to the
    // AUTHORITATIVE res.reply (correct even if the live deltas were coarse/absent), stamp meta,
    // clear `streaming` (drops the cursor; keeps the thinking block). Otherwise (non-streaming
    // provider, or an error short-circuit) append the reply as a fresh row — the unchanged path.
    patch((m) => {
      const last = m[m.length - 1]
      if (last?.kind === "agent" && last.streaming === true) {
        return [...m.slice(0, -1), { ...last, text: res.reply, meta, streaming: false }]
      }
      return [...m, { kind: "agent", text: res.reply, meta }]
    })
  }),
)
