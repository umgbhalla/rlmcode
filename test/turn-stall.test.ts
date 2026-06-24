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
import { drainWithWatchdogEffect } from "../src/core/stream-watchdog.ts"
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
const driveWatchdog = (stream: AsyncIterable<unknown>, aborter: AbortController, adjustMs: number, stallMs: number, turnMs: number) =>
  Effect.gen(function* () {
    const events: Array<{ kind: string; text?: string }> = []
    const emit = (a: { kind: string; text?: string }) => void events.push(a)
    const fiber = yield* Effect.forkChild(drainWithWatchdogEffect(stream, aborter, emit as never, { stallMs, turnMs }))
    yield* TestClock.adjust(Duration.millis(adjustMs))
    const exit = yield* Effect.exit(Fiber.join(fiber))
    // The drain FAILS with a plain Error on a watchdog fire; squash flattens the Cause to it so the
    // typed "stream stalled" / "turn exceeded" message is assertable. Empty string on success.
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
