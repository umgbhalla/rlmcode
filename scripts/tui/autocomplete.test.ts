#!/usr/bin/env bun
// FRAME GATE — AUTOCOMPLETE. Mounts the NEW autocomplete popup (src/tui/autocomplete.tsx) wired to
// a REAL opentui <textarea> via the autocomplete-demo fixture, headlessly under the terminal-control
// PTY (zero network, zero fs — the @ file set + / commands are canned in the fixture), and proves
// the popup BEHAVIOR end-to-end against captured frames:
//   1. type "@" → the popup OPENS as a "@ files" card with the canned file rows + the nav footer,
//   2. type "comp" → the list NARROWS (composer.tsx stays, atoms.ts drops out) — fuzzy filter,
//   3. press ↵ → the selected path is INSERTED into the textarea ("@src/tui/composer.tsx ") and
//      the popup CLOSES,
//   4. type "/" → the SLASH command menu opens with the canned commands (the dual-trigger).
//
// We assert STABLE STRUCTURE via the frame-stable waitFor (the "@ files" title, the path rows, the
// "↑↓ select · ↵ insert · esc close" footer, the echoed "input:" line), never a spinner glyph or a
// byte-exact golden — the assert.ts discipline. Reproduces across retries (no timing-coupled
// assertion; every wait gates on rendered content).
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"
import { detectTrigger, filterItems, applyInsert, fuzzyScore, type AcItem } from "../../src/tui/autocomplete.tsx"

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, "autocomplete-demo.tsx")

await report("autocomplete.test", async (a) => {
  // ── PURE GATES: the trigger-detection + fuzzy filter + splice the controller is built on ──────
  const at = detectTrigger("@comp", 5)
  a.ok(at?.mode === "@" && at.index === 0 && at.query === "comp", "detectTrigger reads the @ trigger + query")
  const slash = detectTrigger("/new", 4)
  a.ok(slash?.mode === "/" && slash.query === "new", "detectTrigger reads the / trigger at offset 0")
  a.ok(detectTrigger("hi there", 8) === null, "no trigger ⇒ null (plain text)")
  a.ok(detectTrigger("a@b", 3) === null, "an @ mid-word (email) does NOT trigger a mention")
  a.ok(detectTrigger("see @", 5)?.mode === "@", "an @ after a space DOES trigger a mention")
  const files: Array<AcItem> = [
    { value: "src/tui/atoms.ts", kind: "file" },
    { value: "src/tui/composer.tsx", kind: "file" },
  ]
  const narrowed = filterItems(files, "comp")
  a.ok(narrowed.length === 1 && narrowed[0]!.value === "src/tui/composer.tsx", "filterItems fuzzy-narrows to the match")
  a.ok(fuzzyScore("xyz", "src/tui/composer.tsx") === null, "fuzzyScore returns null when chars don't subsequence-match")
  const spliced = applyInsert("@comp", 5, { mode: "@", index: 0, query: "comp" }, files[1]!)
  a.ok(spliced.text === "@src/tui/composer.tsx " && spliced.cursor === spliced.text.length, "applyInsert splices the picked path in + trailing space")

  // ── FRAME GATE: drive the REAL popup through the fixture under the PTY ─────────────────────────
  // Order: the SLASH menu first (on the empty buffer, "/" at offset 0), then clear the lone "/"
  // (one Backspace — reliable), then the @ flow. This avoids fighting the textarea over a
  // multi-char clear after an insert (the textarea has no select-all clear we can drive cleanly).
  const d = await launchDriver({ entry: ENTRY, cols: 80, rows: 24 })
  try {
    await d.waitForFrame((f) => /autocomplete fixture/.test(f) && /type @ or \//.test(f), 15000)

    // 1) SLASH MENU — typing "/" at offset 0 opens the command menu (the dual-trigger). Wait for
    //    the FOOTER (last-painted) so we assert a fully-rendered card, not a transitional frame.
    await d.type("/")
    const slashOpen = await d.waitForFrame((f) => /↵ insert/.test(f) && /\/ commands/.test(f), 8000)
    a.has(slashOpen, /\/ commands/, "typing / at offset 0 opens the slash command menu")
    a.has(slashOpen, "/new", "the slash menu lists the canned commands")
    a.has(slashOpen, "/quit", "the slash menu lists every canned command")
    a.has(slashOpen, /↑↓ select · ↵ insert · esc close/, "the slash menu shows the nav/insert/close footer")

    // close the slash popup (esc) + delete the lone "/" so the buffer is empty for the @ flow.
    // Frame-gate BOTH transitions (popup closed AND buffer cleared) before typing "@" — otherwise
    // a residual "/" left by a still-closing menu makes the @ query non-empty, pre-filtering the
    // file list (the flake this guards). Waits are frame-stable, never setTimeout-then-assert.
    await d.key("Escape")
    await d.waitForFrame((f) => !/\/ commands/.test(f), 5000)
    await d.key("Backspace")
    await d.waitForFrame((f) => /input:\s*$/m.test(f), 5000)

    // 2) OPEN — typing "@" raises the file-mention popup with the canned files + the footer.
    await d.type("@")
    const open = await d.waitForFrame((f) => /↵ insert/.test(f) && /@ files/.test(f), 8000)
    a.has(open, /@ files/, "typing @ opens the file mention popup")
    a.has(open, "src/tui/atoms.ts", "the popup lists the canned repo files")
    a.has(open, "src/tui/composer.tsx", "the popup lists every canned file before filtering")
    a.has(open, /↑↓ select · ↵ insert · esc close/, "the popup shows the nav/insert/close footer")

    // 3) FILTER — typing narrows the list; the non-matching file drops out (fuzzy filter).
    await d.type("comp")
    const filt = await d.waitForFrame((f) => /src\/tui\/composer\.tsx/.test(f) && !/atoms\.ts/.test(f), 8000)
    a.has(filt, "src/tui/composer.tsx", "typing narrows to the fuzzy-matching file")
    a.hasNot(filt, "atoms.ts", "non-matching files are filtered out")

    // 4) INSERT — ↵ splices the selected path into the textarea AND closes the popup.
    await d.key("Enter")
    const inserted = await d.waitForFrame((f) => /input: @src\/tui\/composer\.tsx/.test(f) && !/@ files/.test(f), 8000)
    a.has(inserted, "input: @src/tui/composer.tsx", "Enter inserts the picked @path into the composer text")
    a.hasNot(inserted, /@ files/, "the popup closes after inserting")
  } finally {
    await d.stop()
  }
})
