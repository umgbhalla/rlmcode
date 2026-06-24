// STALL-WATCHDOG (FIX A) — the main chat turn's stream drain is the ONE CF path with no timeout.
// agent.ts drains chat.streamingForward in a `for await`; orch-recipes.ts's isMainTurn carve-out
// sets POSITIVE_INFINITY so orch-resilience skips the per-node withTimeout (right for a long
// fan-out, but it left the single stream bare). If CF stalls mid-stream (half-open socket, Worker
// freeze, backpressure — no done, no error) the drain suspends forever → run.ts .finally never
// runs → queue.close() never fires → the turn's reply promise never settles → infinite spinner.
// Every OTHER CF path is timeout-wrapped (leaf 120s / wf 300s / RLM 600s); only the main turn was
// bare. This module is that backstop, split out of agent.ts to keep it under the line budget.
//
// TOOL-AWARE STALL (long-session resilience): ax executes TOOLS *inside* streamingForward — the
// generator's it.next() BLOCKS while a bash / a multi-minute workflow / an RLM mine runs, yielding
// NO delta the whole time. A naive inter-chunk stall then fires a FALSE "stream stalled" on real
// tool work. The fix: the watchdog SUBSCRIBES to the per-turn activity bus (the SAME `emit` ax's
// logger feeds) and tracks tool state — a `tool` activity opens a "tool executing" window, its
// `result` closes it. While a tool is executing the per-chunk (inter-chunk + first-token) idle
// deadline is SUSPENDED; only the per-turn WALL-CLOCK cap stays armed (a tool that genuinely hangs
// 24h still terminates). When the tool finishes the idle budget restarts fresh. This is a PROXY
// (the emit brackets the model→result round-trip, not ax's exact handler call) but it's the signal
// the codebase already carries, and the wall cap backstops its imprecision.
//
// EFFECT-NATIVE (adoption #5 + #12): the deadline race is expressed with `Effect.race` + a POLLING
// `Effect.sleep` over the Effect Clock — NOT a hand-rolled `setTimeout` + `Promise.race`. The poll
// is what makes "suspend the idle timer while a tool runs" work even though it.next() is blocked:
// each poll tick recomputes the deadline against the LATEST tool state. Two payoffs: (1) the timing
// is deterministic under `TestClock.adjust` (the `test/turn-stall` unit proves long-tool-no-stall /
// dead-air-recovers / warmup+wall-cap INSTANTLY, zero real wall-clock); (2) it composes with the
// rest of the engine's Effect tracer/runtime. Production keeps a thin Promise façade
// (`drainWithWatchdog`) that runs the Effect on the default runtime.
//
// RECOVER ON GENUINE STALL (PART 2): when the idle deadline DOES fire (real dead air, no tool
// running) the failure is typed `retryable` IFF no tool ran yet (toolCount === 0). agent.ts wraps
// the drain in withRetry: a retryable stall backs off + retries the forward (a network hiccup is
// safe to redo when no tool had side effects), surfaced as a node `retry` event; a non-retryable
// stall (a tool already ran, or the wall cap) ⚠-aborts with no retry. The wall cap is NEVER
// retryable (a genuine runaway must terminate, not loop).
// ponytail: fixed 120s/600s defaults + a tool-state PROXY (the gate brackets the model→result
// round-trip, not ax's exact handler call). Upgrade: derive the inter-chunk threshold from observed
// CF p99 inter-chunk latency (telemetry already records forward.sent→received) instead of a
// hand-picked constant, and read a precise tool execute/done signal from an ax internal hook.
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { Activity } from "./activity.ts"
import type { ActivitySink } from "./orch.ts"
import { withRetry } from "./orch-resilience.ts"

