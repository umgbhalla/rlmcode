// TYPED-ERROR SERIALIZER (adoption #1/#6/#8) — proves the turn error path end-to-end through the
// PUBLIC SDK seam after the Data.TaggedError migration: turn() fails with the tagged `ChatError`,
// run.ts recovers it by Effect.catchTag (NOT Cause.squash duck-typing) and serializes `e.cause`
// into the UNCHANGED, serializable public TurnError. Each case drives the REAL public runTurn over
// a Layer-injected mock whose chatResponse REJECTS, then asserts the terminal {type:'reply'} event:
//   (1) our typed BudgetExhaustedError (classified by its `_tag`) → kind:"budget_exhausted";
//   (2) an ax-style 429 status error (untyped wire error, duck-typed by shape) → a CLEAR rate-limit
//       line, kind:"provider";
//   (3) an abort-shaped error → kind:"aborted", reply "⚠ Interrupted.";
//   (4) a generic provider fault → kind:"provider", the first clean error line.
// The public TurnError shape (kind + one-line message) is byte-for-byte the prior contract — the
// serializer is the ONLY map-to-serializable point and no Effect/Data type crosses the SDK barrel.
import type { AxChatRequest } from "@ax-llm/ax"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { createAgent, type TurnError } from "../src/core/sdk.ts"
import { BudgetExhaustedError } from "../src/core/orch.ts"
import { AxAI } from "./ax-layer.ts"

// Drive ONE public turn over a mock chatResponse that throws `err`, and return the terminal reply +
// its TurnError. Effect.promise keeps the it.effect body Effect-shaped while exercising the REAL
// turn loop (streamingForward → ChatError → catchTag → serializeError) over the injected service.
const turnError = (err: unknown) =>
  Effect.gen(function* () {
    const ai = yield* AxAI
    const agent = createAgent({ ai, model: "@mock/test", tools: [] })
    let reply = ""
    let error: TurnError | undefined
    let stopReason = ""
    yield* Effect.promise(async () => {
      for await (const ev of agent.runTurn(`turn-error-${Math.random()}`, "hi")) {
        if (ev.type === "reply") {
          reply = ev.result.reply
          error = ev.result.error
          stopReason = ev.result.stopReason
        }
      }
    })
    return { reply, error, stopReason }
  }).pipe(Effect.provide(AxAI.layer(() => Promise.reject(err) as Promise<never>)))

it.effect("typed BudgetExhaustedError → kind:budget_exhausted (classified by _tag, not string-match)", () =>
  Effect.gen(function* () {
    const { error, stopReason } = yield* turnError(new BudgetExhaustedError("runaway", 100, 50))
    expect(error?.kind, "the tagged budget error serializes to budget_exhausted").toBe("budget_exhausted")
    expect(stopReason, "a budget breach is an error stop").toBe("error")
  }),
)

it.effect("ax 429 status error → a CLEAR rate-limit line, kind:provider", () =>
  Effect.gen(function* () {
    const { reply, error } = yield* turnError(Object.assign(new Error("HTTP 429 Too Many Requests"), { status: 429 }))
    expect(error?.kind, "a 429 is a provider fault").toBe("provider")
    expect(/rate limited \(429\)/i.test(error?.message ?? ""), "the message names the 429 throttle clearly").toBe(true)
    expect(reply.startsWith("⚠"), "the reply carries the warning glyph").toBe(true)
  }),
)

it.effect("abort-shaped error → kind:aborted, reply '⚠ Interrupted.'", () =>
  Effect.gen(function* () {
    const { reply, error, stopReason } = yield* turnError(new Error("the operation was aborted"))
    expect(error?.kind, "an abort serializes to aborted").toBe("aborted")
    expect(reply, "an abort reads as Interrupted.").toBe("⚠ Interrupted.")
    expect(stopReason, "an abort stop reason").toBe("aborted")
  }),
)

it.effect("generic provider fault → kind:provider, first clean error line", () =>
  Effect.gen(function* () {
    const { reply, error } = yield* turnError(new Error("upstream exploded\nstack trace line 2"))
    expect(error?.kind, "an unclassified fault is a provider error").toBe("provider")
    expect(error?.message, "only the FIRST clean line surfaces (never a multi-line dump)").toBe("upstream exploded")
    expect(reply, "the reply is the warning-prefixed first line").toBe("⚠ upstream exploded")
  }),
)
