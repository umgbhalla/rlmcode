#!/usr/bin/env bun
// FRAME GATE — MESSAGE CARDS. Mounts the REAL chat.tsx headlessly (terminal-control PTY +
// AX2_MOCK) and proves the transcript renders the opencode-ported message cards (messages.tsx,
// Solid→React): a USER CARD (left-border accent card), an ASSISTANT REPLY with the
// "▣ model · duration" footer line, and a RED ERROR CARD for a failed turn.
//
// THE CONTRACT (messages.tsx):
//   - <UserCard>: border=["left"] + paddingLeft=2 → the prompt sits in a bordered card (the │
//     left-border glyph + the prompt text both present).
//   - <AssistantReply>: the reply (⏺ marker) + a "▣ <model> · <duration>" footer. The model is
//     the per-turn meta.model (@mock/kimi under the mock); the duration is the turn wall-clock.
//   - <ErrorCard>: a "⚠ …" reply (the mock's `fail` turn rejects → run.ts maps it to ⚠) renders
//     as a red-border card — the ⚠ text present under its own card.
//
// DETERMINISM: the mock reply + footer are canned; the error path is the REAL catchCause (a
// mock `fail` turn throws → run.ts errorResult → "⚠ …"). Waits are frame-stable (waitFor over
// captured text), never setTimeout-then-assert.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("messages.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n") // new session
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── USER CARD + ASSISTANT REPLY + FOOTER ────────────────────────────────────────────
    await d.type("count matches in src")
    await d.key("Enter")
    await d.waitFor((f) => /count matches in src/.test(f), { label: "user message in transcript" })
    // The settled reply carries the "▣ model · duration" footer line (assistantFooter). The
    // model is the per-turn meta.model (atoms MODEL const); duration is the turn wall-clock.
    // Gate on BOTH the settled markdown body AND the footer so a transitional frame (footer up
    // before the markdown reflow settles, or vice-versa) never wins the capture.
    const reply = await d.waitFor((f) => /▣ @cf\/moonshotai\/kimi/.test(f) && /Found 3 matches in src\/\. Done\./.test(f), { label: "assistant footer + body", timeoutMs: 40000 })

    a.has(reply, "count matches in src", "user card shows the prompt text")
    a.has(reply, /│/, "user card renders its left-border (the │ border glyph)")
    a.has(reply, "⏺", "assistant reply renders its marked agent row")
    a.has(reply, "Found 3 matches in src/. Done.", "assistant reply renders the settled markdown body")
    a.has(reply, /▣ @cf\/moonshotai\/kimi-k2\.7-code · 0\.0s/, "assistant card shows the '▣ model · duration' footer line")
    a.has(reply, /· 280 tok/, "assistant footer carries the turn token total after model · duration")

    // ── ERROR CARD ──────────────────────────────────────────────────────────────────────
    // A `fail` turn rejects in the mock → the REAL catchCause (run.ts) maps it to a "⚠ …" reply,
    // which routes to <ErrorCard> (red left-border card) instead of the success-green reply.
    await d.type("please fail this turn")
    await d.key("Enter")
    const errFrame = await d.waitFor((f) => /⚠/.test(f), { label: "error card", timeoutMs: 40000 })
    a.has(errFrame, "⚠", "a failed turn renders the ⚠ error card text")
    a.has(errFrame, "please fail this turn", "the failed turn's own user card is still present above the error card")
  } finally {
    await d.stop()
  }
})
