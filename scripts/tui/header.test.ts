#!/usr/bin/env bun
// FRAME GATE — HEADER-ANCHORS. The chat view anchors a ref-light STICKY HEADER at the top
// (src/tui/header.tsx SessionHeader, flexShrink:0): "rlmcode · session <id>". The <id> is the
// SessionView.id — the SAME value tagged on the motel `chat.session` span as session.id (atoms.ts
// newSessionAtom) — so the header doubles as the user's trace-correlation handle. This proves the
// header RENDERS (not compile-only) over the REAL chat.tsx (terminal-control PTY + RLM_MOCK):
//   - the banner reads "rlmcode · session s<seq>-<ts>" (the real generated id shape);
//   - it sits ABOVE the transcript/composer (it appears earlier in the row-ordered frame text);
//   - it SURVIVES a turn (the same session id is still anchored after a reply settles — the header
//     is sticky, not a one-shot line that scrolls away with the transcript).
// Waits are frame-stable (driver.waitFor over captured text), never setTimeout-then-assert; we
// assert the STABLE header text + structure, not a spinner glyph.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"
import { isScrolledUp } from "../../src/tui/header.tsx"

await report("header.test", async (a) => {
  // ── PURE GATE: the "N new" pill's scroll-position read (isScrolledUp) — the ref-driven predicate
  //    that decides whether the pill shows. No PTY (the pill is hard to scroll deterministically in
  //    a PTY): a fake ScrollBox shape covers the cases the imperative read distinguishes. ─────────
  a.ok(!isScrolledUp(null), "isScrolledUp is false when the scrollbox ref isn't mounted")
  a.ok(!isScrolledUp({ scrollTop: 0, scrollHeight: 10, viewport: { height: 100 } }), "false when content fits (nothing to scroll)")
  a.ok(!isScrolledUp({ scrollTop: 90, scrollHeight: 100, viewport: { height: 10 } }), "false when pinned to the bottom (scrollTop at max)")
  a.ok(isScrolledUp({ scrollTop: 0, scrollHeight: 100, viewport: { height: 10 } }), "true when scrolled UP from the bottom (newer rows below the fold)")
  a.ok(isScrolledUp({ scrollTop: 40, scrollHeight: 100, viewport: { height: 10 } }), "true mid-scroll (above the bottom)")

  const d = await launchDriver({ rows: 30 })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n") // new session → activeId set, chat view mounts
    // The sticky header anchors the moment the chat view is up — gate on it AND the composer so we
    // capture a fully-mounted chat frame (the id shape is s<seq>-<base36 ts>, e.g. "s1-labc123").
    const mounted = await d.waitFor(
      (f) => /rlmcode · session s\d+-\w+/.test(f) && /message kimi/.test(f),
      { label: "chat header anchored", timeoutMs: 10000 },
    )
    a.has(mounted, /rlmcode · session s\d+-\w+/, "the sticky header shows 'rlmcode · session <id>' (the motel session.id handle)")

    // ANCHORED AT THE TOP: the header row precedes the composer's "message kimi" placeholder in the
    // row-ordered frame text (frames join rows top→bottom with \n), so a smaller index = higher up.
    const headerIdx = mounted.search(/rlmcode · session/)
    const composerIdx = mounted.search(/message kimi/)
    a.ok(headerIdx >= 0 && composerIdx >= 0 && headerIdx < composerIdx, "the header is anchored ABOVE the composer (top of the chat view)")

    // capture the exact session id the header shows so we can prove it's STABLE across a turn.
    const id = mounted.match(/session (s\d+-\w+)/)?.[1]
    a.ok(typeof id === "string" && id.length > 0, "the header carries a concrete session id")

    // SURVIVES A TURN: send a message; once the reply settles, the SAME session id is still anchored
    // at the top (the header is sticky — it doesn't scroll away with the transcript).
    await d.type("hello there")
    await d.key("Enter")
    const afterTurn = await d.waitFor(
      (f) => /Found 3 matches in src/.test(f) && new RegExp(`rlmcode · session ${id}`).test(f),
      { label: "header still anchored after the turn settles", timeoutMs: 30000 },
    )
    a.has(afterTurn, new RegExp(`rlmcode · session ${id}`), "the SAME session id stays anchored at the top after a turn settles (sticky header)")
    a.has(afterTurn, /hello there/, "the turn's transcript renders under the sticky header")
  } finally {
    await d.stop()
  }
})
