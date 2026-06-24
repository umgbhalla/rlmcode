// FIX A — the main chat turn's STALL-WATCHDOG, proven DETERMINISTICALLY with TestClock (adoption
// #12). drainWithWatchdogEffect (stream-watchdog.ts) races each stream pull against an Effect.sleep
// over the Effect Clock, so virtual time drives BOTH guards: a fork + TestClock.adjust fires the
// per-chunk stall / wall-clock cap INSTANTLY — no real setTimeout, no Promise.race, no wall-clock
// (the old it.live test held ~300ms of real time and was timing-fragile). Pins: (1) FIRES ON STALL
// — one chunk then dead air → the watchdog fails with the typed "stream stalled" message after the
// stall ms elapse in virtual time, and the turn's AbortController is aborted (best-effort CF
// cancel); (2) WALL-CLOCK CAP — a trickle that never stalls per-chunk still fails with "turn
// exceeded" once the outer cap elapses; (3) NO HANG / clean pass — a stream that closes resolves to
// its real reply, the watchdog never trips; (4) the FULL turn over a LAYER-INJECTED mock (no
// switch-on-prompt global) returns the reply verbatim through the public SDK.
import type { AxChatRequest, AxChatResponse } from "@ax-llm/ax"
import { expect, it } from "@effect/vitest"
import { Cause, Effect, Fiber } from "effect"
import * as Duration from "effect/Duration"
import { TestClock } from "effect/testing"
import { createAgent } from "../src/core/sdk.ts"
import { drainWithWatchdogEffect, makeToolGate, StreamStallError, type ToolGate } from "../src/core/stream-watchdog.ts"
import { AxAI } from "./ax-layer.ts"

const usage = { ai: "mock", model: "@mock/test", tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }

// A delta the watchdog turns into a thinkingDelta/replyDelta. The drain reads `.delta.{thought,reply}`.
const delta = (d: { thought?: string; reply?: string }) => ({ delta: d })

// An async-iterable that yields the SCRIPTED chunks then HANGS forever (the half-open-socket
// shape) — its pull promise never settles after the last scripted chunk, so only the watchdog can
// end the drain. A non-stalling variant (hangAfter=false) closes cleanly after the chunks.
const scriptedStream = (chunks: ReadonlyArray<{ thought?: string; reply?: string }>, hangAfter = true): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]() {
    let i = 0
    return {
      next(): Promise<IteratorResult<unknown>> {
        if (i < chunks.length) return Promise.resolve({ done: false, value: delta(chunks[i++]!) })
        if (hangAfter) return new Promise<never>(() => {}) // dead air — never settles
        return Promise.resolve({ done: true, value: undefined })
      },
    }
  },
})

// Drive the watchdog Effect on a forked fiber, advance virtual time by `adjustMs`, then join.
// Returns the Exit so a test can assert success (clean reply) or failure (the typed stall/wall msg).
const driveWatchdog = (
  stream: AsyncIterable<unknown>,
  aborter: AbortController,
  adjustMs: number,
  stallMs: number,
  turnMs: number,
  firstTokenMs = 300_000,
  gate?: ToolGate,
) =>
  Effect.gen(function* () {
    const events: Array<{ kind: string; text?: string }> = []
    const emit = (a: { kind: string; text?: string }) => void events.push(a)
    const fiber = yield* Effect.forkChild(drainWithWatchdogEffect(stream, aborter, emit as never, { stallMs, turnMs, firstTokenMs }, undefined, gate))
    yield* TestClock.adjust(Duration.millis(adjustMs))
    const exit = yield* Effect.exit(Fiber.join(fiber))
    // The drain FAILS with a StreamStallError on a watchdog fire; squash flattens the Cause to it so
    // the typed "stream stalled" / "turn exceeded" message is assertable. Empty string on success.
    const msg = exit._tag === "Failure" ? String((Cause.squash(exit.cause) as { message?: string })?.message ?? "") : ""
    return { exit, events, msg }
  })

it.effect("FIRES ON STALL: one chunk then dead air → 'stream stalled' after the stall ms (virtual), aborts the turn", () =>
  Effect.gen(function* () {
    const aborter = new AbortController()
    const { exit, events, msg } = yield* driveWatchdog(scriptedStream([{ thought: "thinking…" }]), aborter, 60_000, 60_000, 600_000)
    expect(exit._tag, "the watchdog FAILED the drain (it fired) — no infinite hang").toBe("Failure")
    expect(/stream stalled/i.test(msg), "the failure is the STALL message, not the wall cap").toBe(true)
    expect(aborter.signal.aborted, "the watchdog aborted the turn's controller (best-effort CF cancel)").toBe(true)
    expect(events.some((e) => e.kind === "thinkingDelta"), "the one real chunk was emitted before the stall").toBe(true)
  }),
)

