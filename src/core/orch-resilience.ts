// TRANSIENT RESILIENCE for the node path — USERLAND, not core (orch.ts stays exactly 5
// prims). withRetry + a per-node timeout, composed over the `node` prim. Split out of
// orch-recipes.ts to keep each file under the design-check line budget; runNode()
// (orch-recipes.ts) wires resilientNode in on the node path.
//
// A node forward() can fail for two REASONS that must be handled OPPOSITELY:
//   TRANSIENT — a hiccup that a retry can clear: rate-limit (HTTP 429), a 5xx from CF,
//     a network drop, or a request timeout. ax surfaces these as AxAIServiceStatusError
//     (.status), AxAIServiceNetworkError, AxAIServiceTimeoutError. We RETRY these with
//     exponential backoff (so we don't hammer a struggling service) + a per-attempt
//     stagger by INDEX (no Math.random — backoff varies by attempt i, deterministic and
//     test-stable), capped at ~3 attempts.
//   LOGIC — a real, deterministic failure a retry would only repeat: a tool/argument
//     error (AxFunctionError) or a budget breach (BudgetExhaustedError). These are NEVER
//     retried — re-running yields the same error and burns tokens/time.
// Default = NOT transient (fail fast). Only the known-transient shapes opt INTO a retry.
import { AxFunctionError, type AxAIService, type AxGen, type AxGenIn, type AxGenOut } from "@ax-llm/ax"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { BudgetExhaustedError, type NodeOpts, node, type RetryCause } from "./orch.ts"

// Max forward attempts for a transient failure (the first try + retries). Env override
// RLM_NODE_RETRIES (a RETRY count; attempts = retries + 1). Clamped 1..5, default 3 attempts.
// EXPORTED so the node path (runNode) can label a retry "N/M" with the real attempt ceiling.
export const NODE_ATTEMPTS = (() => {
  const v = Number(process.env.RLM_NODE_RETRIES ?? 2) + 1
  return Number.isFinite(v) ? Math.min(5, Math.max(1, Math.floor(v))) : 3
})()

// Base backoff (ms) for the FIRST retry; doubles each subsequent retry. RLM_NODE_BACKOFF_MS
// overrides. Clamped >= 0 so a bad env can't go negative.
const NODE_BACKOFF_MS = (() => {
  const v = Number(process.env.RLM_NODE_BACKOFF_MS ?? 250)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 250
})()

// Per-node TIMEOUT (ms): a node that runs longer than this is ABORTED and counts as a
// failure (fanOut maps it to null), so one hung node never stalls the whole fan-out.
// RLM_LEAF_TIMEOUT_MS overrides (legacy "leaf" env name kept for stability). Clamped to
// a sane floor; default 120s (a real exploration node can run minutes — but a HANG is
// unbounded, and this is the backstop, not the common case).
export const LEAF_TIMEOUT_MS = (() => {
  const v = Number(process.env.RLM_LEAF_TIMEOUT_MS ?? 120_000)
  return Number.isFinite(v) && v > 0 ? Math.max(1_000, Math.floor(v)) : 120_000
})()

// Thrown when a node exceeds LEAF_TIMEOUT_MS — distinct from a budget/logic error so a
// boundary catch can tell "hung node" apart from "ran out of budget". A node timeout is
// a FAILURE (the slot → null in fanOut), never a retry target (the node was making no
// progress; re-running the same hang wastes the same wall-clock).
//
// TYPED ERROR (adoption #8): a Data.TaggedError (extends Error via Cause.YieldableError) —
// the `_tag`/`instanceof`/`.message` behaviour is byte-for-byte the prior plain class, and it
// is now catchable by Effect.catchTag at the turn boundary. Positional ctor kept so the single
// throw site (withTimeout) is unchanged; the subclass forwards an args object to the base.
export class NodeTimeoutError extends Data.TaggedError("NodeTimeoutError")<{
  readonly message: string
  readonly nodeId: string
  readonly timeoutMs: number
}> {
  constructor(nodeId: string, timeoutMs: number) {
    super({ message: `node ${nodeId} timed out after ${timeoutMs}ms`, nodeId, timeoutMs })
  }
}

