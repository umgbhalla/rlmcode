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
  private readonly buffer: T[] = []
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

// Build the final reply EVENT for a failed/aborted turn. The '⚠ ...' text mapping moved here
// from atoms.ts: an abort reads as 'Interrupted.', anything else as the first clean error line.
const errorResult = (cause: Cause.Cause<unknown>): TurnResult => {
  const e = Cause.squash(cause) as { cause?: { message?: string; status?: unknown }; message?: string; _tag?: string; status?: unknown }
  const raw = e?.cause?.message ?? e?.message ?? String(e)
  const aborted = /abort/i.test(raw)
  const budget = /budget/i.test(raw) || e?._tag === "BudgetExhaustedError"
  // RATE-LIMIT VISIBILITY (main-turn 429): unlike a node, the main turn does NOT retry — a 429
  // mid-stream fails the turn. ax surfaces it as a status error (429 on the error or its inner
  // cause) and/or a "429"/"rate limit"/"too many requests" message. Detect it and word the
  // ErrorCard CLEARLY ("Rate limited (429) …") instead of dumping ax's raw status-error line, so
  // the user knows it's throttling — not an opaque provider fault. kind:"provider" (it IS one).
  const rateLimited =
    !aborted && !budget && (isStatus429(e?.status) || isStatus429(e?.cause?.status) || /\b429\b|rate.?limit|too many requests/i.test(raw))
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

// True when a squashed-error `status` field is HTTP 429 (the duck-typed ax status shape, same
// discriminator orch-resilience.classifyTransient uses). Tolerates a string "429" too.
const isStatus429 = (status: unknown): boolean => status === 429 || status === "429"

// A reply EVENT helper for the no-session / empty-message early exit (final-reply-once still holds).
const earlyReply = (why: string): TurnEvent => ({
  type: "reply",
  result: { reply: `⚠ ${why}`, stopReason: "error", usage: {}, aborted: false, error: { kind: "unknown", message: why } },
})

// makeRunTurn — bind the turn boundary to a specific agent DRIVER. Returns the plain
// AsyncGenerator runTurn. Effect runs INSIDE on coreRuntime; the outside is a for-await-of. The
// final yield is ALWAYS a single {type:'reply'} — success, error, or abort. Never two, never zero.
export const makeRunTurn =
  (driver: TurnDriver) =>
  async function* runTurn(sessionId: string, message: string, opts?: TurnOptions): AsyncGenerator<TurnEvent, void, void> {
    const text = message.trim()
    // Empty message: still honor final-reply-once with a single terminal reply.
    if (text.length === 0) {
      yield earlyReply("empty message")
      return
    }
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
    const program = driver.turn(rt.mem, rt.parent, sessionId, emit)(text).pipe(
      Effect.map(okResult),
      Effect.catchCause((c) => Effect.succeed(errorResult(c))),
    )
    const replyPromise: Promise<TurnResult> = coreRuntime
      .runPromise(program)
      .catch((e: unknown) => errorResult(Cause.fail(e)))
      .finally(() => {
        if (opts?.signal !== undefined) opts.signal.removeEventListener("abort", onAbort)
        queue.close()
      })

    // DRAIN: yield every queued activity event as it arrives. The queue closes when the turn
    // settles (the .finally above), ending the drain — so the loop never hangs.
    for await (const ev of queue.drain()) yield ev

    // TERMINAL: the one and only reply, always, even on error/abort.
    yield { type: "reply", result: await replyPromise }
  }
