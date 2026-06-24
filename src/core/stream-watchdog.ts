// STALL-WATCHDOG (FIX A) — the main chat turn's stream drain is the ONE CF path with no timeout.
// agent.ts drains chat.streamingForward in a `for await`; orch-recipes.ts's isMainTurn carve-out
// sets POSITIVE_INFINITY so orch-resilience skips the per-node withTimeout (right for a long
// fan-out, but it left the single stream bare). If CF stalls mid-stream (half-open socket, Worker
// freeze, backpressure — no done, no error) the drain suspends forever → run.ts .finally never
// runs → queue.close() never fires → the turn's reply promise never settles → infinite spinner.
// Every OTHER CF path is timeout-wrapped (leaf 120s / wf 300s / RLM 600s); only the main turn was
// bare. This module is that backstop, split out of agent.ts to keep it under the line budget.
//
// EFFECT-NATIVE (adoption #5 + #12): the double-deadline race is now expressed with `Effect.race`
// + `Effect.sleep` over the Effect Clock — NOT a hand-rolled `setTimeout` + `Promise.race`. Two
// payoffs: (1) the timing is deterministic under `TestClock.adjust` (the `test/turn-stall` unit
// proves fires-on-stall / no-hang / clean-pass INSTANTLY, zero real wall-clock); (2) it composes
// with the rest of the engine's Effect tracer/runtime. Production keeps a thin Promise façade
// (`drainWithWatchdog`) that runs the Effect on the default runtime — byte-identical behaviour to
// the old inline race, same thrown-message contract ("stream stalled" / "turn exceeded") which
// run.ts.errorResult maps to a "⚠ …" partial.
// ponytail: fixed 60s/600s defaults. Upgrade: derive from observed CF p99 inter-chunk latency
// (telemetry already records forward.sent→received) instead of a hand-picked constant.
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { ActivitySink } from "./orch.ts"

// Two env-tunable guards, both threading the turn's AbortController so a fire CANCELS the in-flight
// CF request (best-effort — a CF stream that honors the signal stops its fetch), not just rejects
// the JS race: (1) a PER-CHUNK stall deadline reset on every delta — a continuous-but-slow stream
// is never penalised, but dead air aborts; (2) an OUTER per-turn wall-clock cap as a backstop for a
// stream that trickles forever / a runaway step loop. A NON-FINITE value DISABLES the guard (tests
// pass Infinity to pin the no-watchdog path). Defaults restore parity with the LEAF/WF/RLM paths.
export const STREAM_STALL_MS = (() => {
  const v = Number(process.env.RLM_STREAM_STALL_MS ?? 60_000)
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY
})()
export const TURN_TIMEOUT_MS = (() => {
  const v = Number(process.env.RLM_TURN_TIMEOUT_MS ?? 600_000)
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY
})()

// One streaming delta — ax yields { delta: Partial<OUT> } per chunk; OUT here is `reply:string`,
// and a thinking model also fills `thought`. Both are incremental (appended per chunk).
type StreamDelta = { delta?: { reply?: string; thought?: string } }

// Knobs the watchdog races against — injectable so a test can pin tiny deterministic deadlines
// without poking module-load env. Production passes the module STREAM_STALL_MS / TURN_TIMEOUT_MS.
export type WatchdogLimits = { readonly stallMs: number; readonly turnMs: number }
const DEFAULT_LIMITS: WatchdogLimits = { stallMs: STREAM_STALL_MS, turnMs: TURN_TIMEOUT_MS }

// A pending iterator step, or the watchdog firing. The watchdog branch carries WHICH guard tripped
// so the surfaced "⚠ …" partial names the right cause; the step branch carries the next chunk.
type Pull = { readonly done: true } | { readonly value: unknown }

