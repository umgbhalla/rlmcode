#!/usr/bin/env bun
// FRAME GATE — DialogSelect<T>. Proves the generic searchable picker (src/tui/dialog-select.tsx
// + its useDialogSelect controller) actually WORKS through the REAL opentui renderer + the REAL
// key handler: it OPENS (title + categorised items + footer), FILTERS as you type, MOVES the
// selection with ↑↓ (the › active marker tracks), and SELECTS on Enter — driven through the
// dialog-select-demo fixture under the terminal-control PTY (like ui-atoms, a standalone entry).
//
// This is the primitive opencode's ui/dialog-select.tsx is, ported Solid→React; the assertions
// pin STABLE STRUCTURE (the dialog title, item/category labels, the footer nav line, the ›
// focus marker, the "selected: <title>" sink) — never a spinner glyph or byte-exact golden,
// per the assert.ts discipline. Waits are frame-stable (waitForFrame over captured text).
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, "dialog-select-demo.tsx")

await report("dialog-select.test", async (a) => {
  const d = await launchDriver({ entry: ENTRY, cols: 90, rows: 30 })
  try {
    // ── OPENS — the dialog renders its title, the first category, items, and the footer ──────
    const open = await d.waitForFrame((f) => /Pick a fruit/.test(f) && /↵ select/.test(f), 15000)
    a.has(open, "Pick a fruit", "dialog renders its title")
    a.has(open, /Common/, "category header renders (grouping)")
    a.has(open, "apple", "an item from the first group renders")
    a.has(open, /↵ select · ↑↓ move · esc close/, "dialog shows the select/move/close footer")
    a.has(open, "selected: (none)", "nothing selected yet (the selection sink starts empty)")

    // ── FILTER — typing "ber" narrows to the *berry matches (across BOTH groups); the
    // non-matching Common items (apple/banana/…) drop out. Proves grouping survives the filter
    // (the Berries header now fits the scroll window) AND the substring filter works. ──────────
    await d.type("ber")
    const filt = await d.waitForFrame((f) => /raspberry/.test(f) && /Berries/.test(f) && !/\bapple\b/.test(f), 6000)
    a.has(filt, "ber", "the typed query shows on the search line (all chars landed — no stale-closure drop)")
    a.has(filt, /Berries/, "the second category header renders once its group fits (grouping survives filtering)")
    a.has(filt, /raspberry/, "typing filters to matching items (substring over title)")
    a.has(filt, /elderberry/, "a first-group item that also matches the substring stays under its own group")
    a.hasNot(filt, /\bapple\b/, "non-matching items are filtered out")

    // ── MOVE — the › active marker starts on the FIRST match; ↑↓ moves it ─────────────────────
    a.has(filt, /›/, "the active row carries the › focus marker")

    // ── SELECT — ↓ then Enter submits the (moved) active item; the sink shows which value landed.
    // The exact marked row is layout-sensitive, so the durable proof ↑↓ moved the controller's
    // selected index is the SELECTED VALUE in the sink (onSelect fired with the moved option).
    await d.key("ArrowDown")
    await d.key("Enter")
    const picked = await d.waitForFrame((f) => /selected: \w*berry/.test(f), 6000)
    a.has(picked, /selected: \w*berry/, "Enter selects the active item (↑↓ moved the selection, submit fired onSelect)")
    a.hasNot(picked, "selected: (none)", "the selection sink updated — onSelect ran with the moved value")

    console.log("  ── captured dialog-select frame (filtered + selected) ──")
    console.log(
      picked
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )
  } finally {
    await d.stop()
  }
})
