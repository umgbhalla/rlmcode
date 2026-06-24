// THE TURN BOUNDARY — a PLAIN AsyncGenerator over a session turn. Effect stays INSIDE
// (turn() runs on coreRuntime, the headless TracingLive runtime); the OUTSIDE contract is
// for-await-of over a fully serializable event stream. This is the seam a future remote
// client bolts a thin transport onto (TurnEvent -> NDJSON, inbound prompt -> runTurn) with
// NO protocol code here: only TurnEvent crosses the boundary, the only input is (sessionId,
// message). claude_code QueryEngine model — single process, ONE in-flight turn per session
// (the UI's busyAtom guards it), no submission-id / next_event ceremony.
//
// HARD INVARIANT (final-reply-once): the final reply prose is carried ONLY by the {type:'reply'}
// arm, yielded EXACTLY ONCE at the END, and ALWAYS yielded — success, error, or abort. A turn()
// failure maps to a reply whose text is a warning ('⚠ ...') via the catchCause below (that mapping
// MOVED here out of atoms.ts). The activity.ts (calls.length>0 && content) gate keeps liveLogger
// from ever leaking the final reply as a 'message' event, so the reply arm is the SOLE carrier.
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type { Activity } from "./activity.ts"
import type { AxAgentSDK, TurnResult as RawTurnResult } from "./agent.ts"
import { coreRuntime } from "../otel.ts"
import { ensureSession } from "./sessions.ts"

// A turn DRIVER — the two agent capabilities runTurn needs, decoupled from any one construction
// site. src/core/sdk.ts builds a fresh agent per createAgent() and supplies its own driver (its
// internal createAgent output IS this shape); src/app/default-agent.ts wires the app default the
// same way. `turn` returns the INTERNAL Effect (Effect/ChatError never escape — runTurn drives it
// on coreRuntime); `abortTurn` wraps the agent's per-session abort. NB: this module no longer
// constructs a default driver / a default runTurn — that env-coupled wiring moved to the app
// (hide #6); core exports only the makeRunTurn FACTORY.
export type TurnDriver = Pick<AxAgentSDK, "turn" | "abortTurn">

// ── PUBLIC, FULLY SERIALIZABLE event vocabulary ─────────────────────────────────────────
// Every field is string|number|boolean|undefined — NO AxMemory / AxSpan / Effect / Cause. The
// internal Activity union (activity.ts) STAYS internal; each variant is PROMOTED to a top-level
// discriminant here at the yield boundary (no {kind:'activity'} wrapper). A future socket can
// JSON.stringify a TurnEvent verbatim.
export type TurnEvent =
  | { readonly type: "reply_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly args: string; readonly nodeId?: string | undefined }
  | { readonly type: "tool_result"; readonly id: string; readonly result: string; readonly isError: boolean; readonly nodeId?: string | undefined }
  | {
      readonly type: "node"
      readonly nodeId: string
      // RATE-LIMIT VISIBILITY: "retry" joins the node lifecycle — a transient (429/5xx) backoff in
      // progress, carried as a flat event (the formatted status rides `detail`) so the UI reducer
      // sets a live retry status on the node. Fully serializable like every other arm.
      readonly event: "start" | "delta" | "retry" | "done" | "error"
      readonly parentId?: string | undefined
      readonly detail?: string | undefined
      readonly tokens?: number | undefined
    }
  // TERMINAL: yielded EXACTLY ONCE, ALWAYS last.
  | { readonly type: "reply"; readonly result: TurnResult }

// ── NORMALIZED turn result (NO provider-wire leakage) ───────────────────────────────────
export type StopReason = "stop" | "max_steps" | "aborted" | "error"
export interface TokenUsage {
  readonly total?: number | undefined
  readonly reasoning?: number | undefined
  readonly input?: number | undefined
  readonly output?: number | undefined
}
export interface TurnError {
  readonly kind: "aborted" | "budget_exhausted" | "provider" | "unknown"
  readonly message: string // one clean line, never a Cause dump
}
export interface TurnResult {
  readonly reply: string
  readonly stopReason: StopReason
  readonly usage: TokenUsage
  readonly aborted: boolean
  readonly error?: TurnError | undefined
}

// Per-turn options. signal cancels the in-flight turn (wraps abortTurn). model/maxSteps/thinking
// are accepted now and honored once the agent factory threads per-turn overrides (seal phase);
// they are part of the stable public surface so a consumer can pass them today.
export interface TurnOptions {
  readonly signal?: AbortSignal | undefined
  readonly model?: string | undefined
  readonly maxSteps?: number | undefined
  readonly thinking?: "minimal" | "low" | "medium" | "high" | "highest" | "none" | undefined
}

// ── internal per-turn queue ─────────────────────────────────────────────────────────────
// A minimal unbounded push/pull async queue: emit() pushes, the generator pulls. close()
// signals end-of-stream so the drain loop terminates. No external dep. Scoped to ONE turn,
// so two turns never share a buffer (the module-global sink it replaces could not say that).
class TurnQueue<T> {
  private readonly buffer: Array<T> = []
  private resolve: ((v: void) => void) | null = null
  private closed = false
  push(value: T): void {
    if (this.closed) return
    this.buffer.push(value)
    this.wake()
  }
  close(): void {
    this.closed = true
    this.wake()
  }
  private wake(): void {
    const r = this.resolve
    if (r !== null) {
      this.resolve = null
      r()
    }
  }
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.buffer.length > 0) yield this.buffer.shift()!
      if (this.closed) return
      await new Promise<void>((res) => {
        this.resolve = res
      })
    }
  }
}

