#!/usr/bin/env bun
// FRAME GATE — WHICH-KEY. Proves the contextual keybind-hint overlay actually WORKS (opens on
// `?`, lists the ACTIVE chat-node bindings as key+desc rows grouped by category, closes on esc),
// driven through the REAL chat.tsx under the terminal-control PTY (RLM_MOCK=1, zero network). The
// composer dropped its idle keybind help; `?` is the discovery surface this overlay restores —
// this asserts the keys are actually SHOWN, not just that a boolean flipped.
//
// Two layers: (1) a PURE fixture over the presentational helpers (groupBindings/whichKeyColumns)
// so the grouping + multi-column-if-wide math is unit-pinned; (2) the REAL captured frame so the
// wiring (the `?` toggle, the capture-focus overlay, the render) is end-to-end verified.
// Frame-stable waits only (driver.waitFor), never setTimeout-then-assert; assertions match STABLE
// content (the "Keybindings" title, group headers, key+desc rows, the footer) — not a spinner glyph.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"
import { type Binding, groupBindings, whichKeyColumns } from "../../src/tui/which-key.tsx"

await report("which-key", async (a) => {
  // ── (1) pure fixture: grouping + column math ────────────────────────────────────────────────
  const fixture: Array<Binding> = [
    { keys: "ctrl+k", desc: "command palette", group: "Global" },
    { keys: "↵", desc: "send message", group: "Compose" },
    { keys: "esc", desc: "back / interrupt", group: "Navigate" },
    { keys: "?", desc: "toggle this help", group: "Global" },
  ]
  const groups = groupBindings(fixture)
  a.ok(groups.length === 3, "groupBindings buckets the bindings into their 3 categories")
  a.ok(groups[0]!.label === "Compose", "groups are sorted by category label (Compose < Global < Navigate)")
  a.ok(groups.find((g) => g.label === "Global")!.bindings.length === 2, "the Global group holds both of its bindings")
  a.ok(whichKeyColumns(120) > whichKeyColumns(30), "a WIDE terminal yields more columns than a narrow one (multi-column-if-wide)")
  a.ok(whichKeyColumns(30) === 1, "a narrow terminal collapses to a single column")

  // ── (2) the real overlay over the REAL chat.tsx ─────────────────────────────────────────────
  const d = await launchDriver({ cols: 100, rows: 30 })
  try {
    await d.waitForFrame((f) => /press n|no sessions|SESSIONS/i.test(f), 8000)
    await d.type("n") // new session → chat view
    await d.waitForFrame((f) => /message kimi/i.test(f), 8000)

    // OPEN — `?` (composer empty) raises the centered which-key overlay. Wait for the FOOTER (the
    // last-painted line) so we assert a FULLY-rendered card, not a half-drawn transitional frame.
    await d.type("?")
    const open = await d.waitForFrame((f) => /\? toggle · esc close/.test(f), 6000)
    a.has(open, /Keybindings/, "`?` opens the which-key overlay")
    a.has(open, /command palette/, "the overlay lists an active binding's description (ctrl+k → command palette)")
    a.has(open, /ctrl\+k/, "the overlay shows the key chord for each binding (key + desc)")
    a.has(open, /send message/, "the overlay lists the Compose bindings (↵ → send message)")
    a.has(open, /Navigate/, "the overlay groups bindings under category headers (Navigate)")
    a.has(open, /\? toggle · esc close/, "the overlay shows the toggle/close footer")

    // CLOSE — esc dismisses the overlay and returns focus to the composer.
    await d.key("Escape")
    const closed = await d.waitForFrame((f) => !/Keybindings/.test(f), 5000)
    a.hasNot(closed, /Keybindings/, "esc closes the which-key overlay")
    a.has(closed, /message kimi/, "focus returns to the composer after the overlay closes")
  } finally {
    await d.stop()
  }
})
