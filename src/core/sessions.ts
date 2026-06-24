// PER-SESSION RUNTIME STATE — ONE scoped, keyed, auto-releasing store (adoption #9 + #10 + #14).
//
// WHAT THIS REPLACES (the leak class, rows 8-14 of effect-adoption.md): there used to be FOUR
// module Maps keyed by a never-reused sessionId, each SET per turn/session and dropped ONLY by a
// manual deleteSession — so a long-lived process accumulated one dead entry per closed session
// forever: sessionsRT here, turnEmits (runtime.ts), turnCtx (orch-spans.ts), and turnAborters
// (closed over per agent in agent.ts, fanned out via an aborterClearers Set — the workaround that
// proved the smell). All FOUR collapse into the SINGLE `SessionState` cell below, and that cell's
// lifetime is owned by a `LayerMap.Service` (SessionServices) with `idleTimeToLive`: a session
// auto-releases after it sits idle (no turn touching it), its finalizer runs on Exit (even on an
// ungraceful exit, per Effect's Exit semantics), and the finalizer drops the cell from the one
// synchronous index `sessionsRT`. No manual cleanup is REQUIRED anymore — deleteSession stays a
// working public method (it forces an immediate release via invalidate), but the leak is gone
// whether or not a caller ever calls it (the headless SDK path never did).
//
// WHY a synchronous index alongside the LayerMap: ax does NOT run a tool func inside the turn's
// Effect fiber — it calls the handler from its own async context during forward(), and forwards
// only a FIXED `extra` ({sessionId, ai, abortSignal, …}). So a workflow/mock tool handler that
// needs THIS turn's `emit` / OTel context must recover them SYNCHRONOUSLY by sessionId — a
// Context.Reference/FiberRef is invisible there. The cell holds those per-turn fields; the
// LayerMap owns its lifetime. `sessionsRT` (the index) is the SINGLE store the sync paths read,
// and it is auto-managed by the layer's acquire (create) + finalizer (drop) — not leaked.
import { AxMemory } from "@ax-llm/ax"
import type { Context as OtelContext } from "@opentelemetry/api"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as LayerMap from "effect/LayerMap"
import * as Scope from "effect/Scope"
import * as Tracer from "effect/Tracer"
import type { AnySpan } from "effect/Tracer"
import type { Activity } from "./activity.ts"

// The activity sink shape (structurally identical to orch.ts's ActivitySink — (a: Activity) => void).
// Defined over activity.ts's Activity, NOT imported from orch.ts, so sessions.ts depends only on the
// leaf activity module — no import cycle through orch.ts → orch-spans.ts → back here.
type ActivitySink = (a: Activity) => void

// SESSION IDLE TTL in ms — how long a session's scoped cell survives with NO live turn before it
// auto-releases (its finalizer drops the index entry — the leak fix). Read at boot via Config (the
// same env-at-boot idiom as runtime.ts), clamped > 0 so a bad env never disables the auto-release
// (a 0/NaN TTL would release a session between back-to-back turns). Read HERE (not imported from
// runtime.ts) so sessions.ts does not depend on runtime.ts → no import cycle through orch-spans.
const idleTtlMillis = (() => {
  const v = Effect.runSync(Config.number("RLM_SESSION_IDLE_MS").pipe(Config.withDefault(600_000)))
  return Number.isFinite(v) && v > 0 ? v : 600_000
})()

// The ONE per-session cell — the four old Maps' values unified. `mem` + `parent` are the durable
// session identity (every turn parents to `parent`, so a session's turns share one traceId);
// `emit` / `ctx` / `aborter` are the PER-TURN fields (overwritten each turn, serialized by the
// run.ts per-session turn mutex so they're never live for two turns at once). Mutable by design:
// the layer hands out the SAME cell across a session's turns (memoized within the idle window).
export type SessionState = {
  readonly mem: AxMemory
  parent: AnySpan
  // PER-TURN: the active turn's activity sink (ax's logger + orch onEvent + streaming deltas push
  // here). A no-op default so a stray tool call with no live turn is a no-op, not a crash.
  emit: ActivitySink
  // PER-TURN: the live chat.turn OTel Context (ax drops traceContext from a tool func's extra, and
  // AsyncLocalStorage loses it across the streaming for-await), so a tool handler reads it here to
  // nest its node spans under the turn. This cell is the single source of truth for that context.
  ctx: OtelContext | undefined
  // PER-TURN: this turn's in-flight AbortController (abortTurn signals it). Auto-finalized on turn
  // exit (the turn's Effect.scoped finalizer clears it), so a settled turn holds no live controller.
  aborter: AbortController | undefined
}