// PROMOTE one internal Activity to a flat, serializable TurnEvent. text->message,
// tool->tool_call, result->tool_result, node->node, replyDelta->reply_delta,
// thinkingDelta->thinking_delta. (No Activity carries the FINAL reply — the gate prevents it —
// so this never produces a stray reply.)
const toEvent = (a: Activity): TurnEvent => {
  switch (a.kind) {
    case "text":
      return { type: "message", text: a.text }
    case "replyDelta":
      return { type: "reply_delta", text: a.text }
    case "thinkingDelta":
      return { type: "thinking_delta", text: a.text }
    case "tool":
      return { type: "tool_call", id: a.id, name: a.name, args: a.args, nodeId: a.nodeId }
    case "result":
      return { type: "tool_result", id: a.id, result: a.result, isError: a.isError, nodeId: a.nodeId }
    case "node":
      return {
        type: "node",
        nodeId: a.nodeId,
        event: a.event as "start" | "delta" | "retry" | "done" | "error",
        parentId: a.parentId,
        detail: a.detail,
        tokens: a.tokens,
      }
  }
}

// Normalize the raw agent TurnResult (which still carries provider-shaped fields) into the
// sealed public TurnResult. budget-exhaustion -> max_steps stop with no error (it finalized in
// loop with real output); a clean success -> 'stop'. The error/abort paths are built by the
// catchCause arm below, never here.
const okResult = (raw: RawTurnResult): TurnResult => ({
  reply: raw.reply,
  stopReason: raw.budget ? "max_steps" : "stop",
  usage: { total: raw.tokens, reasoning: raw.reasoningTokens },
  aborted: false,
})

// The internal-error shape the serializer reads. The turn boundary (agent.ts) ALWAYS fails with a
// tagged `ChatError` whose `.cause` is the ORIGINAL thrown value — one of OUR typed Data.TaggedErrors
// (BudgetExhaustedError, NodeTimeoutError, _tag-discriminated) or an UNTYPED ax wire error (a status
// error / abort error — ax owns those classes, we can't catchTag them, so they stay duck-typed by
// shape). `cause.cause` is the inner cause ax sometimes nests a status under.
type RawError = { _tag?: string; message?: string; status?: unknown; cause?: { message?: string; status?: unknown } }

