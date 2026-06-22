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
import { type Activity, setActivitySink } from "./activity.ts"
import { abortTurn, turn, type TurnResult as RawTurnResult } from "./agent.ts"
import { coreRuntime } from "../otel.ts"
import { sessionsRT } from "./sessions.ts"

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
      readonly event: "start" | "delta" | "done" | "error"
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
        event: a.event as "start" | "delta" | "done" | "error",
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
  const e = Cause.squash(cause) as { cause?: { message?: string }; message?: string; _tag?: string }
  const raw = e?.cause?.message ?? e?.message ?? String(e)
  const aborted = /abort/i.test(raw)
  const budget = /budget/i.test(raw) || e?._tag === "BudgetExhaustedError"
  const msg = aborted ? "Interrupted." : raw.split("\n")[0]!.slice(0, 240)
  const kind: TurnError["kind"] = aborted ? "aborted" : budget ? "budget_exhausted" : "provider"
  return {
    reply: `⚠ ${msg}`,
    stopReason: aborted ? "aborted" : "error",
    usage: {},
    aborted,
    error: { kind, message: msg },
  }
}

/**
 * Drive ONE turn of a session as a serializable event stream. Effect runs INSIDE on
 * coreRuntime; the outside is a for-await-of. The final yield is ALWAYS a single
 * {type:'reply'} — on success, error, or abort. Never two replies, never zero.
 */
export async function* runTurn(sessionId: string, message: string, opts?: TurnOptions): AsyncGenerator<TurnEvent, void, void> {
  const text = message.trim()
  const rt = sessionsRT.get(sessionId)
  // No session / empty message: still honor final-reply-once with a single terminal reply.
  if (text.length === 0 || rt === undefined) {
    const why = rt === undefined ? "unknown session" : "empty message"
    yield { type: "reply", result: { reply: `⚠ ${why}`, stopReason: "error", usage: {}, aborted: false, error: { kind: "unknown", message: why } } }
    return
  }

  // PER-TURN emit: push every Activity (mapped to a flat TurnEvent) into THIS turn's queue.
  // Step 3 BRIDGE: the three producers (orch.emit / ax logger / streaming deltas) still route
  // through the module-global emitActivity, so we install this turn's push AS the global sink
  // for the turn's duration. Step 5 deletes the global sink and threads `emit` natively, after
  // which setActivitySink is gone. ponytail: global-sink bridge for the alongside runTurn.
  // Upgrade: thread `emit` into makeLiveLogger/orch.emit per turn (step 5 of the core/tui split).
  const queue = new TurnQueue<TurnEvent>()
  const emit = (a: Activity): void => queue.push(toEvent(a))
  setActivitySink(emit)

  // Abort: a caller signal aborts THIS session's in-flight turn (wraps agent.ts abortTurn).
  const onAbort = (): void => void abortTurn(sessionId)
  if (opts?.signal !== undefined) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener("abort", onAbort, { once: true })
  }

  // Run turn()'s Effect on the headless runtime as a detached promise; map success/failure into
  // the SINGLE terminal reply. Effect/Cause/ChatError never escape this closure.
  // turn()'s Effect requires OtelTracerProvider — coreRuntime (TracingLive) supplies it, so the
  // program type keeps that requirement and runPromise discharges it. Let it infer (annotating
  // R=never would wrongly assert the requirement is gone before runPromise provides it).
  const program = turn(rt.mem, rt.parent, sessionId)(text).pipe(
    Effect.map(okResult),
    Effect.catchCause((c) => Effect.succeed(errorResult(c))),
  )
  const replyPromise: Promise<TurnResult> = coreRuntime
    .runPromise(program)
    .catch((e: unknown) => errorResult(Cause.fail(e)))
    .finally(() => {
      setActivitySink(null)
      if (opts?.signal !== undefined) opts.signal.removeEventListener("abort", onAbort)
      queue.close()
    })

  // DRAIN: yield every queued activity event as it arrives. The queue closes when the turn
  // settles (the .finally above), ending the drain — so the loop never hangs.
  for await (const ev of queue.drain()) yield ev

  // TERMINAL: the one and only reply, always, even on error/abort.
  yield { type: "reply", result: await replyPromise }
}