// Two env-tunable guards, both threading the turn's AbortController so a fire CANCELS the in-flight
// CF request (best-effort — a CF stream that honors the signal stops its fetch), not just rejects
// the JS race: (1) a PER-CHUNK stall deadline reset on every delta — a continuous-but-slow stream
// is never penalised, but dead air aborts; (2) an OUTER per-turn wall-clock cap as a backstop for a
// stream that trickles forever / a runaway step loop. A NON-FINITE value DISABLES the guard (tests
// pass Infinity to pin the no-watchdog path). The inter-chunk default is 120s (raised from 60s —
// 60s was empirically tight for CF p99 + a slow non-tool generation gap), still abort-threaded.
export const STREAM_STALL_MS = (() => {
  const v = Number(process.env.RLM_STREAM_STALL_MS ?? 120_000)
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY
})()
// FIRST-TOKEN deadline (fixes F7): distinct from the inter-chunk stall — a reasoning model can
// think/warm-up for minutes before the FIRST delta lands, so the first pull gets a generous budget
// (~5min) while NO chunk has arrived. Once the first delta lands we switch to the tight inter-chunk
// STREAM_STALL_MS. A single 60s threshold conflated the two → false-positive aborts on slow models.
export const FIRST_TOKEN_MS = (() => {
  const v = Number(process.env.RLM_FIRST_TOKEN_MS ?? 300_000)
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY
})()
export const TURN_TIMEOUT_MS = (() => {
  const v = Number(process.env.RLM_TURN_TIMEOUT_MS ?? 600_000)
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY
})()

// Poll slice (ms): how often the watchdog re-evaluates the deadline against the latest tool state.
// Small enough that the idle fire is precise to ~this granularity, large enough not to busy-spin.
// It is ONLY a re-evaluation cadence — it never SHORTENS a deadline, so it can't cause a false fire.
const POLL_MS = 250

// One streaming delta — ax yields { delta: Partial<OUT> } per chunk; OUT here is `reply:string`,
// and a thinking model also fills `thought`. Both are incremental (appended per chunk).
type StreamDelta = { delta?: { reply?: string; thought?: string } }

// Knobs the watchdog races against — injectable so a test can pin tiny deterministic deadlines
// without poking module-load env. Production passes the module STREAM_STALL_MS / TURN_TIMEOUT_MS.
export type WatchdogLimits = { readonly stallMs: number; readonly turnMs: number; readonly firstTokenMs: number }
const DEFAULT_LIMITS: WatchdogLimits = { stallMs: STREAM_STALL_MS, turnMs: TURN_TIMEOUT_MS, firstTokenMs: FIRST_TOKEN_MS }

// A typed stall/wall failure. `retryable` = a GENUINE inter-chunk/first-token stall with NO tool
// having run (toolCount === 0) — safe for agent.ts to retry the whole forward (a network hiccup,
// re-running redoes no side effect). FALSE on the wall cap (a runaway must terminate) and on any
// stall AFTER a tool ran (the tool may have written a file / made a request — re-running the
// forward would redo it). It extends Error so the message contract ("stream stalled" / "turn
// exceeded") is byte-identical to the old plain throw that run.ts.serializeError reads.
export class StreamStallError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = "StreamStallError"
    this.retryable = retryable
  }
}

// TOOL GATE — the shared tool-execution signal between ax's logger and the watchdog. ax calls the
// logger (a SEPARATE consumer of the per-turn emit) when a tool is CALLED (`tool` activity) and
// when its RESULT arrives (`result` activity); the watchdog, blocked inside it.next() the whole
// time the tool runs, can't see those itself. So agent.ts threads ONE ToolGate into BOTH: the
// logger feeds it via `observe(activity)`, the watchdog reads `depth()`/`count()` each poll tick.
// `depth` > 0 ⇒ a tool is executing → the watchdog suspends the idle deadline; `count` is the
// retry gate (a stall is retryable only if NO tool ran). `bumpedAt` is the last tool-boundary time
// so the idle budget restarts fresh when a tool finishes. A turn with no tools never touches it.
// `epoch` is a monotonic counter bumped on EVERY tool boundary (call + result) — NOT a timestamp.
// The watchdog can't read a wall clock (it lives on the Effect Clock so TestClock can drive it
// deterministically; Date.now() is frozen under TestClock). So instead of "when did the last tool
// touch happen", the gate exposes "how many tool boundaries have occurred"; the watchdog notices
// when the epoch CHANGED and re-anchors its idle budget to the Effect-clock now. Tool depth/count
// are the live signals (suspend the idle deadline / gate the retry).
export type ToolGate = {
  readonly observe: ActivitySink // call from the per-turn logger emit; counts tool/result, forwards nothing
  readonly depth: () => number
  readonly count: () => number
  readonly epoch: () => number
}