it.effect("FIRST-TOKEN BUDGET: a 90s gap BEFORE any chunk does NOT fire (under the 300s first-token budget)", () =>
  Effect.gen(function* () {
    // No chunk has arrived yet (reasoning model warming up). 90s of dead air is WELL under the
    // generous firstTokenMs (300s) — the OLD single 60s stall would have false-aborted here. The
    // fiber must still be suspended (no fire) after 90s of virtual time.
    const aborter = new AbortController()
    const events: Array<{ kind: string }> = []
    const emit = (a: { kind: string }) => void events.push(a)
    const fiber = yield* Effect.forkChild(
      drainWithWatchdogEffect(scriptedStream([]), aborter, emit as never, { stallMs: 60_000, turnMs: 600_000, firstTokenMs: 300_000 }),
    )
    yield* TestClock.adjust(Duration.millis(90_000)) // 90s — past the 60s inter-chunk stall, under the 300s first-token budget
    expect(fiber.pollUnsafe(), "still draining — the first-token budget (300s) did NOT fire at 90s").toBe(undefined)
    expect(aborter.signal.aborted, "no abort — the warmup gap is within the first-token budget").toBe(false)
    yield* Fiber.interrupt(fiber) // clean up the suspended fiber (it would hang forever otherwise)
  }),
)

it.effect("INTER-CHUNK STALL: one chunk THEN a 90s gap DOES fire 'stream stalled' (the tight 60s guard is active after the first delta)", () =>
  Effect.gen(function* () {
    // The first delta landed → firstStep flips → the idle guard tightens to the 60s inter-chunk
    // stall. A 90s gap now EXCEEDS it and fires the STALL message (NOT the first-token message),
    // proving the two phases use distinct thresholds off the SAME stream shape.
    const aborter = new AbortController()
    const { exit, msg, events } = yield* driveWatchdog(scriptedStream([{ reply: "first " }]), aborter, 90_000, 60_000, 600_000, 300_000)
    expect(exit._tag, "the inter-chunk stall FIRED after the first delta (90s > 60s)").toBe("Failure")
    expect(/stream stalled/i.test(msg), "the cause is the INTER-CHUNK stall, not the first-token budget").toBe(true)
    expect(/no first token/i.test(msg), "it is NOT the first-token message — a chunk had already arrived").toBe(false)
    expect(events.some((e) => e.kind === "replyDelta"), "the first chunk was emitted before the stall").toBe(true)
  }),
)

it.effect("WALL-CLOCK CAP still backstops a TRICKLE under the first-token budget (cap < firstTokenMs)", () =>
  Effect.gen(function* () {
    // No chunk + a wall cap (5s) SOONER than the first-token budget (300s): the wall guard wins from
    // entry, so even a generous first-token budget can't let a turn trickle forever — the cap fires.
    const aborter = new AbortController()
    const { exit, msg } = yield* driveWatchdog(scriptedStream([]), aborter, 5_000, 60_000, 5_000, 300_000)
    expect(exit._tag, "the wall-clock cap FIRED even before the first token").toBe("Failure")
    expect(/turn exceeded/i.test(msg), "the cause is the WALL cap (cap < first-token budget)").toBe(true)
    expect(aborter.signal.aborted, "the wall cap aborts the turn").toBe(true)
  }),
)

it.effect("WALL-CLOCK CAP: when the outer cap is SOONER than the stall, dead air fails with 'turn exceeded'", () =>
  Effect.gen(function* () {
    // turnMs (5s) < stallMs (60s): from entry the wall cap is the soonest deadline, so a stalled
    // stream trips the WALL guard (not the stall guard) — the message names the right cause.
    const aborter = new AbortController()
    const { exit, msg } = yield* driveWatchdog(scriptedStream([{ reply: "partial" }]), aborter, 5_000, 60_000, 5_000)
    expect(exit._tag, "the wall-clock cap FAILED the drain").toBe("Failure")
    expect(/turn exceeded/i.test(msg), "the failure is the WALL-CAP message (cap < stall)").toBe(true)
    expect(aborter.signal.aborted, "the wall cap also aborts the turn").toBe(true)
  }),
)

it.effect("NO HANG / clean pass: a stream that closes resolves to its real reply, watchdog never trips", () =>
  Effect.gen(function* () {
    const aborter = new AbortController()
    const { exit, events } = yield* driveWatchdog(
      scriptedStream([{ thought: "quick" }, { reply: "All " }, { reply: "good." }], false),
      aborter,
      0,
      60_000,
      600_000,
    )
    expect(exit._tag, "a clean stream SUCCEEDS (no watchdog fire)").toBe("Success")
    expect(exit._tag === "Success" ? exit.value : "", "the accumulated reply is verbatim").toBe("All good.")
    expect(aborter.signal.aborted, "a clean turn never aborts its controller").toBe(false)
    expect(events.filter((e) => e.kind === "replyDelta").length, "both reply deltas were emitted").toBe(2)
  }),
)