// ── TYPED-ERROR SERIALIZER (adoption #6/#8) — the ONE map-to-serializable point at the SDK seam.
// run.ts is the sole place internal Effect/Cause/Data error types collapse into the SERIALIZABLE
// public TurnError (no Effect/Data crosses sdk.ts). `chatErrorCause` is `ChatError.cause` (the
// original thrown value), recovered by Effect.catchTag below — NOT a Cause.squash duck-type chase.
// Our own errors are classified by their `_tag` (BudgetExhaustedError → budget_exhausted); ax's
// untyped wire errors keep the status/abort shape-match (429 → a clear rate-limit line; abort →
// "Interrupted."). The output TurnError is byte-for-byte the prior contract.
const serializeError = (chatErrorCause: unknown): TurnResult => {
  const e = (chatErrorCause ?? {}) as RawError
  const raw = e.cause?.message ?? e.message ?? String(chatErrorCause)
  // TAGGED (our Data.TaggedError) first — exact, no string-match. Then the duck-typed fall-throughs
  // for ax's own untyped errors (abort / status), which we cannot tag.
  const budget = e._tag === "BudgetExhaustedError" || /budget/i.test(raw)
  const aborted = !budget && /abort/i.test(raw)
  // RATE-LIMIT VISIBILITY (main-turn 429): unlike a node, the main turn does NOT retry — a 429
  // mid-stream fails the turn. ax surfaces it as a status error (429 on the error or its inner
  // cause) and/or a "429"/"rate limit"/"too many requests" message. Detect it and word the
  // ErrorCard CLEARLY ("Rate limited (429) …") instead of dumping ax's raw status-error line, so
  // the user knows it's throttling — not an opaque provider fault. kind:"provider" (it IS one).
  const rateLimited =
    !aborted && !budget && (isStatus429(e.status) || isStatus429(e.cause?.status) || /\b429\b|rate.?limit|too many requests/i.test(raw))
  const msg = aborted
    ? "Interrupted."
    : rateLimited
      ? "Rate limited (429) — too many requests. Try again shortly."
      : raw.split("\n")[0]!.slice(0, 240)
  const kind: TurnError["kind"] = aborted ? "aborted" : budget ? "budget_exhausted" : "provider"
  return {
    reply: `⚠ ${msg}`,
    stopReason: aborted ? "aborted" : "error",
    usage: {},
    aborted,
    error: { kind, message: msg },
  }
}

// A non-ChatError failure (a defect/interrupt that escaped the typed channel — should not happen,
// but final-reply-once is an INVARIANT). Squash the Cause to a value and serialize it the same way,
// so the terminal {type:'reply'} is ALWAYS produced even on an unexpected defect.
const defectResult = (cause: Cause.Cause<unknown>): TurnResult => {
  const squashed = Cause.squash(cause)
  return serializeError(squashed)
}

// True when a squashed-error `status` field is HTTP 429 (the duck-typed ax status shape, same
// discriminator orch-resilience.classifyTransient uses). Tolerates a string "429" too.
const isStatus429 = (status: unknown): boolean => status === 429 || status === "429"

// A reply EVENT helper for the no-session / empty-message early exit (final-reply-once still holds).
const earlyReply = (why: string): TurnEvent => ({
  type: "reply",
  result: { reply: `⚠ ${why}`, stopReason: "error", usage: {}, aborted: false, error: { kind: "unknown", message: why } },
})

// PER-SESSION TURN MUTEX. The seam DOCUMENTS "one in-flight turn per session" (sdk.ts) but only
// the TUI's busyAtom ever ENFORCED it — an SDK/remote consumer firing two runTurn(sameSession)
// calls would race the shared chat gen (agent.ts), the sessionId-keyed Maps (agent.ts/runtime.ts),
// and the shared AxMemory (sessions.ts). This tail-chains turns per sessionId: a second turn awaits
// the first's release before it opens its queue, making the documented invariant an ENFORCED one.
// One Map entry per live session (overwritten, not per-turn) — reclaimed when the chain drains.
const turnLocks = new Map<string, Promise<void>>()
const acquireTurn = async (sessionId: string): Promise<() => void> => {
  let release!: () => void
  const mine = new Promise<void>((r) => (release = r))
  const prior = turnLocks.get(sessionId) ?? Promise.resolve()
  const tail = prior.then(() => mine)
  turnLocks.set(sessionId, tail)
  await prior // wait for the prior turn on THIS session to release
  return () => {
    release()
    // Best-effort reclaim: if no later turn replaced the tail, drop the entry (no per-session leak).
    if (turnLocks.get(sessionId) === tail) turnLocks.delete(sessionId)
  }
}

