// @effect/vitest port of scripts/turn-stall.test.ts — FIX A: the main chat turn's STALL-WATCHDOG.
// NO network: a mock AxAIService whose streaming chatResponse emits ONE chunk then NEVER closes
// (the half-open-socket shape). Drives the REAL turn loop through the public SDK (createAgent →
// runTurn), so the only thing under test is the watchdog in agent.ts's streamingForward drain.
// Asserts: (1) the turn RESOLVES within a wall-clock bound; (2) the terminal reply is the stall
// PARTIAL (stopReason 'error', not aborted); (3) a NORMAL stream still resolves with its real reply.
//
// REAL timers → it.live. The TINY stall ceiling is set BEFORE the dynamic SDK import (read at
// agent.ts module load; a static import hoists above the assignment → would freeze the default).
import { AxMockAIService, type AxChatRequest, type AxChatResponse } from "@ax-llm/ax"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

process.env.RLM_STREAM_STALL_MS = "300"

import type { TurnEvent } from "../src/core/sdk.ts"
const { createAgent } = await import("../src/core/sdk.ts")

const usage = { ai: "mock", model: "@mock/stall", tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }

const oneChunkThenHang = (): ReadableStream<AxChatResponse> =>
  new ReadableStream<AxChatResponse>({
    start(c) {
      c.enqueue({ remoteId: "stall", results: [{ index: 0, content: "", thought: "thinking…" }], modelUsage: usage })
      // deliberately NO c.close() and NO further enqueue — the half-open stall.
    },
  })

const GOOD_REPLY = "All good."
const streamThenClose = (): ReadableStream<AxChatResponse> =>
  new ReadableStream<AxChatResponse>({
    start(c) {
      c.enqueue({ remoteId: "ok", results: [{ index: 0, content: "", thought: "quick think" }], modelUsage: usage })
      c.enqueue({ remoteId: "ok", results: [{ index: 0, content: GOOD_REPLY, finishReason: "stop" as const }], modelUsage: usage })
      c.close()
    },
  })

const makeStreamAI = (stream: () => ReadableStream<AxChatResponse>): AxMockAIService<string> =>
  new AxMockAIService<string>({
    name: "mock",
    id: "stall-unit",
    modelInfo: { name: "@mock/stall", provider: "mock" },
    features: { functions: false, streaming: true },
    chatResponse: (_req: Readonly<AxChatRequest<unknown>>) => Promise.resolve(stream()),
  })

const guardMs = 3_000
const driveToReply = async (ai: AxMockAIService<string>, sessionId: string): Promise<TurnEvent & { type: "reply" }> => {
  const agent = createAgent({ ai, model: "@mock/stall", tools: [] })
  const run = (async () => {
    let reply: (TurnEvent & { type: "reply" }) | undefined
    for await (const ev of agent.runTurn(sessionId, "hi")) if (ev.type === "reply") reply = ev
    if (reply === undefined) throw new Error("runTurn ended with NO terminal reply (final-reply-once violated)")
    return reply
  })()
  return Promise.race([
    run,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`runTurn did not resolve within ${guardMs}ms — IT HUNG (stall-watchdog regressed)`)), guardMs),
    ),
  ])
}

it.live("STALL stream: one chunk then never closes → watchdog fires, turn resolves with the stall partial", () =>
  Effect.promise(async () => {
    const t0 = Date.now()
    const stalled = await driveToReply(makeStreamAI(oneChunkThenHang), "stall-unit-hang")
    const elapsed = Date.now() - t0
    expect(stalled, "the turn RESOLVED to a terminal reply (the watchdog fired — no infinite hang)").toBeDefined()
    expect(elapsed, `resolved within the wall-clock bound (${elapsed}ms < ${guardMs}ms)`).toBeLessThan(guardMs)
    expect(/stream stalled/i.test(stalled.result.reply ?? ""), "the partial reply is the STALL message").toBe(true)
    expect(stalled.result.reply.startsWith("⚠"), "the partial reply is a ⚠ warning").toBe(true)
    expect(stalled.result.stopReason, "stopReason is 'error' (a stall is a provider fault)").toBe("error")
    expect(stalled.result.aborted, "NOT marked aborted (a stall is not a user interrupt)").toBe(false)
  }),
)

it.live("NORMAL stream: closes cleanly → real reply, watchdog never trips", () =>
  Effect.promise(async () => {
    const ok = await driveToReply(makeStreamAI(streamThenClose), "stall-unit-ok")
    expect(ok.result.reply, "a normal streaming turn returns its real reply verbatim").toBe(GOOD_REPLY)
    expect(ok.result.stopReason, "a normal turn stops cleanly (stopReason 'stop')").toBe("stop")
    expect(/stalled/i.test(ok.result.reply ?? ""), "a normal turn is NOT stalled").toBe(false)
  }),
)
