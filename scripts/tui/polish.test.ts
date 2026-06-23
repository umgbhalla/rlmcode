#!/usr/bin/env bun
// FRAME GATE — POLISH. The TUI-maturity "polish" step proves three opencode-grade touches over
// the REAL chat.tsx (terminal-control PTY + RLM_MOCK, zero network), each as a CAPTURED-FRAME
// assertion (not compile-only):
//
//   (1) PER-NODE TOKEN BADGE — the orch node-tree renders each settled node's token usage DIM +
//       inline ON THE NODE LINE (chat.tsx NodeTokens), not only in the Σ run-total footer. We
//       drive an "orchestrate" turn (mock_orch replays the canned node feed) and assert a SINGLE
//       LINE carries both a node's label AND its "N tok" badge (JS `.*` never crosses \n, so a
//       same-line match is the proof the badge hangs on the node row, distinct from the Σ footer).
//   (2) QUEUED BADGE — a message submitted WHILE a turn is in flight renders as a dim "↑ queued"
//       pending card below the live transcript (messages.tsx QueuedCard, now drawn by the shared
//       Panel "accent" variant), held — not fired as a concurrent turn. We pace the first turn's
//       streamed reply so it stays busy past the second submit, then assert the badge.
//   (3) WHICH-KEY OVERLAY — `?` raises the contextual keybind-hint overlay (which-key.tsx, now in
//       the shared Panel "card" variant + a Separator divider), reading the ACTIVE bindings off
//       the registry: we assert the title, a binding description + its key chord, AND the Separator
//       rule under the header — proof the overlay LISTS bindings (not just that a boolean flipped).
//
// All three surfaces compose the NEW ui/panel.tsx (Panel + Separator) primitives this step added;
// these frames are therefore also the adoption proof (the cards/overlays still draw their borders).
// Waits are frame-stable (driver.waitFor over captured text), never setTimeout-then-assert, and
// assert STABLE content (labels, connectors, the badge text, the divider) — not a spinner glyph.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("polish.test", async (a) => {
  // ── (1) PER-NODE TOKEN BADGE on a node line ─────────────────────────────────────────────────
  {
    const d = await launchDriver({ rows: 40 })
    try {
      await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
      await d.type("n")
      await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
      await d.type("orchestrate the research")
      await d.key("Enter")
      // Gate on the COMPLETE Σ footer (the tree has settled) so the per-node badges have painted.
      const tree = await d.waitFor(
        (f) => /scan auth/.test(f) && /3\.1k tok/.test(f) && /Σ.*7 node/.test(f),
        { label: "orch tree settled", timeoutMs: 40000 },
      )
      // The badge sits ON the node's row: a single line carries the node label AND its token badge.
      // (`.*` can't cross a newline, so a same-line match proves it's the node row, not the Σ footer.)
      a.has(tree, /scan auth.*3\.1k tok/, "per-node token badge renders DIM on the node line (scan auth · 3.1k tok)")
      // And it is genuinely a TREE node line (a connector precedes the label), not a flat transcript row.
      a.has(tree, /[├└]─.*scan auth.*3\.1k tok/, "the token badge hangs on a connector-prefixed node row")
      // The Σ footer is the SEPARATE run-total (so the per-node badge isn't merely the footer echoed).
      a.has(tree, /Σ.*tok.*7 node/, "the Σ run-total footer is still present (the per-node badge is distinct from it)")
    } finally {
      await d.stop()
    }
  }

  // ── (2) QUEUED BADGE — a message posted while a prior turn is in flight ──────────────────────
  {
    // Pace the streamed reply so the first turn holds "busy" past the second submit + the captured
    // frame (the queued card must be visible WHILE busy). Same deterministic pacing as queued.test.
    const d = await launchDriver({ rows: 40, env: { RLM_MOCK_STREAM: "1", RLM_MOCK_DELAY_MS: "2500" } })
    try {
      await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
      await d.type("n")
      await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
      await d.type("first question")
      await d.key("Enter")
      await d.waitFor((f) => /thinking…/.test(f) && /first question/.test(f), { label: "first turn busy", timeoutMs: 15000 })
      // Submit a SECOND message WHILE busy → it must QUEUE (held), not start a concurrent turn.
      await d.type("second while busy")
      await d.key("Enter")
      const queued = await d.waitFor(
        (f) => /↑ queued/.test(f) && /second while busy/.test(f),
        { label: "queued pending card", timeoutMs: 8000 },
      )
      a.has(queued, /↑ queued\s+second while busy/, "a message posted while a prior turn is in flight shows a dim '↑ queued' badge")
      a.has(queued, /thinking…/, "the prior turn is still in flight (the queued message did NOT start a concurrent turn)")
    } finally {
      await d.stop()
    }
  }

  // ── (3) WHICH-KEY OVERLAY — `?` lists the active bindings ────────────────────────────────────
  {
    const d = await launchDriver({ cols: 100, rows: 30 })
    try {
      await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
      await d.type("n")
      await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
      // `?` on an empty composer raises the centered overlay. Gate on the FOOTER (last-painted line)
      // so we capture a FULLY-rendered card, not a half-drawn transitional frame.
      await d.type("?")
      const open = await d.waitFor((f) => /\? toggle · esc close/.test(f), { label: "which-key open", timeoutMs: 6000 })
      a.has(open, /Keybindings/, "`?` opens the which-key overlay (title)")
      a.has(open, /command palette/, "the overlay LISTS a binding's description (ctrl+k → command palette)")
      a.has(open, /ctrl\+k/, "the overlay shows the key chord for each binding (key + desc)")
      a.has(open, /─{2,}/, "the overlay draws the shared Separator rule under its header")
      // esc dismisses it and returns focus to the composer.
      await d.key("Escape")
      const closed = await d.waitFor((f) => !/Keybindings/.test(f), { label: "which-key closed", timeoutMs: 5000 })
      a.hasNot(closed, /Keybindings/, "esc closes the which-key overlay")
      a.has(closed, /message kimi/, "focus returns to the composer after the overlay closes")
    } finally {
      await d.stop()
    }
  }
})
