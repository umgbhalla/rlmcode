#!/usr/bin/env bun
// FRAME GATE — UI-ATOMS. Proves the lifted termcast atoms (src/tui/ui/row.tsx +
// spinner.tsx, driven by animation-tick.tsx) render through the REAL opentui renderer.
// Mounts the ui-atoms-demo fixture headlessly (terminal-control PTY) and asserts the ROW
// STRUCTURE: both equal-flex cell labels are present AND laid out side by side on ONE line
// (cell-left to the left of cell-right) — the Row's even-split layout. The spinner is proven
// PRESENT via its sibling "working" label, NEVER by its glyph phase (' ' · • cycles, so a
// glyph assertion would flake) — exactly the assert.ts stable-structure discipline.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, "ui-atoms-demo.tsx")

await report("ui-atoms.test", async (a) => {
  const d = await launchDriver({ entry: ENTRY })
  try {
    // Wait for the Row to render (both labels present in the frame).
    const frame = await d.waitForFrame((f) => /cell-left/.test(f) && /cell-right/.test(f), 15000)

    a.has(frame, "cell-left", "Row left cell renders")
    a.has(frame, "cell-right", "Row right cell renders")
    // ROW STRUCTURE: the two equal-flex cells share ONE line, left before right.
    a.has(frame, /cell-left\s+cell-right/, "Row lays cells out side by side on one line (even-split)")
    // Spinner is PRESENT (proven by its sibling label) — assert the structure, NOT the glyph.
    a.has(frame, "working", "Spinner row renders (label sibling of the spinner glyph)")

    console.log("  ── captured ui-atoms frame ──")
    console.log(
      frame
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )
  } finally {
    await d.stop()
  }
})
