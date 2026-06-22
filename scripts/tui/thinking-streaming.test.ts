#!/usr/bin/env bun
// FRAME GATE — THINKING + STREAMING. Pins the app's CURRENT (honest, non-streaming) render
// of a reasoning model's reply, and leaves a clear TODO that will pass once stream:true lands.
//
// WHERE WE ARE: the mock AI (mock-ai.ts) sets features.streaming:false and returns a SINGLE
// final string with a canned `thought` (reasoning_content) + reasoningTokens — exactly the
// shape the real CF-Kimi turn uses today (agent.ts forwards non-streaming). The app does NOT
// stream reasoning_content token-by-token into the transcript: a turn shows a transient
// "thinking…" busy state, then the WHOLE reply lands at once as one agent row, and the
// reasoning is attributed via the token meta (reasoningTokens folded into the turn's tokens).
// So we assert THAT — the complete reply renders in one frame, no faked deltas.
//
// We do NOT assert the transient "thinking…" placeholder: with the instant mock the busy
// window is a single tick, so catching it would be a race (the de-flake lesson — no
// frame-timing gambles). The DURABLE, deterministic signal is the settled reply + its meta.
//
// TODO (stream:true): when mock-ai.ts sets streaming:true and yields reasoning_content +
// content as DELTAS (and agent.ts wires stream:true in the turn config), add a test here that
// captures the frame MID-STREAM and asserts the partial reply text grows frame-by-frame and a
// distinct "thinking…" reasoning panel renders the streamed reasoning_content. Until both land
// this stays a non-streaming assertion — pinning the contract WITHOUT faking streaming output.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("thinking-streaming.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    await d.type("how many matches in src?")
    await d.key("Enter")

    // CURRENT BEHAVIOR: the complete, non-streamed reply lands in one frame as a marked
    // agent row (the ⏺ box), with the WHOLE canned reply text present at once — not a partial
    // chunk. This is the "no thinking/streaming state" baseline the blocker called for.
    const reply = await d.waitFor((f) => /Found 3 matches in src\/\. Done\./.test(f), { label: "settled reply", timeoutMs: 40000 })
    a.has(reply, "⏺", "the reply renders as a marked agent row (the reply box)")
    a.has(reply, "Found 3 matches in src/. Done.", "the FULL non-streamed reply text is present in one frame")

    // The turn meta line carries the token total (the canned reasoning_content is attributed
    // via reasoningTokens folded into this total — 280 = the canned per-step sum × 2 steps).
    a.has(reply, /280 tok/, "turn meta shows the token total (reasoning attributed into tokens)")

    // NOT-YET: with streaming:false there is no per-chunk reasoning panel in the transcript.
    // Asserting its ABSENCE pins that we're honestly non-streaming (the TODO above flips this).
    a.hasNot(reply, "reasoning_content", "no raw reasoning_content panel today (streaming not wired)")
  } finally {
    await d.stop()
  }
})
