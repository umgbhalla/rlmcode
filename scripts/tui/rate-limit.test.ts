#!/usr/bin/env bun
// FRAME GATE — RATE-LIMIT RETRY VISIBILITY (rate-limit-visible).
//
// A transient 429 retry USED to be silent: the node sat "running…" while withRetry backed off,
// indistinguishable from the crawl/hang; only on EXHAUSTION did "✗ rate_limited 429" render. Now a
// retry is a first-class signal — the node carries a live "⏳ rate-limited · retry 2/3 · 4s" status
// WHILE backing off, surfaced BOTH in the tree row AND the composer status; on recover it clears
// and the node finishes ✓. This gate proves the live app paints the retry DURING the backoff, then
// the recovery — the "a 429 is invisible until it exhausts" bug as a real captured-frame assertion.
//
// DRIVE (deterministic, frame-stable): the mock_ratelimit tool (mock.ts, reached by a "rate limit"
// prompt) replays a 429-then-recover node and HOLDS the retry state for RLM_MOCK_DELAY_MS, so the
// frame gate can capture the live "⏳ rate-limited" status BEFORE the node recovers. The retry
// detail uses the SAME retryStatus() formatter as production, so the asserted wording is the real
// wording. Waits are frame-stable (waitFor over captured text), never setTimeout-then-assert.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("rate-limit.test", async (a) => {
  // Hold the retry state long enough to type-free CAPTURE the live "⏳ rate-limited" frame before
  // the node recovers. The delay only paces the mock's retry→done hold; the settled assertions
  // below still gate on content, not timing.
  const d = await launchDriver({ rows: 40, env: { RLM_MOCK_DELAY_MS: "3000" } })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // "rate limit" routes the mock to mock_ratelimit → a node that 429-retries (visible) then ✓.
    await d.type("what about a rate limit")
    await d.key("Enter")

    // (1) DURING — while the node backs off, the tree row shows the live "⏳ rate-limited · retry
    //     2/3 · 4s" status (not a silent "running…"). This is the captured-frame proof a 429 is
    //     visible WHILE retrying. Gate on the full status so the capture is stable (it paints in
    //     pieces). The 4s comes from the fixed fixture backoff; 2/3 is attempt-of-NODE_ATTEMPTS.
    const during = await d.waitFor(
      (f) => /⏳/.test(f) && /rate-limited/.test(f) && /retry 2\/3/.test(f),
      { label: "live retry status (backing off)", timeoutMs: 15000 },
    )
    a.has(during, /⏳\s*rate-limited · retry 2\/3 · 4s/, "the node shows the live rate-limit retry status DURING the backoff")
    a.has(during, /scan routes/, "the retrying node is identified (scan routes)")
    // the composer status ALSO surfaces the throttle (turn-level visibility, not just the tree).
    a.has(during, /rate-limited · retry 2\/3 · 4s · esc interrupt/, "the composer status surfaces the rate-limit retry (turn-level)")

    // (2) RECOVER — once the backoff clears, the retry status is GONE (BOTH the tree row AND the
    //     composer note) and the node finishes ✓ with its real result. Gate on the node's result
    //     AND the absence of the retry wording so the capture is a genuinely-settled frame (not the
    //     sub-second transition). Proof the retry was transient + the badge does not linger.
    const recovered = await d.waitFor(
      (f) => /found 3 routes/.test(f) && !/rate-limited · retry/.test(f),
      { label: "node recovered after the retry", timeoutMs: 40000 },
    )
    a.hasNot(recovered, /⏳/, "the '⏳ rate-limited' retry status is gone once the node recovers")
    a.hasNot(recovered, /rate-limited · retry/, "the composer rate-limit note clears on recover")
    a.has(recovered, /✓.*scan routes|scan routes.*found 3 routes/, "the recovered node finishes ✓ with its result")
    a.has(recovered, /found 3 routes/, "the node's real result lands after the transient retry")
  } finally {
    await d.stop()
  }
})