it.effect("LONG-TOOL-NO-STALL: a tool running 3 MIN (≫ the 60s inter-chunk stall) does NOT fire — the idle deadline is suspended while a tool executes", () =>
  Effect.gen(function* () {
    // The shape of a real long-session turn: one delta lands (firstStep flips → the tight 60s
    // inter-chunk guard is now active), THEN ax executes a tool INSIDE streamingForward — it.next()
    // blocks the whole time, yielding NO delta. The logger emits a `tool` activity into the gate
    // (depth → 1) when the call starts. With the OLD single-threshold watchdog this 3-min no-delta
    // gap would FALSE-fire at 60s; the tool-aware watchdog suspends the idle deadline while depth>0.
    const aborter = new AbortController()
    const gate = makeToolGate()
    const events: Array<{ kind: string }> = []
    const emit = (a: { kind: string }) => void events.push(a)
    const fiber = yield* Effect.forkChild(
      drainWithWatchdogEffect(scriptedStream([{ reply: "calling tool… " }]), aborter, emit as never, { stallMs: 60_000, turnMs: 600_000, firstTokenMs: 300_000 }, undefined, gate),
    )
    // Let the first delta drain + the watchdog arm (one poll slice of virtual time).
    yield* TestClock.adjust(Duration.millis(1_000))
    // ax calls a tool → the logger feeds the gate. Now the iterator is blocked running the tool.
    gate.observe({ kind: "tool", id: "t1", name: "bash", args: "sleep 180" } as never)
    // THREE MINUTES of no-delta tool execution — 3× the 60s inter-chunk stall. Must NOT fire.
    yield* TestClock.adjust(Duration.millis(180_000))
    expect(fiber.pollUnsafe(), "still draining — the inter-chunk stall is SUSPENDED while the tool runs (no false stall)").toBe(undefined)
    expect(aborter.signal.aborted, "no abort — a running tool is real progress, not dead air").toBe(false)
    yield* Fiber.interrupt(fiber) // clean up the suspended fiber
  }),
)

it.effect("TOOL-THEN-DEAD-AIR: after the tool RESULT lands the idle budget restarts fresh, then genuine dead air fires 60s LATER (not 60s after the tool started)", () =>
  Effect.gen(function* () {
    // A tool runs long, returns, then the stream goes genuinely dead. The stall must fire 60s after
    // the tool FINISHED (the idle budget re-anchors on the result), proving the gate boundary resets
    // the deadline — a tool does not "spend" the next gap's budget, and a real post-tool stall still
    // aborts. toolCount>0 now, so the fire is NON-retryable (a tool may have had side effects).
    const aborter = new AbortController()
    const gate = makeToolGate()
    const events: Array<{ kind: string }> = []
    const emit = (a: { kind: string }) => void events.push(a)
    const fiber = yield* Effect.forkChild(
      drainWithWatchdogEffect(scriptedStream([{ reply: "x" }]), aborter, emit as never, { stallMs: 60_000, turnMs: 600_000, firstTokenMs: 300_000 }, undefined, gate),
    )
    yield* TestClock.adjust(Duration.millis(1_000))
    gate.observe({ kind: "tool", id: "t1", name: "bash", args: "" } as never) // tool starts (depth 1)
    yield* TestClock.adjust(Duration.millis(120_000)) // 2-min tool — no fire (suspended)
    expect(fiber.pollUnsafe(), "no fire during the 2-min tool").toBe(undefined)
    gate.observe({ kind: "result", id: "t1", result: "ok", isError: false } as never) // tool ends (depth 0, budget re-anchors)
    yield* TestClock.adjust(Duration.millis(30_000)) // 30s of post-tool dead air — UNDER the fresh 60s budget
    expect(fiber.pollUnsafe(), "no fire at 30s post-tool — the budget restarted fresh, not from the tool start").toBe(undefined)
    yield* TestClock.adjust(Duration.millis(31_000)) // now > 60s of post-tool dead air → fire
    const exit = yield* Effect.exit(Fiber.join(fiber))
    const e = exit._tag === "Failure" ? (Cause.squash(exit.cause) as StreamStallError) : undefined
    expect(exit._tag, "genuine post-tool dead air FIRES the inter-chunk stall").toBe("Failure")
    expect(/stream stalled/i.test(e?.message ?? ""), "the cause is the inter-chunk stall").toBe(true)
    expect(e?.retryable, "NON-retryable — a tool already ran (possible side effects), so do NOT redo the forward").toBe(false)
  }),
)

