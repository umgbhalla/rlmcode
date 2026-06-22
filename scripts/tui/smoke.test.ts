#!/usr/bin/env bun
// FRAME GATE — SMOKE. The minimal proof the harness works end to end: mount the REAL chat.tsx
// headlessly (terminal-control PTY + AX2_MOCK mock AI, zero Cloudflare/network), capture the
// INITIAL rendered frame via the reusable driver, and assert the session-list prompt is
// present in that frame. This is the cheapest "does it render + can we assert a real frame"
// check — if the AX2_MOCK seam or the headless mount breaks, waitForFrame here times out.
//
// Uses the SPEC frame-stable wait (driver.waitForFrame(predicate, deadlineMs)) — NEVER a
// setTimeout-then-assert — so it is deterministic and flake-free.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("smoke.test", async (a) => {
  const d = await launchDriver()
  try {
    // Mount → capture the first frame for which the session-list prompt is present.
    const frame = await d.waitForFrame((f) => /press n to start/.test(f), 15000)
    a.has(frame, "SESSIONS", "status line renders on mount")
    a.has(frame, "no sessions. press n to start.", "the input/prompt is present in the initial frame")
    // Echo the captured frame so the gate's stdout doubles as the frameProof.
    console.log("  ── captured initial frame ──")
    console.log(
      frame
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )
  } finally {
    await d.stop()
  }
})