// Classify a forward() error: is it a TRANSIENT hiccup worth retrying? We match on the
// real ax error SHAPES (read off node_modules/@ax-llm/ax): AxAIServiceStatusError carries
// a numeric `status` (retry 429 + any 5xx); AxAIServiceNetworkError/AxAIServiceTimeoutError
// are named transient classes. We deliberately DO NOT instanceof those network/timeout
// classes (importing the whole error taxonomy is brittle across ax minors) — we name-match
// the constructor + duck-type the status, which is stable. AxFunctionError + BudgetExhausted
// are explicitly NOT transient (a retry repeats them), so they fall through to `false`.
const isTransient = (err: unknown): boolean => {
  // LOGIC errors — NEVER retry (a retry yields the same deterministic failure).
  if (err instanceof AxFunctionError) return false
  if (err instanceof BudgetExhaustedError) return false
  if (err instanceof NodeTimeoutError) return false
  if (err == null || typeof err !== "object") return false
  // HTTP status — 429 (rate-limit) or any 5xx (server error) is transient.
  const status = (err as { status?: unknown }).status
  if (typeof status === "number" && (status === 429 || (status >= 500 && status < 600))) return true
  // ax's named transient error classes (network drop / request timeout) — match by the
  // constructor name so we don't depend on importing every error subclass.
  const name = (err as { name?: unknown; constructor?: { name?: unknown } }).name ?? (err as { constructor?: { name?: unknown } }).constructor?.name
  if (typeof name === "string" && /Network|Timeout|StreamTerminated/i.test(name)) return true
  return false
}

// RATE-LIMIT VISIBILITY: which KIND of transient is this — a 429 (rate-limit, the most common CF
// error) or a generic transient (5xx / network / timeout)? Only called on an already-transient
// error (isTransient true), so the duck-typed 429 status is the sole discriminator; anything else
// transient is "transient". Drives the distinct "rate-limited" vs "retrying" wording in the UI.
export const classifyTransient = (err: unknown): RetryCause =>
  err != null && typeof err === "object" && (err as { status?: unknown }).status === 429 ? "rate_limited" : "transient"

// BACKOFF SCHEDULE (pure): retry i waits base*2^i + i*(base/4) — exponential growth with a
// per-attempt stagger BY INDEX (no Math.random) so a wave of simultaneous failures doesn't re-fire
// in lockstep (deterministic, test-stable jitter). Exported so the deterministic rate-limit retry
// unit can assert the exact schedule a TestClock must advance through.
export const backoffDelayMs = (tryIndex: number): number =>
  NODE_BACKOFF_MS * 2 ** tryIndex + tryIndex * (NODE_BACKOFF_MS >> 2)

// EFFECT-NATIVE (adoption #12): the backoff wait is an `Effect.sleep` over the Effect Clock raced
// against an abort-watcher, run via Effect.runPromise — NOT a raw setTimeout. So the retry backoff
// is DETERMINISTIC under `TestClock.adjust` (the rate-limit retry unit advances virtual time across
// the schedule INSTANTLY, zero real wall-clock) while production runs it on the live clock. A
// cancelled turn still cuts the wait short: the abort branch wins the race and rejects "aborted",
// preserving the exact pre-Effect behaviour (the backoff never stalls past a cancel).
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  Effect.runPromise(
    Effect.flatMap(
      Effect.sync(() => signal.aborted),
      (already) =>
        already
          ? Effect.fail(new Error("aborted"))
          : Effect.raceFirst(
              Effect.sleep(Duration.millis(ms)),
              Effect.callback<never, Error>((resume) => {
                const onAbort = () => resume(Effect.fail(new Error("aborted")))
                signal.addEventListener("abort", onAbort, { once: true })
                return Effect.sync(() => signal.removeEventListener("abort", onAbort))
              }),
            ),
    ),
  ).then(() => undefined)