// drainWithWatchdogEffect — the Effect-native core. Drains ax's streamingForward iterator under
// BOTH guards via `Effect.race`: each `it.next()` (wrapped in Effect.tryPromise) races a single
// `Effect.sleep` set to whichever deadline is SOONER (per-chunk stall, reset each loop, vs the
// fixed wall-clock cap). The sleep runs on the Effect Clock, so `TestClock.adjust` drives it
// deterministically in tests and the real clock drives it in prod. On a fire we abort the turn
// (best-effort CF cancel) and FAIL with the typed message; the failure propagates so the caller's
// errorResult maps it to a "⚠ …" partial (NOT the "Interrupted." user-abort text).
//
// CRITICAL (the hang must NOT depend on the generator cooperating): on every exit path we fire
// it.return() but do NOT await it — a STALLED ax generator's return() can itself hang (it tries to
// settle the same dead in-flight request); awaiting it would re-hang the turn. So cleanup is a
// best-effort fire-and-forget `Effect.sync` finalizer (rejection swallowed). The control-flow exit
// is the race alone. Returns the accumulated reply prose on a clean end.
export const drainWithWatchdogEffect = (
  stream: AsyncIterable<unknown>,
  aborter: AbortController,
  emit: ActivitySink,
  limits: WatchdogLimits = DEFAULT_LIMITS,
): Effect.Effect<string, Error> =>
  Effect.suspend(() => {
    const it = stream[Symbol.asyncIterator]()
    const wallStart = Date.now()
    let reply = ""

    // One iterator step raced against a deadline. `remaining` is the soonest of the per-chunk stall
    // (from NOW) and the absolute wall-clock cap (from entry). A non-finite remaining ⇒ no timer
    // (both guards disabled / Infinity) ⇒ a plain pull, no watchdog. The race interrupts the loser:
    // if the timer wins, `aborter.abort()` cancels the in-flight CF fetch and we Effect.fail.
    const stepOnce: Effect.Effect<Pull, Error> = Effect.suspend(() => {
      const stallDeadline = Date.now() + limits.stallMs // reset each chunk; Infinity ⇒ never
      const wallDeadline = wallStart + limits.turnMs // Infinity ⇒ +Infinity ⇒ never fires
      const deadline = Math.min(stallDeadline, wallDeadline)
      const remaining = deadline - Date.now()
      const pull: Effect.Effect<Pull, Error> = Effect.map(
        Effect.tryPromise({ try: () => it.next(), catch: (e) => e as Error }),
        (n): Pull => (n.done === true ? { done: true } : { value: n.value }),
      )
      if (!Number.isFinite(remaining)) return pull
      const isWall = deadline === wallDeadline
      const watchdog: Effect.Effect<Pull, Error> = Effect.sleep(Duration.millis(Math.max(0, remaining))).pipe(
        Effect.flatMap(() =>
          Effect.failSync(() => {
            aborter.abort() // cancel the in-flight CF fetch, not just the JS race
            return new Error(isWall ? `turn exceeded ${limits.turnMs}ms` : `stream stalled >${limits.stallMs}ms`)
          }),
        ),
      )
      // raceFirst (NOT race): the FIRST to COMPLETE — success OR failure — decides and interrupts
      // the loser. The watchdog branch FAILS on a fire, and that failure must win the race (plain
      // `race` returns the first SUCCESS, suppressing the timer's failure → the turn would hang).
      return Effect.raceFirst(pull, watchdog)
    })

    const loop: Effect.Effect<string, Error> = Effect.flatMap(stepOnce, (next) => {
      if ("done" in next) return Effect.succeed(reply)
      const delta = (next.value as StreamDelta).delta ?? {}
      if (delta.thought) emit({ kind: "thinkingDelta", text: delta.thought })
      if (delta.reply) {
        reply += delta.reply
        emit({ kind: "replyDelta", text: delta.reply })
      }
      return loop
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
// typed stall/wall Error) flows out exactly as the old inline race rejected, so agent.ts's
// ChatError wrap + run.ts.errorResult mapping are byte-unchanged.
export const drainWithWatchdog = (
  stream: AsyncIterable<unknown>,
  aborter: AbortController,
  emit: ActivitySink,
): Promise<string> => Effect.runPromise(drainWithWatchdogEffect(stream, aborter, emit))
