#!/usr/bin/env bun
// FRAME GATE — QUEUED MESSAGE (the pending-prompt state).
//
// A message typed + submitted WHILE a turn is in flight must NOT fire a second concurrent turn
// (or be silently dropped): opencode QUEUES it, renders it pending below the live transcript, and
// AUTO-SENDS it once the turn settles. rlmcode does the same with UI-local state (chat.tsx
// `queued` + the busy→idle flush effect) so the Msg/session shapes stay UNCHANGED; the pending
// render is messages.tsx <QueuedCard> — a dim "↑ queued" left-border card.
//
// DRIVE (deterministic, frame-stable): RLM_MOCK_STREAM=1 + RLM_MOCK_DELAY_MS paces the FINAL
// reply step so the FIRST turn stays busy long enough to type + submit a SECOND message. We gate
// on the busy "thinking…" status (the turn is genuinely in flight) BEFORE the second submit, so
// the queue path is hit (busy=true → setQueued). Then:
//   (1) QUEUED — while the first turn is still busy, the dim "↑ queued <text>" card renders below
//       the transcript (the second message is HELD, not sent as a concurrent turn).
//   (2) FLUSH  — once the first turn settles (busy→idle) the queued prompt auto-sends: the
//       "↑ queued" marker is gone and the second message is now a committed user turn whose own
//       reply lands. So a single later frame shows the queued message PROMOTED + answered.
// Waits are frame-stable (waitFor over captured text), never setTimeout-then-assert.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("queued.test", async (a) => {
  // Pace the streamed reply so the first turn holds "busy" past the second submit + a captured
  // frame (the queued card must be visible WHILE busy). The delay only slows the mock's streamed
  // final reply; the settled assertions below still gate on content, not timing.
  const d = await launchDriver({ rows: 40, env: { RLM_MOCK_STREAM: "1", RLM_MOCK_DELAY_MS: "2500" } })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── first turn: submit, then WAIT until it is genuinely in flight (busy "thinking…") ──
    await d.type("first question")
    await d.key("Enter")
    await d.waitFor((f) => /thinking…/.test(f) && /first question/.test(f), { label: "first turn busy", timeoutMs: 15000 })

    // ── second message WHILE busy → it must QUEUE (held pending), not start a concurrent turn ──
    await d.type("second question while busy")
    await d.key("Enter")
    const queued = await d.waitFor(
      (f) => /↑ queued/.test(f) && /second question while busy/.test(f),
      { label: "queued pending card", timeoutMs: 8000 },
    )

    // (1) QUEUED — the dim "↑ queued" card carries the second message; the first turn is still busy.
    a.has(queued, /↑ queued\s+second question while busy/, "a message submitted while busy renders as a dim '↑ queued' pending card")
    a.has(queued, /thinking…/, "the first turn is still in flight while the second message is queued (no concurrent turn)")

    // (2) FLUSH — once the first turn settles, the queued prompt auto-sends: the "↑ queued" marker
    // is gone and the second message is now a committed user turn that gets its own reply. Gate on
    // a frame where the second turn's reply (the mock's "Found 3 matches") is present AND the
    // pending marker is cleared — proof the flush promoted the queued message into a real turn.
    const flushed = await d.waitFor(
      (f) => !/↑ queued/.test(f) && /second question while busy/.test(f) && /Found 3 matches/.test(f),
      { label: "queued message flushed into a real turn", timeoutMs: 40000 },
    )
    a.hasNot(flushed, /↑ queued/, "the '↑ queued' marker is gone once the queued prompt is auto-sent")
    a.has(flushed, /second question while busy/, "the previously-queued message is now a committed user turn")
    a.has(flushed, /Found 3 matches/, "the flushed turn produced its own reply (it ran as a real turn)")
  } finally {
    await d.stop()
  }
})