// withRetry — run `attempt()` up to NODE_ATTEMPTS times, retrying ONLY on a transient
// error (isTransient). Backoff between retries is exponential (NODE_BACKOFF_MS * 2^i)
// with a per-attempt stagger by INDEX (no Math.random): retry i waits base*2^i + i*step,
// so concurrent nodes that all failed at once don't re-fire in lockstep (deterministic,
// test-stable jitter). A logic error (AxFunctionError/budget) throws on the FIRST failure.
// `signal` (the turn's abortSignal) cuts the backoff short on cancellation.
export const withRetry = async <T>(
  attempt: (tryIndex: number) => Promise<T>,
  signal: AbortSignal,
  onRetry: (tryIndex: number, err: unknown, delayMs: number) => void = () => {},
): Promise<T> => {
  let lastErr: unknown
  for (let i = 0; i < NODE_ATTEMPTS; i++) {
    try {
      return await attempt(i)
    } catch (err) {
      lastErr = err
      // Last attempt, or a non-transient (logic) error → give up immediately.
      if (i === NODE_ATTEMPTS - 1 || !isTransient(err)) throw err
      // Exponential backoff + jitter-by-INDEX (NOT Math.random): later retries wait
      // longer AND are staggered by their own index so a wave of simultaneous failures
      // doesn't re-fire in perfect lockstep.
      const delayMs = backoffDelayMs(i)
      onRetry(i, err, delayMs)
      await sleep(delayMs, signal)
    }
  }
  throw lastErr
}

// withTimeout — race `run(signal)` against a `timeoutMs` deadline. We fork a child
// AbortController off the turn's `parentSignal` (so a cancelled turn STILL aborts the
// node), and ALSO abort it when the timer fires — so a hung forward() (which honors
// opts.abortSignal) is cut loose and the race rejects with NodeTimeoutError. The node's
// NodeOpts.abortSignal must be the forked signal so ax actually aborts the in-flight HTTP.
export const withTimeout = <T>(
  nodeId: string,
  timeoutMs: number,
  parentSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const ctrl = new AbortController()
  // A missing parent signal (a bare-stub NodeOpts in a test, or a caller that didn't thread
  // one) falls back to a never-aborted signal — so the timeout still works and cancellation
  // is simply a no-op, never a crash.
  const parent = parentSignal ?? new AbortController().signal
  // Thread the parent (turn) abort INTO the child: cancelling the turn aborts the node.
  const onParentAbort = () => ctrl.abort()
  if (parent.aborted) ctrl.abort()
  else parent.addEventListener("abort", onParentAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort() // abort the in-flight forward so it stops working, not just rejected.
      reject(new NodeTimeoutError(nodeId, timeoutMs))
    }, timeoutMs)
  })
  return Promise.race([run(ctrl.signal), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    parent.removeEventListener("abort", onParentAbort)
  })
}

// resilientNode — the node path with TRANSIENT RESILIENCE: wrap node(gen, opts)(ai, input)
// in withTimeout (per-node deadline + abort-on-hang) AND withRetry (backoff on transient
// failures only). The forked timeout signal REPLACES opts.abortSignal so ax aborts the
// real HTTP on timeout/cancel. A logic error (AxFunctionError/budget) is NOT retried; a
// hang aborts + surfaces NodeTimeoutError (the caller's fanOut maps it to a null slot).
// Resilience knobs. onRetry fires before each backoff (a live-tree delta). timeoutMs is the
// per-node wall-clock cap — default LEAF_TIMEOUT_MS (a sub-agent node should never HANG); a
// NON-FINITE value DISABLES the timeout, used by the MAIN turn (long-horizon — it can fan out
// a whole orchestration — bounded by maxSteps + abort, not a 120s leaf deadline; without this
// an orchestrating turn is guillotined mid-fan-out).
export type ResilienceOpts = {
  onRetry?: (tryIndex: number, err: unknown, delayMs: number) => void
  timeoutMs?: number
}
export const resilientNode = <I extends AxGenIn, O extends AxGenOut>(
  gen: AxGen<I, O>,
  opts: NodeOpts,
  nodeId: string,
  ai: AxAIService,
  input: I,
  r: ResilienceOpts = {},
): Promise<O> => {
  const { onRetry = () => {}, timeoutMs = LEAF_TIMEOUT_MS } = r
  // A bare-stub NodeOpts (tests) or a caller that didn't thread one falls back to a never-
  // aborted signal — resilience still works, cancellation is just a no-op.
  const signal = opts.abortSignal ?? new AbortController().signal
  const once = (nodeSignal: AbortSignal) =>
    // The forked/own signal is the node's abortSignal: ax honors it in forward(), so a
    // timeout/cancel actually stops the in-flight request (not just rejects the race).
    node(gen, { ...opts, abortSignal: nodeSignal })(ai, input)
  return withRetry(
    () => (Number.isFinite(timeoutMs) ? withTimeout(nodeId, timeoutMs, signal, once) : once(signal)),
    signal,
    onRetry,
  )
}