// THE SINGLE STORE — a synchronous index of the live session cells. Populated by the
// SessionServices layer's acquire and DROPPED by its release finalizer (idle TTL or invalidate),
// so it never accumulates dead sessions. The TUI's existence guard + the sync tool-handler reads
// hit this. Re-exported through src/app for the TUI (it never deep-imports core).
export const sessionsRT = new Map<string, SessionState>()

const detachedParent = (): AnySpan =>
  Tracer.externalSpan({ traceId: "0".repeat(32), spanId: "0".repeat(16), sampled: false })

const freshState = (): SessionState => ({
  mem: new AxMemory(),
  parent: detachedParent(),
  emit: () => {},
  ctx: undefined,
  aborter: undefined,
})

// The keyed service the SessionServices LayerMap builds per session: the SessionState cell. Reading
// it in-Effect (the turn) is equivalent to the sync index lookup; the index mirror exists for the
// out-of-fiber tool-handler path. Giving the lookup layer a concrete success type (vs `never`)
// keeps the LayerMap.Service generics happy under exactOptionalPropertyTypes.
class SessionCell extends Context.Service<SessionCell, SessionState>()("rlmcode/SessionCell") {}

// SessionServices — the keyed scoped service that OWNS each session cell's lifetime. lookup(id)
// builds a layer whose ACQUIRE inserts (or reuses) the cell in `sessionsRT` and whose RELEASE
// finalizer DROPS it. RcMap memoizes by key within the idle window: a session's turns re-acquire
// the SAME cell (so AxMemory persists across turns); once no turn holds it for `idleTtlMillis`,
// the entry releases and the finalizer runs — the auto-cleanup that kills the leak (proven by the
// Layer.memoization + auto-release test). idleTimeToLive is the env-tunable idleTtlMillis above.
class SessionServices extends LayerMap.Service<SessionServices>()("rlmcode/SessionServices", {
  lookup: (id: string) =>
    Layer.effect(SessionCell)(
      Effect.acquireRelease(
        // ACQUIRE: ensure a cell exists for this id in the single index (idempotent — a seeded cell
        // from ensureSession/seedSession is reused so a TUI-set richer parent span is kept).
        Effect.sync(() => {
          const existing = sessionsRT.get(id)
          if (existing !== undefined) return existing
          const rt = freshState()
          sessionsRT.set(id, rt)
          return rt
        }),
        // RELEASE (idle TTL / invalidate): drop the cell — the leak fix, run on Exit.
        () => Effect.sync(() => void sessionsRT.delete(id)),
      ),
    ),
  idleTimeToLive: idleTtlMillis,
}) {}

export { SessionServices }

// The session layer + a kept-alive scope to drive the LayerMap's synchronous helpers from the
// non-Effect boundary (run.ts ensureSession, the TUI). Built ONCE at module load on its own scope;
// the scope lives for the process (the session store is process-global, like the old Maps were).
// We read the LayerMap instance out of the built context so the sync helpers below can run short
// contextEffect/invalidate Effects against it (each turn's acquire drives the refcount lifetime).
const sessionScope = Scope.makeUnsafe()
const sessionLayerMap: LayerMap.LayerMap<string, SessionCell> = Effect.runSync(
  Layer.build(SessionServices.layer).pipe(
    Effect.provideService(Scope.Scope, sessionScope),
    Effect.map((ctx) => Context.get(ctx, SessionServices)),
  ),
)

// LAZY session open. The TUI pre-seeds a richer chat.session root span (seedSession); a headless
// SDK consumer just calls runTurn(id, …), so ensure the cell exists on first use with a detached
// external span (fine for an embedded consumer that doesn't run motel — a turn still parents to it,
// so a session's turns share one traceId). Idempotent: returns the existing cell.
export const ensureSession = (id: string): SessionState => {
  const existing = sessionsRT.get(id)
  if (existing !== undefined) return existing
  const rt = freshState()
  sessionsRT.set(id, rt)
  return rt
}

