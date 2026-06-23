#!/usr/bin/env bun
// FRAME GATE — WIRE-AUTOCOMPLETE. Proves the autocomplete popup is WIRED INTO THE REAL composer in
// chat.tsx (not just the standalone fixture autocomplete.test.ts pins): typing "@" / "/" at the
// cursor of the live composer opens the popup, ↑↓/↵ select+insert, esc closes and the composer
// regains focus. Driven through the REAL chat.tsx under the terminal-control PTY (RLM_MOCK=1, zero
// network) — the SPEC contract "wire autocomplete.tsx into the composer".
//
// This is DISTINCT from autocomplete.test.ts: that mounts the popup against a bare <textarea>
// fixture to pin the COMPONENT; this drives chat.tsx's actual composer (the onContentChange →
// ac.sync trigger detection, the mode-stack push, the useKeyboard nav-key interception with
// preventDefault, and the onInsert splice back into the real textarea). The tell that it's the REAL
// composer: the "/" menu lists chat.tsx's LIVE command registry (/New session, /Pick model…, /Quit)
// and the "@" menu lists REAL repo files (package.json, AGENTS.md) from the live cwd walk.
//
// assert.ts discipline: STABLE content via the frame-stable waitFor (the "@ files" / "/ commands"
// titles, real file/command rows, the "↑↓ select · ↵ insert · esc close" footer, the inserted
// token), never a spinner glyph or byte-exact golden. Reproduces across retries (every wait gates
// on rendered content; no setTimeout-then-assert).
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("wire-autocomplete", async (a) => {
  const d = await launchDriver({ cols: 90, rows: 28 })
  try {
    // ── boot → list → open a chat: the composer is focused (placeholder visible) ──────────────────
    await d.waitForFrame((f) => /press n|no sessions|SESSIONS/i.test(f), 8000)
    await d.type("n") // new session → chat view
    await d.waitForFrame((f) => /message kimi/i.test(f), 8000)

    // ── 1) "/" → COMMAND popup. On the EMPTY buffer, "/" at offset 0 opens the slash menu listing
    //    chat.tsx's LIVE command registry. Wait for the FOOTER (last-painted) so the card is fully
    //    rendered, not a transitional frame. ──────────────────────────────────────────────────────
    await d.type("/")
    const slash = await d.waitForFrame((f) => /\/ commands/.test(f) && /↵ insert/.test(f), 8000)
    a.has(slash, /\/ commands/, "typing / at offset 0 opens the command popup in the composer")
    a.has(slash, "/New session", "the slash menu lists chat.tsx's live commands (real registry, not canned)")
    a.has(slash, "/Quit", "the slash menu lists every live command")
    a.has(slash, /↑↓ select · ↵ insert · esc close/, "the popup shows the nav/insert/close footer")

    // ── 2) ↵ INSERTS the selected command token into the live textarea AND closes the popup. The
    //    default selection (row 0) is "New session" → insert "/New session " (the value + space). ──
    await d.key("Enter")
    const inserted = await d.waitForFrame((f) => /\/New session/.test(f) && !/\/ commands/.test(f), 8000)
    a.has(inserted, "/New session", "Enter inserts the picked command token into the composer text")
    a.hasNot(inserted, /\/ commands/, "the popup closes after inserting (↵ select + insert)")

    // ── 3) "@" → FILE popup. The buffer is now "/New session " — typing "@" after the trailing
    //    space is a valid mention trigger, so the @-mention popup opens listing REAL repo files
    //    (the live cwd walk), proving the dual-trigger detection runs in the real composer. The file
    //    walk is async, so wait for the LOADED end-state (a real file row) — not a title/footer
    //    coincidence frame — which is the stable signal across retries (AGENTS.md sorts first). ─────
    await d.type("@")
    const at = await d.waitForFrame((f) => /@ files/.test(f) && /AGENTS\.md/.test(f), 8000)
    a.has(at, /@ files/, "typing @ at the cursor opens the file-mention popup in the composer")
    a.has(at, "AGENTS.md", "the @ popup lists real repo files (live cwd walk, not canned)")
    a.has(at, /↑↓ select · ↵ insert · esc close/, "the @ popup shows the nav/insert/close footer")

    // ── 4) typing narrows the @ list (fuzzy filter): "pack" brings package.json up from deep in the
    //    136-file walk and drops AGENTS.md (which sorted first unfiltered). The filter end-state is
    //    stable, so wait on it directly. ────────────────────────────────────────────────────────────
    await d.type("pack")
    const filt = await d.waitForFrame((f) => /package\.json/.test(f) && !/AGENTS\.md/.test(f), 8000)
    a.has(filt, "package.json", "typing narrows the @ list to the fuzzy match")
    a.hasNot(filt, "AGENTS.md", "non-matching files are filtered out of the @ popup")

    // ── 5) ESC closes the popup. (The "@ files" card is gone; the composer keeps its buffer.) ─────
    await d.key("Escape")
    const closed = await d.waitForFrame((f) => !/@ files/.test(f) && /message kimi|kimi-k2/.test(f), 8000)
    a.hasNot(closed, /@ files/, "esc closes the autocomplete popup")

    // ── 6) COMPOSER REGAINS FOCUS after esc: typing still reaches the input (and re-fires the
    //    trigger detection), so a fresh " @" (the space makes @ a valid trigger) RE-OPENS the popup
    //    on a CLEAN query (so the unfiltered list, AGENTS.md first, is back). This is the focus-regain
    //    proof — the textarea kept focus through the popup + the esc. ───────────────────────────────
    await d.type(" @")
    const reopen = await d.waitForFrame((f) => /@ files/.test(f) && /AGENTS\.md/.test(f), 8000)
    a.has(reopen, /@ files/, "after esc the composer regains focus — typing @ reopens the popup")
    a.has(reopen, "AGENTS.md", "the reopened popup re-walks the files (keystrokes reach the focused input)")
  } finally {
    await d.stop()
  }
})