export const makeToolGate = (): ToolGate => {
  let depth = 0
  let count = 0
  let epoch = 0
  return {
    observe: (a: Activity) => {
      if (a.kind === "tool") {
        depth += 1
        count += 1
        epoch += 1
      } else if (a.kind === "result") {
        depth = Math.max(0, depth - 1)
        epoch += 1 // tool finished → the watchdog re-anchors the idle budget from now
      }
    },
    depth: () => depth,
    count: () => count,
    epoch: () => epoch,
  }
}

// A pending iterator step, or the watchdog firing. The watchdog branch carries WHICH guard tripped
// so the surfaced "⚠ …" partial names the right cause; the step branch carries the next chunk.
type Pull = { readonly done: true } | { readonly value: unknown }

// drainWithWatchdogEffect — the Effect-native core. Drains ax's streamingForward iterator under
// the guards via `Effect.race`: each `it.next()` (wrapped in Effect.tryPromise) races a POLLING
// watchdog. The watchdog sleeps in POLL_MS slices over the Effect Clock, recomputing the deadline
// each tick against the LATEST tool state — so `TestClock.adjust` drives it deterministically and a
// tool window (opened by a `tool` activity, closed by its `result`) SUSPENDS the idle deadline
// while the (blocked) it.next() runs the tool. On a fire we abort the turn (best-effort CF cancel)
// and FAIL with the typed StreamStallError; the failure propagates so the caller's errorResult maps
// it to a "⚠ …" partial (NOT the "Interrupted." user-abort text), or — when retryable — retries.
//
// CRITICAL (the hang must NOT depend on the generator cooperating): on every exit path we fire
// it.return() but do NOT await it — a STALLED ax generator's return() can itself hang (it tries to
// settle the same dead in-flight request); awaiting it would re-hang the turn. So cleanup is a
// best-effort fire-and-forget `Effect.sync` finalizer (rejection swallowed). The control-flow exit
// is the race alone. Returns the accumulated reply prose on a clean end.
// PER-NODE STREAM ROUTING (F8): `nodeId` tags every replyDelta/thinkingDelta this drain emits with
// the orchestration NODE that owns the stream. UNDEFINED (the main-turn default) ⇒ untagged deltas
// grow the transcript reply; SET (a node forwarding with stream:true, threaded from runNode) ⇒ the
// deltas carry the node id so atoms grows THAT node's transient text instead of corrupting the main
// reply. The drain logic is identical either way — the tag just rides the emit.
export const drainWithWatchdogEffect = (
  stream: AsyncIterable<unknown>,
  aborter: AbortController,
  emit: ActivitySink,
  limits: WatchdogLimits = DEFAULT_LIMITS,
  nodeId?: string,
  gate: ToolGate = makeToolGate(),
): Effect.Effect<string, StreamStallError> =>
  Effect.flatMap(Effect.clockWith((c) => c.currentTimeMillis), (entryNow) => {
    const it = stream[Symbol.asyncIterator]()
    const wallStart = entryNow // Effect-clock entry — wall cap is wallStart + turnMs
    let reply = ""
    // FIRST-TOKEN vs INTER-CHUNK (fixes F7): true until the FIRST delta lands. While no chunk has
    // arrived the idle guard is the generous firstTokenMs (reasoning/warmup budget); after the first
    // delta it switches to the tight inter-chunk stallMs. The wall-clock cap backstops both phases.
    let firstStep = true
    // The idle anchor (Effect-clock ms) the idle deadline is measured FROM — reset on every real
    // delta AND whenever the watchdog notices a tool boundary (the gate epoch changed), so a long
    // tool never "eats" the next gap's budget and a fresh delta restarts the idle budget.
    let idleAnchor = entryNow
    let seenEpoch = gate.epoch()

    // The idle deadline at `now`: Infinity while a tool executes (suspended via the gate's depth) OR
    // when the idle guard is non-finite (disabled). Otherwise idleAnchor + (firstTokenMs before the
    // first delta, stallMs after). The anchor is re-pinned to `now` lazily here when a tool boundary
    // is observed since the last check — so the budget restarts FRESH the moment a tool finishes.
    const idleDeadline = (now: number): number => {
      const ep = gate.epoch()
      if (ep !== seenEpoch) {
        seenEpoch = ep
        idleAnchor = now // a tool just started/finished → re-anchor the idle budget to now
      }
      if (gate.depth() > 0) return Number.POSITIVE_INFINITY
      const idleMs = firstStep ? limits.firstTokenMs : limits.stallMs
      return Number.isFinite(idleMs) ? idleAnchor + idleMs : Number.POSITIVE_INFINITY
    }
    const wallDeadline = (): number => (Number.isFinite(limits.turnMs) ? wallStart + limits.turnMs : Number.POSITIVE_INFINITY)

    // The POLLING watchdog: a recursive Effect that reads the Effect Clock, re-checks the deadlines
    // against the LATEST tool state, fires if one passed (abort + typed fail), else sleeps the
    // smaller of POLL_MS and the time-to-deadline and recurses. A fully-disabled guard (both
    // deadlines Infinity) sleeps POLL_MS forever — the race's pull branch is the only way out then
    // (the no-watchdog path). The poll re-anchors on tool boundaries but NEVER shortens a real
    // deadline, so it can only fire LATE by ≤POLL_MS, never early/falsely.
    const watchdog: Effect.Effect<Pull, StreamStallError> = Effect.flatMap(
      Effect.clockWith((c) => c.currentTimeMillis),
      (now) => {
        const idle = idleDeadline(now)
        const wall = wallDeadline()
        const deadline = Math.min(idle, wall)
        if (now >= deadline) {
          const isWall = wall <= idle
          const onFirst = firstStep
          const retryable = !isWall && gate.count() === 0 // a genuine no-tool stall is safe to retry
          return Effect.failSync(() => {
            aborter.abort() // cancel the in-flight CF fetch, not just the JS race
            // Three distinct causes: the wall cap, the first-token (no chunk yet) budget, or the
            // inter-chunk stall. The "stream stalled" wording stays the contract for the inter-chunk
            // fire; the first-token fire gets its OWN message so the surfaced ⚠ names the right cause.
            const idleMsg = onFirst ? `no first token in ${limits.firstTokenMs}ms` : `stream stalled >${limits.stallMs}ms`
            return new StreamStallError(isWall ? `turn exceeded ${limits.turnMs}ms` : idleMsg, retryable)
          })
        }
        const sleepMs = Number.isFinite(deadline) ? Math.min(POLL_MS, deadline - now) : POLL_MS
        return Effect.flatMap(Effect.sleep(Duration.millis(Math.max(1, sleepMs))), () => watchdog)
      },
    )

    const stepOnce: Effect.Effect<Pull, StreamStallError> = Effect.suspend(() => {
      const pull: Effect.Effect<Pull, StreamStallError> = Effect.map(
        Effect.tryPromise({ try: () => it.next(), catch: (e) => e as StreamStallError }),
        (n): Pull => (n.done === true ? { done: true } : { value: n.value }),
      )
      // raceFirst (NOT race): the FIRST to COMPLETE — success OR failure — decides and interrupts
      // the loser. The watchdog branch FAILS on a fire, and that failure must win the race (plain
      // `race` returns the first SUCCESS, suppressing the timer's failure → the turn would hang).
      return Effect.raceFirst(pull, watchdog)
    })

    const loop: Effect.Effect<string, StreamStallError> = Effect.flatMap(stepOnce, (next) => {
      if ("done" in next) return Effect.succeed(reply)
      firstStep = false // a chunk arrived → switch the idle guard from firstTokenMs to stallMs
      const delta = (next.value as StreamDelta).delta ?? {}
      if (delta.thought) emit({ kind: "thinkingDelta", text: delta.thought, nodeId })
      if (delta.reply) {
        reply += delta.reply
        emit({ kind: "replyDelta", text: delta.reply, nodeId })
      }
      // A real delta is progress → reset the idle anchor to the Effect-clock now for the next gap.
      return Effect.flatMap(Effect.clockWith((c) => c.currentTimeMillis), (n) => {
        idleAnchor = n
        return loop
      })
    })

    // Best-effort, NON-awaited release (see CRITICAL above): a stalled generator's return() may
    // hang, so we never block the watchdog's exit on it. void + catch so it's truly fire-and-forget.
    return Effect.ensuring(
      loop,
      Effect.sync(() => {
        void Promise.resolve(it.return?.()).catch(() => {})
      }),
    )
  })

