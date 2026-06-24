// STALL-WATCHDOG (FIX A) — the main chat turn's stream drain is the ONE CF path with no timeout.
// agent.ts drains chat.streamingForward in a `for await`; orch-recipes.ts's isMainTurn carve-out
// sets POSITIVE_INFINITY so orch-resilience skips the per-node withTimeout (right for a long
// fan-out, but it left the single stream bare). If CF stalls mid-stream (half-open socket, Worker
// freeze, backpressure — no done, no error) the drain suspends forever → run.ts .finally never
// runs → queue.close() never fires → the turn's reply promise never settles → infinite spinner.
// Every OTHER CF path is timeout-wrapped (leaf 120s / wf 300s / RLM 600s); only the main turn was
// bare. This module is that backstop, split out of agent.ts to keep it under the line budget.
import type { ActivitySink } from "./orch.ts"

// Two env-tunable guards, both threading the turn's AbortController so a fire CANCELS the in-flight
// CF request (best-effort — a CF stream that honors the signal stops its fetch), not just rejects
// the JS race: (1) a PER-CHUNK stall deadline reset on every delta — a continuous-but-slow stream
// is never penalised, but dead air aborts; (2) an OUTER per-turn wall-clock cap as a backstop for a
// stream that trickles forever / a runaway step loop. A NON-FINITE value DISABLES the guard (tests
// pass Infinity to pin the no-watchdog path). Defaults restore parity with the LEAF/WF/RLM paths.
// ponytail: fixed 60s/600s defaults. Upgrade: derive from observed CF p99 inter-chunk latency
// (telemetry already records forward.sent→received) instead of a hand-picked constant.
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

// Race one iterator step against a deadline timer. If the timer wins: abort the turn (so a CF
// stream that honors the signal cancels its live request) and REJECT with the typed stall/wall
// message. `isWall` picks the message so the surfaced "⚠ …" partial is honest about which guard
// fired. Cleared in finally so a fast chunk never leaves a dangling timer.
// ponytail: single-caller timer-race helper. Upgrade: inline into drainWithWatchdog when the two-deadline logic is touched next.
const raceDeadline = (
  step: Promise<IteratorResult<unknown>>,
  ms: number,
  aborter: AbortController,
  isWall: boolean,
): Promise<IteratorResult<unknown>> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      aborter.abort() // cancel the in-flight CF fetch, not just the JS race
      reject(new Error(isWall ? `turn exceeded ${TURN_TIMEOUT_MS}ms` : `stream stalled >${STREAM_STALL_MS}ms`))
    }, ms)
  })
  return Promise.race([step, watchdog]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

// drainWithWatchdog — drain ax's streamingForward iterator under BOTH guards. On every delta we
// push the thought/reply to the per-turn emit AND reset the per-chunk stall deadline; an absolute
// wall-clock deadline is fixed once at entry. Each `it.next()` races a single timer set to whichever
// deadline is SOONER; if the timer wins, raceDeadline aborts the turn (best-effort CF cancel) and
// rejects with a TYPED message ("stream stalled"/"turn exceeded"), which propagates out here so
// run.ts.errorResult maps it to a "⚠ …" partial (NOT the "Interrupted." user-abort text).
//
// CRITICAL (the hang must NOT depend on the generator cooperating): on exit we fire it.return() but
// do NOT await it — a STALLED ax generator's return() can itself hang (it tries to settle the same
// dead in-flight request), and awaiting it in `finally` would swallow the watchdog's rejection and
// re-hang the turn. So cleanup is best-effort fire-and-forget (rejection swallowed); the
// control-flow exit is the race rejection alone. Returns the accumulated reply prose on a clean end.
export const drainWithWatchdog = async (
  stream: AsyncIterable<unknown>,
  aborter: AbortController,
  emit: ActivitySink,
): Promise<string> => {
  const it = stream[Symbol.asyncIterator]()
  const wallDeadline = Date.now() + TURN_TIMEOUT_MS // Infinity ⇒ +Infinity ⇒ never fires
  let reply = ""
  try {
    for (;;) {
      const stallDeadline = Date.now() + STREAM_STALL_MS // reset each chunk; Infinity ⇒ never
      const deadline = Math.min(stallDeadline, wallDeadline)
      const ms = deadline - Date.now()
      // Both guards disabled (tests / both Infinity): plain await, no timer, no watchdog.
      const next = Number.isFinite(ms)
        ? await raceDeadline(it.next(), Math.max(0, ms), aborter, deadline === wallDeadline)
        : await it.next()
      if (next.done === true) break
      const delta = (next.value as StreamDelta).delta ?? {}
      if (delta.thought) emit({ kind: "thinkingDelta", text: delta.thought })
      if (delta.reply) {
        reply += delta.reply
        emit({ kind: "replyDelta", text: delta.reply })
      }
    }
  } finally {
    // Best-effort, NON-awaited release (see CRITICAL above): a stalled generator's return() may
    // hang, so we never block the watchdog's exit on it. void + catch so it's truly fire-and-forget.
    void Promise.resolve(it.return?.()).catch(() => {})
  }
  return reply
}
