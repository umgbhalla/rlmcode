#!/usr/bin/env bun
// UNIT proof for FIX A — the main chat turn's STALL-WATCHDOG. NO network, NO CF creds: it injects a
// mock AxAIService whose streaming chatResponse emits ONE chunk then NEVER closes (no further
// chunk, no done, no error — the half-open-socket / CF-Worker-freeze shape). It drives the REAL
// turn loop through the public SDK (createAgent → runTurn, the exact path the app/TUI uses), so the
// only thing under test is the watchdog added to agent.ts's streamingForward drain.
//
// The DEFECT (STUCK-ANALYSIS.md R1 / FIX A): agent.ts drained chat.streamingForward in a naked
// `for await` inside Effect.tryPromise with NO timeout — only a user abortSignal. If CF stalled
// mid-stream the for-await suspended forever → runForward never resolved → run.ts .finally never
// ran → queue.close() never fired → the drain never ended → the reply promise never settled →
// infinite spinner (only esc). Every OTHER CF path is timeout-wrapped (leaf 120s / wf 300s / RLM
// 600s); only the main turn was bare. The FIX: a per-chunk STALL watchdog (reset on every delta,
// env RLM_STREAM_STALL_MS) + an OUTER per-turn wall-clock cap (env RLM_TURN_TIMEOUT_MS), BOTH
// threading the turn's AbortController so a fire cancels the in-flight CF request (not just rejects
// the JS race) and the loop breaks → the turn RESOLVES with a "⚠ stream stalled" partial.
//
// Set a TINY stall ceiling so the watchdog fires fast, then assert:
//   1) the turn RESOLVES (the runTurn async-gen completes) WITHIN a generous wall-clock bound —
//      the repro no longer repros (no hang). An OUTER guard fails LOUDLY if it ever hangs past it,
//      so a regression (the watchdog removed) is a test FAILURE, not a stuck CI job.
//   2) the terminal reply is the stall PARTIAL ("⚠ … stream stalled …"), stopReason 'error',
//      NOT the "Interrupted." user-abort text (the watchdog fire must read as a stall, not a cancel).
//   3) a NORMAL streaming turn (a stream that DOES close) still resolves with its real reply,
//      UNCHANGED — the fix is additive, good turns are byte-identical.
// Runs in `bun run test` (the lint gate); no RLM_LIVE flag needed.

// TINY stall ceiling (read at agent.ts module load) so the watchdog fires fast. Leave the wall-clock
// cap at its default — this unit exercises the per-chunk stall guard (the common hang); the wall cap
// is the same mechanism with a longer fuse. Set BEFORE importing agent.ts (via sdk.ts) — and the SDK
// is loaded with a DYNAMIC import() AFTER this assignment, because a static `import` is hoisted and
// would evaluate agent.ts's module-load constant read BEFORE this line ran (it would then see the
// 60s default → a 3s guard would trip → a false "hang"). Same pattern as workflow-timeout.test.ts.
process.env.RLM_STREAM_STALL_MS = "300"

import { AxMockAIService, type AxChatRequest, type AxChatResponse } from "@ax-llm/ax"
import type { TurnEvent } from "../src/core/sdk.ts"
const { createAgent } = await import("../src/core/sdk.ts")

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

const usage = { ai: "mock", model: "@mock/stall", tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }

// A streaming response that enqueues ONE chunk (a reasoning delta) then NEVER closes: no second
// chunk, no controller.close(), no error. This is the exact mid-stream stall the watchdog must
// catch — before the fix the drain's `it.next()` suspends here forever.
const oneChunkThenHang = (): ReadableStream<AxChatResponse> =>
  new ReadableStream<AxChatResponse>({
    start(c) {
      c.enqueue({ remoteId: "stall", results: [{ index: 0, content: "", thought: "thinking…" }], modelUsage: usage })
      // deliberately NO c.close() and NO further enqueue — the half-open stall.
    },
  })

// A NORMAL streaming response that DOES close — the control: a good turn must still resolve with its
// real reply, unchanged by the watchdog (the stall ceiling never trips on a stream that completes).
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
    // streaming:true so chat.streamingForward consumes the ReadableStream; functions:[] (no tools)
    // so the FIRST step IS the streaming final reply — the drain under test, no tool-loop detour.
    features: { functions: false, streaming: true },
    chatResponse: (_req: Readonly<AxChatRequest<unknown>>) => Promise.resolve(stream()),
  })

// Drive the REAL turn to its TERMINAL reply via the public SDK (createAgent → runTurn). Returns the
// single {type:'reply'} result. An OUTER guard rejects LOUDLY if the async-gen ever hangs past the
// bound — so a watchdog regression is a FAILURE, not a stuck job. ceiling 300ms ⇒ a 3s bound is
// comfortably above scheduling jitter yet a tiny fraction of the pre-fix INFINITE hang.
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

// 1) + 2) STALL — one chunk then never closes → the watchdog fires, the turn resolves with the
// "⚠ stream stalled" partial WITHIN the bound (not a hang, not "Interrupted.").
console.log("(1) STALL stream — one chunk then never closes → watchdog fires, turn resolves (no hang)")
const t0 = Date.now()
let stalled: (TurnEvent & { type: "reply" }) | undefined
try {
  stalled = await driveToReply(makeStreamAI(oneChunkThenHang), "stall-unit-hang")
} catch (e) {
  failures += 1
  console.error(`  ✗ ${String((e as Error).message)}`)
}
const elapsed = Date.now() - t0
console.log(`    elapsed ${elapsed}ms — reply: ${JSON.stringify(stalled?.result.reply)}`)
assert(stalled !== undefined, "(1) the turn RESOLVED to a terminal reply (the watchdog fired — no infinite hang)")
assert(elapsed < guardMs, `(1) resolved within the wall-clock bound (${elapsed}ms < ${guardMs}ms), not a hang`)
assert(/stream stalled/i.test(stalled?.result.reply ?? ""), "(2) the partial reply is the STALL message (⚠ … stream stalled …)")
assert(stalled?.result.reply.startsWith("⚠"), "(2) the partial reply is a ⚠ warning")
assert(stalled?.result.stopReason === "error", "(2) stopReason is 'error' (a stall is a provider fault, not a clean stop)")
assert(stalled?.result.aborted === false, "(2) NOT marked aborted (a stall is not a user interrupt → not the 'Interrupted.' path)")

// 3) NORMAL — a stream that closes still resolves with its real reply, UNCHANGED.
console.log("(3) NORMAL stream — closes cleanly → real reply, watchdog never trips")
let ok: (TurnEvent & { type: "reply" }) | undefined
try {
  ok = await driveToReply(makeStreamAI(streamThenClose), "stall-unit-ok")
} catch (e) {
  failures += 1
  console.error(`  ✗ ${String((e as Error).message)}`)
}
console.log(`    reply: ${JSON.stringify(ok?.result.reply)}`)
assert(ok?.result.reply === GOOD_REPLY, "(3) a normal streaming turn returns its real reply verbatim (fix is additive)")
assert(ok?.result.stopReason === "stop", "(3) a normal turn stops cleanly (stopReason 'stop')")
assert(!/stalled/i.test(ok?.result.reply ?? ""), "(3) a normal turn is NOT stalled")

if (failures > 0) {
  console.error(`\nturn-stall.test: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log("\nturn-stall.test: all pass ✓")
// The case-1 half-open stream is intentionally never closed; its pending read + the runtime's otel
// handles keep the event loop alive, so a fall-off-the-end never exits and stalls the `&&` chain.
// Mirror the failure path's process.exit — exit cleanly on success once assertions have printed.
process.exit(0)