// drainWithWatchdog — the Promise façade for agent.ts's turn loop (which drains inside a plain
// async fn under Effect.tryPromise). Runs the Effect core on the default runtime. The Effect uses
// only Clock/race/tryPromise (R = never), so a plain runPromise discharges it; the rejection (the
// typed StreamStallError) flows out exactly as the old inline race rejected, so agent.ts's
// ChatError wrap + run.ts.serializeError mapping are byte-unchanged. The thrown StreamStallError
// carries `.retryable` so agent.ts's withRetry wrapper can decide to retry vs ⚠-abort.
export const drainWithWatchdog = (
  stream: AsyncIterable<unknown>,
  aborter: AbortController,
  emit: ActivitySink,
  nodeId?: string,
  gate?: ToolGate,
): Promise<string> => Effect.runPromise(drainWithWatchdogEffect(stream, aborter, emit, DEFAULT_LIMITS, nodeId, gate))

// runStreamWithRetry — the main turn's RECOVER-ON-GENUINE-STALL wrapper (PART 2). Runs `forward`
// (open the ax stream + drain it under the tool-aware watchdog) up to NODE_ATTEMPTS times, retrying
// ONLY on a transient (a retryable StreamStallError — a no-tool dead-air hang — or an ax transient,
// per orch-resilience.isTransient). Each attempt forks a FRESH AbortController off the turn
// `turnAborter` (turn abort → attempt abort) so a retryable stall's abort cancels ONLY that
// attempt's in-flight CF fetch, leaving the turn aborter clean for the next try; a non-retryable
// stall (a tool already ran, or the wall cap) or exhaustion rethrows → agent.ts wraps it in
// ChatError → a "⚠ …" partial. ONE shared ToolGate across attempts is fine: a fresh forward emits
// fresh tool/result activities; count only gates THIS attempt's retry decision at the watchdog. The
// drain runs on the default runtime (R=never) — the Promise façade keeps agent.ts Effect-free here.
export const runStreamWithRetry = (
  forward: (attemptAborter: AbortController) => Promise<string>,
  turnAborter: AbortController,
  onRetry: (tryIndex: number, err: unknown, delayMs: number) => void,
): Promise<string> =>
  withRetry(
    async () => {
      const attemptAborter = new AbortController()
      if (turnAborter.signal.aborted) attemptAborter.abort()
      const onTurnAbort = () => attemptAborter.abort()
      turnAborter.signal.addEventListener("abort", onTurnAbort, { once: true })
      try {
        return await forward(attemptAborter)
      } finally {
        turnAborter.signal.removeEventListener("abort", onTurnAbort)
      }
    },
    turnAborter.signal,
    onRetry,
  )
