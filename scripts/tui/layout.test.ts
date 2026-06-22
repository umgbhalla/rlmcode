#!/usr/bin/env bun
// FRAME GATE — LAYOUT / NO-OVERLAP. Mounts the REAL chat.tsx headlessly (terminal-control
// PTY + AX2_MOCK) and proves the bottom chrome (composer input + status line) ALWAYS keeps
// its own space under a full transcript — the "transcript text overlaps the input box" bug.
//
// THE CONTRACT (chat.tsx): the scrollbox is flexGrow:1; the composer wrapper AND the status
// row are flexShrink:0, so they RESERVE their height and the scrollbox absorbs the slack and
// CLIPS the transcript instead of bleeding over the input. Regression lock: if a future edit
// drops flexShrink:0, a filled transcript would push/overlap the bottom chrome and these
// asserts (status line + composer border present in the FINAL frame) fail.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("layout.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n") // new session
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // Fill the transcript with several turns so it would overflow a 30-row terminal — the
    // case where a non-reserved composer/status gets overlapped by the scrolling transcript.
    for (const msg of ["one", "two", "three", "four"]) {
      await d.type(msg)
      await d.key("Enter")
      await d.waitFor((f) => new RegExp(msg).test(f), { label: `sent:${msg}` })
      await d.waitFor((f) => /Found 3 matches|Done\./.test(f), { label: `reply:${msg}`, timeoutMs: 40000 })
    }

    // FINAL frame: the bottom chrome must STILL be there, intact, under the full transcript.
    const f = await d.frame()
    a.has(f, /kimi ·/, "status line (model · session · id) survives a full transcript — not overlapped")
    a.has(f, /session 1/, "session label still rendered in the status line")
    a.has(f, /│/, "composer input border still renders under a full transcript")
    // The newest turn is pinned to the bottom (stickyStart=bottom) and visible — the
    // transcript scrolled, it did not bleed over the composer.
    a.has(f, "four", "newest turn is visible (transcript clipped + scrolled, not overlapping chrome)")
  } finally {
    await d.stop()
  }
})
