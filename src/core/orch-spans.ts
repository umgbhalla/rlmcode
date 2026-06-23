// SPAN GRANULARITY (telemetry leap 2b) — mirror the live NodeEvent tree as REAL OTel
// child spans so the motel TRACE shows where a slow run's time went, not one opaque blob.
//
// THE GAP: orch.emit() (orch.ts) maps each NodeEvent to an Activity (live UI tree) AND a
// span.addEvent() on the ACTIVE span — but addEvent is a point-in-time marker, not a
// timed child span. So run_rlm / orchestrate were single opaque spans: their internal
// stages/turns (rlm:distiller, rlm:executor turn N, branch i, judge, …) emitted only
// events, and the trace couldn't show per-node timing.
//
// THE FIX: a nodeId → Span registry. On a node 'start' we START a real child span
// (parented to its parentId's span when known, else the ambient active span) and stamp
// the phase. On 'done'/'error' we END it, stamping tokens / result / status. emit() calls
// these alongside its existing addEvent, so the SAME NodeEvent stream that drives the live
// tree now also produces a nested span subtree: run_rlm → distiller → executor turn 1..N →
// responder (and orchestrate → branch i → judge), each with its own wall-clock + tokens.
//
// Concurrency: parallel branches each carry a DISTINCT nodeId, so their spans are distinct
// registry entries — no interleaving. The registry is keyed by nodeId (the same id the live
// tree routes on), so a child resolving before/after its parent still nests correctly via
// the recorded parent context.
import {
  type Context as OtelContext,
  type Span,
  type Tracer,
  context as otelContext,
  trace as otelTrace,
} from "@opentelemetry/api"

// One open child span per live nodeId, plus the OTel Context that carries it (so a child
// node started later can parent under it). Module-level + keyed by nodeId: turns are
// serialized (busyAtom) and every nodeId is unique per run, so no cross-run collision.
type Entry = { span: Span; ctx: OtelContext }
const open = new Map<string, Entry>()

// The tracer to mint node spans with. agent.ts's turn() (and the orchestrate/RLM tool
// boundaries, for the live harness which has no turn()) set it from the SAME exporting
// OtelTracerProvider that turn() hands to ax — so node spans + ax's gen_ai spans share one
// exporter. Until set, node-span minting is a no-op (the live tree + addEvent path still
// works — spans are purely additive). NOT the global trace.getTracer: NodeSdk consumes its
// provider internally, so the global is a non-exporting no-op (the reason otel.ts re-surfaces
// its own provider in the first place); we must be handed the real one.
const state: { tracer: Tracer | undefined } = { tracer: undefined }
export const setNodeSpanTracer = (tracer: Tracer | undefined): void => {
  state.tracer = tracer
}

// The live chat.turn OTel Context, keyed by sessionId. WHY this exists: ax does NOT forward
// the turn's traceContext into a tool func's `extra` (dsp/functions.ts passes only
// {sessionId, traceId, ai, step, abortSignal} — a traceId STRING, not the Context), AND the
// turn drains ax via `for await` on a STREAMING generator, across whose yields
// AsyncLocalStorage drops the active context. So a tool handler (workflow / RLM) that read
// otelContext.active() got the ROOT context and fragmented its node spans into a NEW trace.
// turn() stashes its traceContext here by sessionId; the workflow handler reads it (via the
// extra.sessionId ax DOES pass) and runs the script under it, so node + RLM spans nest under
// the live chat.turn — one trace per session. ponytail: module Map keyed by sessionId —
// turns are serialized per session (busyAtom) so no cross-turn race; set per turn. LEAK FIX
// (D3): keyed by a never-reused sessionId, so it accumulates one dead OtelContext per session
// without an explicit drop — deleteSession (sessions.ts) calls clearTurnContext alongside the
// sessionsRT drop. Upgrade: drop this if ax forwards traceContext into a tool func's extra.
const turnCtx = new Map<string, OtelContext>()
export const setTurnContext = (sessionId: string, ctx: OtelContext): void => {
  turnCtx.set(sessionId, ctx)
}
export const getTurnContext = (sessionId: string | undefined): OtelContext | undefined =>
  sessionId !== undefined ? turnCtx.get(sessionId) : undefined
// LEAK FIX (D3): drop a closed session's stashed trace context. Called from deleteSession so the
// turn-context registry never accumulates dead sessions. Returns whether an entry existed.
export const clearTurnContext = (sessionId: string): boolean => turnCtx.delete(sessionId)

const clip = (v: unknown, max = 256): string => {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } })()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// Start a child span mirroring a node 'start' NodeEvent. Parents under the parent node's
// span (by parentId) when that node is open, else under the ambient active span (the live
// chat.turn / gen_ai span) — so a root node (run_rlm/orchestrate) nests under the turn and
// its internal nodes nest under it. No-op if no tracer is wired yet, or if this nodeId is
// already open (idempotent: a re-fired start never double-mints).
export const startNodeSpan = (nodeId: string, parentId: string | undefined, phase: string): void => {
  const tracer = state.tracer
  if (tracer === undefined || open.has(nodeId)) return
  const parentCtx =
    (parentId !== undefined ? open.get(parentId)?.ctx : undefined) ?? otelContext.active()
  const span = tracer.startSpan(`orch.node ${phase}`, { attributes: { "orch.node.id": nodeId, "orch.node.phase": phase, ...(parentId !== undefined ? { "orch.node.parent_id": parentId } : {}) } }, parentCtx)
  const ctx = otelTrace.setSpan(parentCtx, span)
  open.set(nodeId, { span, ctx })
}

// End a node's child span on 'done'. Stamps the per-node token count + a clipped result.
export const endNodeSpan = (nodeId: string, result: unknown, tokens: number | undefined): void => {
  const entry = open.get(nodeId)
  if (entry === undefined) return
  open.delete(nodeId)
  entry.span.setAttribute("orch.node.result", clip(result))
  if (tokens !== undefined) entry.span.setAttribute("orch.node.tokens", tokens)
  entry.span.end()
}

// End a node's child span on 'error' — records the exception + ERROR status.
export const errorNodeSpan = (nodeId: string, cause: unknown): void => {
  const entry = open.get(nodeId)
  if (entry === undefined) return
  open.delete(nodeId)
  entry.span.setAttribute("orch.node.cause", clip(cause))
  entry.span.recordException(cause instanceof Error ? cause : new Error(clip(cause)))
  entry.span.setStatus({ code: 2 /* SpanStatusCode.ERROR */ })
  entry.span.end()
}
