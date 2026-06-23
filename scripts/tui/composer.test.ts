#!/usr/bin/env bun
// FRAME GATE — COMPOSER. Mounts the REAL chat.tsx headlessly (terminal-control PTY + RLM_MOCK)
// and asserts the composer card (composer.tsx, opencode prompt/index.tsx:1403-1762 ported):
//   - the bordered textarea (left │ border) + its "message kimi" placeholder,
//   - the METADATA row (the model name leaf — "kimi-k2.7-code"),
//   - the STATUS row (right cluster: "<tok> · <cost> · Cmd+K commands"; left: the live hint).
//
// FOCUS CONTRACT (captureFocus model, composer.tsx useComposerFocus / shouldReclaim): the
// composer is the DEFAULT focus owner and RECLAIMS on blur — click a transcript row, still
// typable. UNLESS a capture owner (palette/dialog, captureFocus=true) holds focus, in which
// case the composer YIELDS and does NOT steal. We prove the click-still-typable half against a
// CAPTURED FRAME (a typed+submitted message lands as a transcript row after a row click), and
// the palette-doesn't-steal half against the pure `shouldReclaim` gate (the exact predicate the
// effect is gated on — captureFocus=true ⇒ false ⇒ no reclaim).
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"
import { shouldReclaim, modelLabel } from "../../src/tui/composer.tsx"

await report("composer.test", async (a) => {
  // ── PURE GATE: the captureFocus model (palette-doesn't-steal) ──────────────────────────────
  a.ok(shouldReclaim(true, false), "composer reclaims focus when it is the rightful owner (no capture)")
  a.ok(!shouldReclaim(true, true), "composer does NOT steal focus when a palette captures it (captureFocus)")
  a.ok(!shouldReclaim(false, false), "composer does not reclaim outside the chat view")
  a.ok(modelLabel("@cf/moonshotai/kimi-k2.7-code") === "kimi-k2.7-code", "modelLabel strips the provider prefix")

  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n") // new session

    // ── COMPOSER CARD: bordered textarea + metadata (model) + status (tokens·cost / Cmd+K) ────
    const composer = await d.waitFor((f) => /kimi-k2\.7-code/.test(f), { label: "composer metadata" })
    a.has(composer, /│/, "composer textarea left border renders")
    a.has(composer, "message kimi", "composer placeholder visible (input focused)")
    a.has(composer, "kimi-k2.7-code", "composer METADATA row shows the model name")
    a.has(composer, /tok ·.*\$.* · Cmd\+K commands/, "composer STATUS row shows the token·cost / Cmd+K cluster")
    a.hasNot(composer, /LSP|MCP|Permission/, "composer drops opencode's LSP/MCP/permission dots (rlmcode has neither)")

    // ── send a message → reply lands; then CLICK a transcript row and confirm STILL typable ──
    await d.type("hello composer")
    await d.key("Enter")
    await d.waitFor((f) => /hello composer/.test(f), { label: "user row" })
    await d.waitFor((f) => /Found 3 matches|Done\./.test(f), { label: "reply", timeoutMs: 40000 })

    // click somewhere in the transcript (a non-focusable row) — this steals focus via
    // focusRenderable; the captureFocus model must RECLAIM it so the next keystrokes land.
    await d.click(5, 4)
    await d.type("after click")
    await d.key("Enter")
    const afterClick = await d.waitFor((f) => /after click/.test(f), { label: "post-click user row" })
    a.has(afterClick, "after click", "typing after a row click still lands in the input (composer reclaimed focus)")
    a.has(afterClick, "hello composer", "the prior message stays in the transcript")
    // the composer chrome is STILL intact under the filled transcript (flexShrink:0 reserve)
    a.has(afterClick, "kimi-k2.7-code", "composer metadata row still pinned under a filled transcript")
    a.has(afterClick, /Cmd\+K commands/, "composer status row still pinned under a filled transcript")
  } finally {
    await d.stop()
  }
})
