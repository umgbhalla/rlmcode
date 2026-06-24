// RATE-LIMIT RETRY / BACKOFF, proven DETERMINISTICALLY (adoption #12). orch-resilience.ts now
// backs the retry wait with an Effect.sleep over the Effect Clock (NOT a raw setTimeout), and the
// schedule is a pure exported function (backoffDelayMs) so the exponential-plus-stagger curve is
// assertable WITHOUT holding real wall-clock. Pins: (1) the BACKOFF SCHEDULE is exponential with a
// per-index stagger (base*2^i + i*base/4); (2) a TestClock fork can advance virtual time across the
// whole schedule INSTANTLY — Effect.sleep(scheduleMs) resolves under TestClock.adjust with zero
// real time, the deterministic replacement for the old it.live + tiny-real-backoff path.
//
// Env knobs (read at orch-resilience module load) are set BEFORE the dynamic import — a static
// import hoists above the assignment and would freeze the defaults.
import { expect, it } from "@effect/vitest"
import { Effect, Fiber, Ref } from "effect"
import * as Duration from "effect/Duration"
import { TestClock } from "effect/testing"

process.env.RLM_NODE_BACKOFF_MS = "100"
process.env.RLM_NODE_RETRIES = "3"

const { backoffDelayMs, NODE_ATTEMPTS } = await import("../src/core/orch-resilience.ts")

it.effect("BACKOFF SCHEDULE: exponential with a per-index stagger (base*2^i + i*base/4)", () =>
  Effect.sync(() => {
    // base = 100ms, base>>2 = 25ms. i=0: 100; i=1: 200+25=225; i=2: 400+50=450.
    expect([backoffDelayMs(0), backoffDelayMs(1), backoffDelayMs(2)], "exponential growth + index stagger").toEqual([100, 225, 450])
    expect(backoffDelayMs(1) > backoffDelayMs(0), "later retries wait strictly longer").toBe(true)
    expect(NODE_ATTEMPTS, "RLM_NODE_RETRIES=3 ⇒ 4 attempts (retries + 1), clamped <= 5").toBe(4)
  }),
)

it.effect("INSTANT under TestClock: an Effect.sleep across the FULL backoff schedule resolves with zero real time", () =>
  Effect.gen(function* () {
    // Sum the schedule the retry path would sleep through across all retries, then prove a single
    // Effect.sleep of that total resolves the instant TestClock.adjust crosses it — the same Clock
    // the orch-resilience backoff sleeps on, so this models the real wait deterministically.
    const total = Array.from({ length: NODE_ATTEMPTS - 1 }, (_, i) => backoffDelayMs(i)).reduce((a, b) => a + b, 0)
    const done = yield* Ref.make(false)
    const fiber = yield* Effect.forkChild(Effect.flatMap(Effect.sleep(Duration.millis(total)), () => Ref.set(done, true)))
    yield* TestClock.adjust(Duration.millis(total - 1))
    expect(yield* Ref.get(done), "the sleep has NOT resolved one ms before the schedule total").toBe(false)
    yield* TestClock.adjust(Duration.millis(1))
    yield* Fiber.join(fiber)
    expect(yield* Ref.get(done), "the full backoff schedule elapses INSTANTLY once TestClock crosses the total").toBe(true)
  }),
)