it.effect("DEAD-AIR-RECOVERS (retryable gate): a no-tool dead-air stall fails RETRYABLE so the turn can retry the forward", () =>
  Effect.gen(function* () {
    // No tool ran (toolCount 0): a genuine network hang. The stall is typed retryable=true so
    // agent.ts's withRetry redoes the whole forward (safe — no side effect). This pins the GATE the
    // retry decision keys off; the agent-level loop is exercised by the resilience unit + isTransient.
    const aborter = new AbortController()
    const gate = makeToolGate()
    const { exit } = yield* driveWatchdog(scriptedStream([{ reply: "hi " }]), aborter, 61_000, 60_000, 600_000, 300_000, gate)
    const e = exit._tag === "Failure" ? (Cause.squash(exit.cause) as StreamStallError) : undefined
    expect(exit._tag, "the no-tool stall FIRED").toBe("Failure")
    expect(e?.retryable, "RETRYABLE — no tool ran, so re-running the forward redoes no side effect").toBe(true)
  }),
)

it.effect("WALL CAP is NEVER retryable even with no tool: a runaway must terminate, not loop", () =>
  Effect.gen(function* () {
    const aborter = new AbortController()
    const gate = makeToolGate()
    const { exit, msg } = yield* driveWatchdog(scriptedStream([{ reply: "x" }]), aborter, 5_000, 60_000, 5_000, 300_000, gate)
    const e = exit._tag === "Failure" ? (Cause.squash(exit.cause) as StreamStallError) : undefined
    expect(/turn exceeded/i.test(msg), "the wall cap fired").toBe(true)
    expect(e?.retryable, "the wall cap is NEVER retryable (a runaway loop would defeat the cap)").toBe(false)
  }),
)

it.effect("TOOL HANGS FOREVER: a tool that never returns still terminates at the WALL CAP (the hang backstop survives tool-awareness)", () =>
  Effect.gen(function* () {
    // The risk in the tool-aware design: a tool whose RESULT never arrives keeps depth>0 forever,
    // suspending the idle deadline indefinitely. The wall-clock cap MUST still fire — a 24h hung tool
    // is not progress. Here depth stays 1 and the stream hangs; only the wall cap can end it.
    const aborter = new AbortController()
    const gate = makeToolGate()
    const events: Array<{ kind: string }> = []
    const emit = (a: { kind: string }) => void events.push(a)
    const fiber = yield* Effect.forkChild(
      drainWithWatchdogEffect(scriptedStream([{ reply: "go" }]), aborter, emit as never, { stallMs: 60_000, turnMs: 300_000, firstTokenMs: 300_000 }, undefined, gate),
    )
    yield* TestClock.adjust(Duration.millis(1_000))
    gate.observe({ kind: "tool", id: "t1", name: "bash", args: "" } as never) // tool starts, never returns
    yield* TestClock.adjust(Duration.millis(300_000)) // reach the wall cap with depth still 1
    const exit = yield* Effect.exit(Fiber.join(fiber))
    const msg = exit._tag === "Failure" ? String((Cause.squash(exit.cause) as { message?: string })?.message ?? "") : ""
    expect(exit._tag, "a forever-hung tool STILL terminates — at the wall cap (no infinite spinner)").toBe("Failure")
    expect(/turn exceeded/i.test(msg), "the WALL cap (not the idle stall) is what fired").toBe(true)
    expect(aborter.signal.aborted, "the wall cap aborted the turn").toBe(true)
  }),
)

it.effect("FULL TURN over a LAYER-INJECTED mock (no switch-on-prompt global): the reply round-trips through the SDK", () =>
  Effect.gen(function* () {
    // The mock's canned chat: one tool-free step that returns the final reply. No prompt keyword —
    // the test OWNS this reply via the Layer it provides, the clean exit from mock-ai.ts's regex.
    const ai = yield* AxAI
    const agent = createAgent({ ai, model: "@mock/test", tools: [] })
    let reply = ""
    let stopReason = ""
    // Drive the real public runTurn (a Promise async-gen) inside Effect.promise so the it.effect
    // body stays Effect-shaped while exercising the REAL turn loop over the injected service.
    yield* Effect.promise(async () => {
      for await (const ev of agent.runTurn("layer-mock-turn", "hi")) {
        if (ev.type === "reply") {
          reply = ev.result.reply
          stopReason = ev.result.stopReason
        }
      }
    })
    expect(reply, "the layer-injected mock's canned reply round-trips through the public SDK").toBe(LAYER_REPLY)
    expect(stopReason, "a clean turn stops cleanly").toBe("stop")
  }).pipe(
    Effect.provide(
      AxAI.layer((req: Readonly<AxChatRequest<unknown>>): Promise<AxChatResponse> => {
        void req
        return Promise.resolve({ remoteId: "layer", results: [{ index: 0, content: LAYER_REPLY, finishReason: "stop" as const }], modelUsage: usage })
      }),
    ),
  ),
)

const LAYER_REPLY = "Reply from the injected layer."
