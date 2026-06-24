// MIN-INTERVAL RATE-LIMITER, proven DETERMINISTICALLY with TestClock (adoption #4/#12).
// makeRateLimiter (runtime.ts) computes each caller's start slot over the Effect Clock
// (Clock.currentTimeMillis) and waits via Effect.sleep — so the THROTTLE INTERVAL is assertable in
// virtual time with ZERO real wall-clock (the old hand-rolled limiter used Date.now() + setTimeout,
// untestable without holding real time). reserveSlot returns the wait ms WITHOUT sleeping, so a
// test reads the schedule directly. Pins: (1) THROTTLE INTERVAL — back-to-back starts stagger by
// exactly 1/RPS; (2) BACKLOG CAP — a burst's worst-case wait is bounded by maxBacklog intervals (no
// unbounded starvation of a later caller behind a flood); (3) STEADY STATE — once the clock catches
// up (real time passes), a call waits 0 again.
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Duration from "effect/Duration"
import { TestClock } from "effect/testing"
import { makeRateLimiter } from "../src/core/runtime.ts"

it.effect("THROTTLE INTERVAL: back-to-back starts stagger by exactly 1/RPS (no real wall-clock)", () =>
  Effect.gen(function* () {
    // 4 RPS ⇒ interval 250ms, maxBacklog 8 ⇒ cap 2000ms. All claimed at virtual t=0.
    const { reserveSlot } = makeRateLimiter(4, 8)
    const waits: Array<number> = []
    for (let i = 0; i < 4; i++) waits.push(yield* reserveSlot)
    expect(waits, "the 1st call starts now (0); each later call is staggered one 250ms interval").toEqual([0, 250, 500, 750])
  }),
)

it.effect("BACKLOG CAP: a burst's worst-case wait is bounded by maxBacklog intervals", () =>
  Effect.gen(function* () {
    // 4 RPS (interval 250ms), maxBacklog 3 ⇒ cap 750ms. A flood of 6 immediate calls: the clock can
    // lead `now` by at most cap, so NO single caller waits more than 750ms — the worst-case wait is
    // bounded, killing the unbounded-starvation the cap exists to prevent.
    const { reserveSlot } = makeRateLimiter(4, 3)
    const waits: Array<number> = []
    for (let i = 0; i < 6; i++) waits.push(yield* reserveSlot)
    expect(Math.max(...waits) <= 750, `no call waits past the cap (max ${Math.max(...waits)}ms <= 750ms)`).toBe(true)
    expect(waits[0], "the first call still starts immediately").toBe(0)
  }),
)

it.effect("STEADY STATE: after virtual time advances past the reservation, the next call waits 0 again", () =>
  Effect.gen(function* () {
    const { reserveSlot } = makeRateLimiter(4, 8) // interval 250ms
    const first = yield* reserveSlot // t=0 → 0, reserves next at 250
    expect(first, "first call immediate").toBe(0)
    // Advance virtual time past the reserved slot — the clock catches up, so the backlog drains.
    yield* TestClock.adjust(Duration.millis(1000))
    const next = yield* reserveSlot
    expect(next, "once now >= nextAllowed, a call starts immediately again (steady state)").toBe(0)
  }),
)

it.effect("the AxRateLimiterFunction calls THROUGH to reqFunc and returns its result (the 0-wait fast path)", () =>
  // The production-shaped path: limiter(reqFunc) reserves a slot then runs reqFunc. The first call
  // waits 0, so it resolves immediately — proving the limiter is a transparent pass-through when not
  // throttled. (The DELAY itself is proven deterministically by the reserveSlot schedule above; the
  // limiter's sleep runs on its own runPromise runtime, outside this TestClock by design.)
  Effect.gen(function* () {
    const { limiter } = makeRateLimiter(4, 8)
    const r = yield* Effect.promise(() => limiter(() => Promise.resolve("through")))
    expect(r, "the limiter calls through to reqFunc and returns its result").toBe("through")
  }),
)
