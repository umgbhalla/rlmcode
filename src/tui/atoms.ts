// Effect "interface" for the opentui UI. Serializable view state lives in one
// atom; effectful actions (new session, send turn) run on the tracing runtime,
// so calling them from React both updates the UI and emits traces/logs/metrics.
import * as Effect from "effect/Effect"
import * as Tracer from "effect/Tracer"
import * as Atom from "effect/unstable/reactivity/Atom"
import { abortTurn, deleteSession, runTurn, seedSession, sessionsRT } from "../app/default-agent.ts"
import type { TurnEvent, TurnResult } from "../core/sdk.ts"
import { appRuntime } from "../otel.ts"

// The model id the session runs against — exported so the composer metadata row can name it
// (opencode prompt/index.tsx:1513-1518 model meta). The mock AI swaps the SERVICE, not this id,
// so the headless frame still shows the real model name.
export const MODEL = "@cf/moonshotai/kimi-k2.7-code"

// Provenance for a completed reply, rendered as one muted line under the turn.
export type TurnMeta = { readonly model: string; readonly ms: number; readonly tokens?: number | undefined; readonly finishReason?: string | undefined; readonly budget: boolean }

// A6 — MESSAGE seq + IDENTITY (opencode uniqueIndex(session_id, seq), sql.ts:118-137): every Msg
// minted into a session carries a MONOTONIC per-session `seq` + a stable `id`, minted ONCE on append
// and NEVER mutated. This replaces array-index-as-identity (the fragile bit behind the multi-session
// drift / resume-skip lessons) and is the seam A7 (durable store keyed (sessionId, seq)) builds on.
// seq is derived purely from the message list (max(seq)+1, see nextSeq) so it's a deterministic
// function of state — replay-safe, no external counter. Tool msgs already carry an `id` (the
// tool-call id); seq is added to every variant. NOT rendered — pure identity metadata.
export type Msg =
  | { readonly kind: "you"; readonly text: string; readonly seq: number; readonly id: string }
  // STREAMING: `thinking` holds the live/settled reasoning_content (rendered as a collapsible
  // block that auto-folds once `liveText`/`text` starts). `streaming` marks the in-flight reply
  // (drives the cursor + tells sendAtom to FINALIZE this message with the authoritative res.reply
  // rather than append a duplicate).
  // LIVE/COMMITTED SPLIT (F9): `liveText` is the TRANSIENT in-flight streamed reply buffer — grow()
  // appends each replyDelta HERE, never to `text`. The render shows `liveText ?? text` while
  // streaming, so a coarse/wrong live stream is shown ONLY transiently. finalize() builds the
  // canonical message FRESH (writes the authoritative reply to `text`, CLEARS liveText + streaming)
  // — the committed message is never an in-place overwrite of stale stream text. `text` stays the
  // canonical/committed field; on a settled non-streaming reply liveText is absent.
  | { readonly kind: "agent"; readonly text: string; readonly seq: number; readonly id: string; readonly meta?: TurnMeta; readonly thinking?: string; readonly streaming?: boolean; readonly liveText?: string | undefined }
  | {
      readonly kind: "tool"
      readonly seq: number
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
  // RATE-LIMIT VISIBILITY: the live retry status ("⏳ rate-limited · retry 2/3 · 4s") while a
  // transient (429/5xx) backoff is in flight — set by a `retry` NodeEvent, CLEARED the moment the
  // node makes progress (its next start/done/error). The tree row renders it as the node summary
  // (orch-tree summaryOf) and the composer surfaces it, so a 429 backoff is no longer silent.
  // undefined whenever the node is not currently backing off.
  readonly retry?: string | undefined
  // COST-METER: this node's OWN token usage (from its done NodeEvent). undefined until
  // the node settles (or if it ran without budget/usage tracking).
  readonly tokens?: number | undefined
  // PER-NODE TOOL ROUTING: this node's OWN ordered tool steps (a node is its own sub-agent —
  // it OWNS the bash/read/grep it loops). Each step is a tool Msg (call → result, updated in
  // place by id). Populated only for nodes whose forward ran a nodeId-tagged logger
  // (makeNodeLogger). undefined for nodes that ran no tools / the main turn (whose tools live
  // in the transcript). The DETAIL pane (node-detail.tsx) renders these as Activity call
  // one-liners; the tree itself shows only the COUNT (cost meter), never the tools.
  readonly tools?: ReadonlyArray<Extract<Msg, { kind: "tool" }>>
  // PER-NODE STREAM ROUTING + LIVE/COMMITTED SPLIT (F8/F9): the node's TRANSIENT streamed text —
  // grow() appends a node-tagged replyDelta HERE (never to `result` or the main transcript), so a
  // sub-agent that forwards with stream:true shows its live output under ITS node, isolated from the
  // main reply. Reconciled to the authoritative `result` at the node's `done` event (reduceNode
  // clears liveText), the SAME transient→committed shape the main reply uses (Msg.liveText). The
  // node detail pane renders liveText while running; absent once the node settles.
  readonly liveText?: string | undefined
  // ERROR BUBBLING (F5): how many of this node's OWN tools FAILED (a tool_result with isError).
  // Bubbled to the node one-liner (✗ N failed) + the row color so a running node with failed
  // child tools reads as warning, not healthy-muted, BEFORE the detail pane is opened. 0/absent
  // ⇒ no failures. Recomputed from the tools list on each tool_result so it stays exact.
  readonly failedTools?: number | undefined
}
// COST-METER: `totalTokens` is the live RUN TOTAL — the sum of every node's `tokens` as
// done events land. Rendered in the tree footer; never decreases (recompute from nodes).
export type OrchTree = { readonly nodes: Readonly<Record<string, OrchNode>>; readonly roots: ReadonlyArray<string>; readonly totalTokens: number }
export type SessionView = { readonly id: string; readonly title: string; readonly messages: ReadonlyArray<Msg>; readonly orch?: OrchTree }
type View = "list" | "chat"
export type AppState = {
  readonly view: View
  readonly activeId: string | null
  readonly cursor: number
  readonly sessions: ReadonlyArray<SessionView>
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
    seedSession(id, parent) // build the session cell with the richer chat.session root span
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

// A6 — mint the NEXT monotonic seq for a session's transcript: max(existing seq)+1, derived purely
// from the current message list so it's a deterministic function of state (replay-safe; no external
// counter to drift out of sync with the array). Node-owned tool steps (orch tree) are NOT in the
// main `messages` array, so their seq is minted off the same per-session counter at append time.
const nextSeq = (m: ReadonlyArray<Msg>): number => m.reduce((mx, x) => Math.max(mx, x.seq), -1) + 1
// A stable id for a non-tool Msg (tool msgs carry the tool-call id). seq is unique per session, so
// `<kind>-<seq>` is a stable per-session identity that never changes once minted.
const mintId = (kind: "you" | "agent", seq: number): string => `${kind}-${seq}`

// PER-NODE TOOL ROUTING: apply `fn` to a node's OWN tools list within the OrchTree. The node's
// `start` event always precedes its forward (runNode emits start, THEN forwards), so the node
// exists by the time its tools fire; if a tool somehow lands first we synthesize a minimal
// running node so the step is never dropped. Pure/immutable: returns a new tree.
const patchNodeTools = (
  t: OrchTree,
  nodeId: string,
  fn: (tools: ReadonlyArray<Extract<Msg, { kind: "tool" }>>) => ReadonlyArray<Extract<Msg, { kind: "tool" }>>,
): OrchTree => {
  const prev = t.nodes[nodeId]
  const base: OrchNode = prev ?? { id: nodeId, label: nodeId, phase: "", status: "running" }
  const tools = fn(base.tools ?? [])
  // ERROR BUBBLING (F5): recompute the failed-tool count from the (just-updated) tools list so a
  // node-tagged tool_result(isError) bubbles a ✗ N failed badge + warning color to the node row.
  const failedTools = tools.reduce((n, m) => n + (m.status === "error" ? 1 : 0), 0)
  const node: OrchNode = { ...base, tools, failedTools }
  const roots = prev === undefined && node.parentId === undefined && !t.roots.includes(nodeId) ? [...t.roots, nodeId] : t.roots
  return { ...t, nodes: { ...t.nodes, [nodeId]: node }, roots }
}

// STREAMING (MAIN turn): grow the in-flight streaming agent message in place, or start one if the
// trailing message isn't a live stream. Thinking arrives first (model reasons, then answers), so
// the first thinking_delta mints the message; reply_delta then grows it and chat.tsx auto-folds the
// thinking block.
// LIVE/COMMITTED SPLIT (F9): a reply delta grows the TRANSIENT `liveText` buffer, NOT the canonical
// `text` — so the in-flight stream and the committed message are SEPARATE fields. finalize() writes
// the authoritative reply to `text` + clears liveText, building the committed message fresh (never
// an in-place overwrite of stale stream text). The render shows `liveText ?? text` while streaming.
const grow = (m: ReadonlyArray<Msg>, field: "reply" | "thinking", text: string): ReadonlyArray<Msg> => {
  const last = m[m.length - 1]
  if (last?.kind === "agent" && last.streaming === true) {
    const next: Msg = field === "reply" ? { ...last, liveText: (last.liveText ?? "") + text } : { ...last, thinking: (last.thinking ?? "") + text }
    return [...m.slice(0, -1), next]
  }
  const seq = nextSeq(m)
  const id = mintId("agent", seq)
  const fresh: Msg = field === "reply" ? { kind: "agent", seq, id, text: "", liveText: text, streaming: true } : { kind: "agent", seq, id, text: "", thinking: text, streaming: true }
  return [...m, fresh]
}

// STREAMING (PER-NODE, F8): grow a NODE's TRANSIENT streamed text within the OrchTree. A node-tagged
// replyDelta appends to node.liveText; a thinkingDelta is folded into the same transient buffer (a
// node has no separate reasoning block in the tree — its detail pane shows the live text tail). This
// is the routing that keeps a streaming sub-agent's output OFF the main transcript: it lands under
// THAT node, reconciled to the authoritative `result` at the node's `done` event (reduceNode). The
// node's `start` always precedes its stream; a stray pre-start delta synthesizes a running node so
// the text is never dropped (mirrors patchNodeTools). Pure/immutable.
const growNode = (t: OrchTree, nodeId: string, text: string): OrchTree => {
  const prev = t.nodes[nodeId]
  const base: OrchNode = prev ?? { id: nodeId, label: nodeId, phase: "", status: "running" }
  const node: OrchNode = { ...base, liveText: (base.liveText ?? "") + text }
  const roots = prev === undefined && node.parentId === undefined && !t.roots.includes(nodeId) ? [...t.roots, nodeId] : t.roots
  return { ...t, nodes: { ...t.nodes, [nodeId]: node }, roots }
}

// Fold ONE non-terminal TurnEvent into the live transcript / orch tree. Mirrors the old
// activity-sink switch, now keyed on the FLAT serializable TurnEvent (run.ts) instead of the
// internal Activity union. The terminal {type:'reply'} is NOT handled here — sendAtom finalizes
// it ONCE (final-reply-once: the reply prose arrives only via that arm). node events feed the
// SAME OrchTree reducer the TUI already renders (tui/orch-tree.ts flattens it).
const applyEvent = (
  ev: TurnEvent,
  patch: (fn: (m: ReadonlyArray<Msg>) => ReadonlyArray<Msg>) => void,
  orchPatch: (fn: (t: OrchTree) => OrchTree) => void,
): void => {
  switch (ev.type) {
    case "message":
      patch((m) => {
        const seq = nextSeq(m)
        return [...m, { kind: "agent", seq, id: mintId("agent", seq), text: ev.text }]
      })
      break
    case "reply_delta":
      // PER-NODE STREAM ROUTING (F8): a tagged delta (nodeId set) is a sub-agent NODE's stream —
      // grow THAT node's transient text, NEVER the main transcript. Untagged ⇒ the main reply.
      if (ev.nodeId !== undefined) orchPatch((t) => growNode(t, ev.nodeId!, ev.text))
      else patch((m) => grow(m, "reply", ev.text))
      break
    case "thinking_delta":
      if (ev.nodeId !== undefined) orchPatch((t) => growNode(t, ev.nodeId!, ev.text))
      else patch((m) => grow(m, "thinking", ev.text))
      break
    case "tool_call": {
      const mk = (seq: number): Extract<Msg, { kind: "tool" }> => ({ kind: "tool", seq, id: ev.id, name: ev.name, args: ev.args, status: "running", result: "", startedAt: Date.now() })
      // PER-NODE TOOL ROUTING: a tagged tool (nodeId set) belongs to that orchestration NODE —
      // append it to the node's OWN tools list (NodeView renders it under the node). An untagged
      // tool is the MAIN turn's — append to the transcript (unchanged default). seq is minted off
      // the destination list (the node's tools, or the main transcript) so it's monotonic per list.
      if (ev.nodeId !== undefined) orchPatch((t) => patchNodeTools(t, ev.nodeId!, (tools) => [...tools, mk(nextSeq(tools))]))
      else patch((m) => [...m, mk(nextSeq(m))])
      break
    }
    case "tool_result": {
      const settle = (x: Msg): Msg =>
        x.kind === "tool" && x.id === ev.id ? { ...x, status: ev.isError ? "error" : "ok", result: ev.result } : x
      if (ev.nodeId !== undefined) orchPatch((t) => patchNodeTools(t, ev.nodeId!, (tools) => tools.map(settle) as typeof tools))
      else patch((m) => m.map(settle))
      break
    }
    case "node":
      orchPatch((t) => reduceNode(t, ev))
      break
    case "reply":
      // TERMINAL — handled by sendAtom's finalize (final-reply-once). Never folded here.
      break
  }
}

// START-mint a node, carrying forward any already-known per-node state (tools/tokens/result/
// failedTools survive a re-start). Extracted so reduceNode stays under its cyclomatic budget.
const mintNode = (prev: OrchNode | undefined, ev: Extract<TurnEvent, { type: "node" }>, parentId: string | undefined): OrchNode => ({
  id: ev.nodeId,
  ...(parentId !== undefined ? { parentId } : {}),
  label: ev.detail ?? ev.nodeId,
  phase: ev.detail ?? "",
  status: prev?.status ?? "running",
  ...(prev?.result !== undefined ? { result: prev.result } : {}),
  ...(prev?.tokens !== undefined ? { tokens: prev.tokens } : {}),
  ...(prev?.tools !== undefined ? { tools: prev.tools } : {}),
  ...(prev?.failedTools !== undefined ? { failedTools: prev.failedTools } : {}),
  // PER-NODE STREAM (F8): carry the transient streamed text across a re-start (it survives until the
  // node settles, then reduceNode clears it onto the authoritative result).
  ...(prev?.liveText !== undefined ? { liveText: prev.liveText } : {}),
})

// The OrchTree node reducer (start mints, delta/done/error update in place), unchanged from the
// old activity sink — just sourced from the flat node TurnEvent. parentId travels on start; on
// delta/done/error it's undefined, so ALWAYS keep the previously-known parentId.
const reduceNode = (t: OrchTree, ev: Extract<TurnEvent, { type: "node" }>): OrchTree => {
  const prev = t.nodes[ev.nodeId]
  const parentId = ev.parentId ?? prev?.parentId
  if (ev.event === "start") {
    const node = mintNode(prev, ev, parentId)
    const isRoot = parentId === undefined
    return {
      nodes: { ...t.nodes, [ev.nodeId]: node },
      roots: isRoot && !t.roots.includes(ev.nodeId) ? [...t.roots, ev.nodeId] : t.roots,
      totalTokens: t.totalTokens,
    }
  }
  if (prev === undefined) return t
  const parentPatch = parentId !== undefined ? { parentId } : {}
  // RATE-LIMIT VISIBILITY: a `retry` event sets the live `retry` STATUS (its detail is the
  // formatted "⏳ rate-limited · retry 2/3 · 4s" from orch.retryStatus) and leaves the node
  // RUNNING — it routes detail to `retry`, NOT to `result` (the node hasn't produced anything).
  // Every OTHER non-start event CLEARS `retry` (set to undefined): a delta means the node resumed
  // making progress, and done/error means it settled — so the backoff badge never lingers.
  if (ev.event === "retry") {
    const node: OrchNode = { ...prev, ...parentPatch, status: "running", retry: ev.detail }
    return { ...t, nodes: { ...t.nodes, [ev.nodeId]: node } }
  }
  const resultPatch = ev.detail !== undefined ? { result: ev.detail } : {}
  const tokensPatch = ev.event === "done" && ev.tokens !== undefined ? { tokens: ev.tokens } : {}
  // LIVE/COMMITTED SPLIT (F9, per-node): on done/error the node SETTLES — clear the transient
  // streamed text (liveText) onto the authoritative `result` (resultPatch), so a coarse live stream
  // is never the committed node payload (the same transient→committed reconcile the main reply does
  // in finalize()). A `delta` event leaves liveText intact (the stream is still in flight).
  const next: OrchNode =
    ev.event === "done"
      ? { ...prev, ...parentPatch, status: "done", retry: undefined, liveText: undefined, ...resultPatch, ...tokensPatch }
      : ev.event === "error"
        ? { ...prev, ...parentPatch, status: "error", retry: undefined, liveText: undefined, ...resultPatch }
        : { ...prev, ...parentPatch, retry: undefined }
  const nodes = { ...t.nodes, [ev.nodeId]: next }
  const totalTokens = Object.values(nodes).reduce((sum, n) => sum + (n.tokens ?? 0), 0)
  return { ...t, nodes, totalTokens }
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

    const patch = (fn: (m: ReadonlyArray<Msg>) => ReadonlyArray<Msg>) => {
      const cur = get(appAtom)
      get.set(appAtom, {
        ...cur,
        sessions: cur.sessions.map((x) => {
          if (x.id !== id) return x
          if (x.orch !== undefined) return { id: x.id, title: x.title, messages: fn(x.messages), orch: x.orch }
          return { id: x.id, title: x.title, messages: fn(x.messages) }
        }),
      })
    }

    const orchPatch = (fn: (t: OrchTree) => OrchTree) => {
      const cur = get(appAtom)
      get.set(appAtom, {
        ...cur,
        sessions: cur.sessions.map((x) => {
          if (x.id !== id) return x
          return { id: x.id, title: x.title, messages: x.messages, orch: fn(x.orch ?? { nodes: {}, roots: [], totalTokens: 0 }) }
        }),
      })
    }

    patch((m) => {
      const seq = nextSeq(m)
      return [...m, { kind: "you", seq, id: mintId("you", seq), text }]
    })
    get.set(busyAtom, true)
    get.set(busySessionsAtom, new Set(get(busySessionsAtom)).add(id))

    const startedAt = Date.now()
    // CONSUME runTurn: a plain AsyncGenerator of FLAT, serializable TurnEvents. Effect runs
    // INSIDE runTurn (on coreRuntime); here we just for-await. Non-terminal events fold into the
    // transcript / orch tree (applyEvent); the SINGLE terminal {type:'reply'} carries the final
    // reply prose and is the ONLY place we set it (final-reply-once). The turn-failure '⚠'
    // mapping now lives in runTurn — atoms no longer catches the Cause.
    yield* Effect.promise(async () => {
      let result: TurnResult | null = null
      for await (const ev of runTurn(id, text)) {
        if (ev.type === "reply") result = ev.result
        else applyEvent(ev, patch, orchPatch)
      }
      get.set(busyAtom, false)
      get.set(busySessionsAtom, ((cur) => (cur.delete(id), cur))(new Set(get(busySessionsAtom))))
      // result is ALWAYS set: runTurn yields exactly one reply, always last.
      const reply = result?.reply ?? ""
      const meta: TurnMeta = {
        model: MODEL,
        ms: Date.now() - startedAt,
        tokens: result?.usage.total,
        // finishReason is provider-wire and was dropped from the normalized TurnResult; the
        // UI line falls back to model + tokens. budget = the turn finalized at the step ceiling.
        finishReason: undefined,
        budget: result?.stopReason === "max_steps",
      }
      // FINALIZE (F9 live/committed split): build the committed message FRESH from the AUTHORITATIVE
      // reply — write it to the canonical `text`, stamp meta, CLEAR `streaming` AND the transient
      // `liveText` buffer. The committed message is never an in-place overwrite of stale stream text;
      // the live buffer that grew during the turn is discarded in favor of the authoritative reply
      // (correct even if the deltas were coarse/absent). Otherwise append a fresh row.
      patch((m) => {
        const last = m[m.length - 1]
        if (last?.kind === "agent" && last.streaming === true) {
          return [...m.slice(0, -1), { ...last, text: reply, meta, streaming: false, liveText: undefined }]
        }
        const seq = nextSeq(m)
        return [...m, { kind: "agent", seq, id: mintId("agent", seq), text: reply, meta }]
      })
    })
  }),
)