// SEED a richer parent span for a session (the TUI's newSessionAtom builds a real chat.session root
// span). Creates the cell if absent, else updates its parent — kept across the session's turns.
export const seedSession = (id: string, parent: AnySpan): SessionState => {
  const rt = ensureSession(id)
  rt.parent = parent
  return rt
}

// Acquire THIS session's cell as a turn-scoped resource (refcount++ for the turn's Scope, --on
// close → idle timer → auto-release). Threading a Scope through turn() is what makes the turn the
// unit of liveness: a settled turn releases its hold, and an idle session auto-cleans (#14).
export const acquireSession = (id: string): Effect.Effect<SessionState, never, Scope.Scope> =>
  Effect.as(
    sessionLayerMap.contextEffect(id),
    // The cell is the source of truth in the index (the layer's acquire put it there); read it back.
    ensureSession(id),
  )

// ── PER-TURN accessors (formerly turnEmits in runtime.ts + turnCtx in orch-spans.ts) ─────────────
// turn() stashes THIS turn's emit + OTel context on the cell; a workflow/mock tool handler recovers
// them by sessionId (ax forwards only a fixed extra to a tool func, so neither reaches the handler
// via opts; and the streaming for-await drops AsyncLocalStorage's active context). Serialized turns
// (the run.ts per-session mutex) mean the cell is never live for two turns at once. No separate Map
// to leak: the cell IS the store, owned by SessionServices.

export const setTurnEmit = (sessionId: string, sink: ActivitySink): void => {
  ensureSession(sessionId).emit = sink
}
export const getTurnEmit = (sessionId: string | undefined): ActivitySink =>
  (sessionId !== undefined ? sessionsRT.get(sessionId)?.emit : undefined) ?? (() => {})

export const setTurnContext = (sessionId: string, ctx: OtelContext): void => {
  ensureSession(sessionId).ctx = ctx
}
export const getTurnContext = (sessionId: string | undefined): OtelContext | undefined =>
  sessionId !== undefined ? sessionsRT.get(sessionId)?.ctx : undefined

// NB: the live chat.turn OTel context is recovered ONLY through the cell (getTurnContext above), by
// sessionId. A v4 Context.Reference (fiber-local) was tried as an in-fiber mirror but had no reader:
// the sole in-turn consumer of the context is the workflow/RLM tool handler, and ax calls handlers
// OUTSIDE the turn fiber where a fiber-local is invisible — so the cell is the single source of
// truth and the Reference was dead. forward() runs under otelContext.with(traceContext) directly.

// PER-TURN AbortController (formerly the turnAborters Map closed over per agent + the aborterClearers
// Set workaround). One cell per session, set on turn start, CLEARED on turn exit (the turn's
// Effect.scoped finalizer calls clearTurnAborter — #14: the aborter auto-finalizes on turn exit).
export const setTurnAborter = (sessionId: string, aborter: AbortController): void => {
  ensureSession(sessionId).aborter = aborter
}
// abortTurn: signal this session's in-flight turn. Returns false if there is no live (un-aborted)
// controller — i.e. no turn running, or it already settled/aborted. (Was per-agent; now one cell.)
export const abortSession = (sessionId: string): boolean => {
  const c = sessionsRT.get(sessionId)?.aborter
  if (c === undefined || c.signal.aborted) return false
  c.abort()
  return true
}
// Drop a settled turn's controller (the turn-exit finalizer). Returns whether one was held.
export const clearTurnAborter = (sessionId: string): boolean => {
  const rt = sessionsRT.get(sessionId)
  if (rt === undefined || rt.aborter === undefined) return false
  rt.aborter = undefined
  return true
}

// LEAK FIX (D3) / public closeSession: force an immediate release of a session's cell (vs waiting
// for the idle TTL) — invalidate drops the RcMap entry, running the finalizer (which deletes the
// index cell). Stays a WORKING public method (sdk.ts closeSession) so headless callers are
// unaffected and the SDK surface is UNCHANGED. Returns whether the index held the session.
export const deleteSession = (id: string): boolean => {
  const existed = sessionsRT.has(id)
  Effect.runSync(sessionLayerMap.invalidate(id))
  // invalidate releases only when refcount is 0; a still-open turn keeps it. Drop the index cell
  // explicitly so a close-during-turn frees the durable state immediately (the turn's own scope
  // release is then a no-op delete). Mirrors the old deleteSession dropping all four Maps at once.
  sessionsRT.delete(id)
  return existed
}
