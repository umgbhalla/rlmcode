#!/usr/bin/env bun
// FRAME GATE — FOCUS. Mounts the REAL chat.tsx headlessly (terminal-control PTY + AX2_MOCK
// mock AI) and asserts the focus contract AGAINST CAPTURED FRAMES — the exact bug that once
// shipped "green" while the input was stranded. This is the FIRST frame test, so it doubles
// as the AX2_MOCK seam-integration check (blocker #4): if the seam is broken, chat.tsx never
// boots and waitFor times out here.
//
// CONTRACT (captureFocus model, composer.tsx useComposerFocus): the composer textarea is the
// DEFAULT focus owner — with no capture owner active (captureFocus=false today), it RECLAIMS
// focus the instant anything (a row Tab toggle, an orch re-render, a click on a non-focusable
// row) steals it. (A palette would set captureFocus=true and the composer would yield; see
// composer.test.ts shouldReclaim.) Tab is purely VISUAL: it moves the ❯ ring over rows, but keystrokes
// are intercepted at the renderer and still land in the input. After a send, the input is
// reclaimed (empty placeholder back) — never stranded on a row.
//
// We assert focus through STABLE evidence: typed text that is SUBMITTED lands as a `│ <text>`
// transcript row (the live textarea content row itself doesn't paint cleanly into a static
// cell-grid capture — opentui relays it under the status bar — so the durable focus signal is
// "the keystrokes reached the input and submitted", i.e. the transcript row appears).
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("focus.test", async (a) => {
  const d = await launchDriver()
  try {
    // ── on mount → list, then open a chat: the composer is focused (placeholder visible) ─
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n") // new session
    const composer = await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
    a.has(composer, "message kimi", "composer placeholder visible on mount (input focused)")
    a.has(composer, /│/, "composer input border renders")

    // ── typing lands in the input → submit → it becomes a transcript `│ <text>` row ──────
    await d.type("first message")
    await d.key("Enter")
    const sent = await d.waitFor((f) => /first message/.test(f), { label: "user row" })
    a.has(sent, "first message", "typed text reached the focused input and submitted")

    // ── a real (mock) turn runs → reply lands. The composer is RECLAIMED (focus-sticky):
    // we prove reclaim FUNCTIONALLY — the next typed+submitted message lands — because the
    // empty placeholder row doesn't repaint into a static capture once the transcript fills
    // (opentui relays the input row under the status bar; the durable signal is that
    // keystrokes still reach the input, not that the placeholder cell is visible).
    const afterSend = await d.waitFor((f) => /Found 3 matches|Done\./.test(f), { label: "reply", timeoutMs: 40000 })
    a.has(afterSend, "⏺", "agent reply marker rendered")
    a.has(afterSend, "first message", "the prior user message stays in the transcript")

    // ── second message drives an ORCHESTRATE turn → expandable node rows appear, so Tab has
    // something to ring. (The plain bash turn renders only its reply — the mock tool loop
    // runs but ax's mock service doesn't surface the bash step as a focusable transcript row;
    // the orch node rows are the reliable focusables, and they're what the Tab-ring bug was
    // about — the orch tree's focus ring.)
    await d.type("orchestrate the work")
    await d.key("Enter")
    const tree = await d.waitFor((f) => /fan-out|parallel ×3/.test(f), { label: "orch tree", timeoutMs: 40000 })
    a.has(tree, "orchestrate the work", "the orchestrate message submitted (keystrokes reached the input)")

    // ── Tab moves the VISUAL ❯ ring onto a focusable orch node row ───────────────────────
    await d.key("Tab")
    const ring = await d.waitFor((f) => /❯/.test(f), { label: "focus ring" })
    a.has(ring, "❯", "Tab moves the visual ❯ focus ring onto an expandable (orch node) row")

    // ── typing after Tab STILL lands in the input (ring is visual-only; input kept focus) ─
    // The submitted message becomes a new transcript row — proof the keystrokes reached the
    // input even while the visual ring sat on a node row.
    await d.type("after tab")
    await d.key("Enter")
    const afterTab = await d.waitFor((f) => /after tab/.test(f), { label: "post-tab user row" })
    a.has(afterTab, "after tab", "typing after Tab still lands in the input (ring is visual-only)")
    // (We do NOT assert the OLDEST turn is still visible: the transcript is bottom-sticky and
    // CLIPPED to the viewport, so after several turns + the tall orch tree the first message
    // legitimately scrolls off-screen. That's a scroll concern, not the focus contract — the
    // "after tab" row landing is the durable proof keystrokes reached the input.)
  } finally {
    await d.stop()
  }
})