// makeRunTurn — bind the turn boundary to a specific agent DRIVER. Returns the plain
// AsyncGenerator runTurn. Effect runs INSIDE on coreRuntime; the outside is a for-await-of. The
// final yield is ALWAYS a single {type:'reply'} — success, error, or abort. Never two, never zero.
export const makeRunTurn =
  (driver: TurnDriver) =>
  async function* runTurn(sessionId: string, message: string, opts?: TurnOptions): AsyncGenerator<TurnEvent, void, void> {
    const text = message.trim()
    // Empty message: still honor final-reply-once with a single terminal reply. No session/lock work.
    if (text.length === 0) {
      yield earlyReply("empty message")
      return
    }
    // Serialize turns for THIS session (enforce the documented one-turn-per-session invariant)
    // before touching any shared per-session state. Released in the finally below — even on an
    // early for-await break (the generator's return() runs it).
    const release = await acquireTurn(sessionId)
    try {
      yield* drive(driver, sessionId, text, opts)
    } finally {
      release()
    }
  }

// The actual turn drive, bracketed by the per-session mutex above. ALWAYS ends in exactly one
// {type:'reply'}. On consumer abandonment (early for-await break) the generator's return() unwinds
// HERE: we abort the detached turn and await its settle BEFORE the mutex releases, so the NEXT
// same-session turn can never start while a still-running one mutates the shared gen/memory.
async function* drive(
  driver: TurnDriver,
  sessionId: string,
  text: string,
  opts?: TurnOptions,
): AsyncGenerator<TurnEvent, void, void> {
  // Lazily open the session on first use (the SDK path); the TUI pre-creates it, so this is a
  // no-op there (ensureSession returns the existing richer-span entry).
  const rt = ensureSession(sessionId)

  // PER-TURN emit: THE per-turn closure that replaces the deleted module-global sink. Every
  // Activity (mapped to a flat TurnEvent) pushes into THIS turn's queue. It is threaded NATIVELY
  // into turn() — which wires it into all three producers: ax's logger (makeLiveLogger(emit) in
  // the forward opts), the orch NodeEvent path (makeOnEvent(emit) + getTurnEmit for tool
  // handlers), and the streaming reply/thinking deltas. No module-global sink whatsoever.
  const queue = new TurnQueue<TurnEvent>()
  const emit = (a: Activity): void => queue.push(toEvent(a))

  // Abort: a caller signal aborts THIS session's in-flight turn (wraps the driver's abortTurn).
  const onAbort = (): void => void driver.abortTurn(sessionId)
  if (opts?.signal !== undefined) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener("abort", onAbort, { once: true })
  }

  // Run turn()'s Effect on the headless runtime as a detached promise; map success/failure into
  // the SINGLE terminal reply. Effect/Cause/ChatError never escape this closure. turn()'s Effect
  // requires OtelTracerProvider — coreRuntime (TracingLive) supplies it, so the program type
  // keeps that requirement and runPromise discharges it (don't annotate R=never).
  let settled = false
  const program = driver.turn(rt.mem, rt.parent, sessionId, emit)(text).pipe(
    Effect.map(okResult),
    // TYPED RECOVERY (adoption #6): the turn's E channel is the tagged `ChatError` — recover it by
    // TAG (not Cause.squash) and serialize `e.cause` into the public TurnResult. The trailing
    // catchCause is the final-reply-once backstop for any defect/interrupt that escaped the typed
    // channel (shouldn't happen, but the terminal reply is an INVARIANT).
    Effect.catchTag("ChatError", (e) => Effect.succeed(serializeError(e.cause))),
    Effect.catchCause((c) => Effect.succeed(c.pipe(Cause.squash, serializeError))),
  )
  const replyPromise: Promise<TurnResult> = coreRuntime
    .runPromise(program)
    .catch((e: unknown) => defectResult(Cause.fail(e)))
    .finally(() => {
      settled = true
      if (opts?.signal !== undefined) opts.signal.removeEventListener("abort", onAbort)
      queue.close()
    })

  try {
    // DRAIN: yield every queued activity event as it arrives. The queue closes when the turn
    // settles (the .finally above), ending the drain — so the loop never hangs.
    for await (const ev of queue.drain()) yield ev

    // TERMINAL: the one and only reply, always, even on error/abort.
    yield { type: "reply", result: await replyPromise }
  } finally {
    // CONSUMER ABANDONMENT (early break): the turn is still detached + running. Abort it and wait
    // for it to settle so the released mutex doesn't hand the shared gen/memory to a racing turn.
    if (!settled) {
      onAbort()
      await replyPromise.catch(() => {})
    }
  }
}
