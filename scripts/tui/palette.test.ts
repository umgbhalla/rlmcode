// FRAME GATE — the ⌘K command palette actually WORKS (opens, filters, runs, closes), driven
// through the REAL chat.tsx under the terminal-control PTY (RLM_MOCK=1, zero network). The
// composer advertises "Cmd+K commands"; this proves the key does something, not just shows.
//
// It ALSO pins the dialog-select REFACTOR: the palette is now a thin wrapper over the generic
// DialogSelect<T> primitive (its useDialogSelect controller owns the filter + ↑↓ + the empty
// state), not the old hand-rolled card. The tell is the DialogSelect EMPTY-state copy — "no
// matches" — where the old palette said "no matching command". A no-match query that renders "no
// matches" (and NOT "no matching command") proves chat.tsx is driving DialogSelect's controller.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("palette", async (a) => {
  const d = await launchDriver({ cols: 80, rows: 26 })
  try {
    await d.waitForFrame((f) => /press n|no sessions|SESSIONS/i.test(f), 8000)
    await d.type("n") // new session → chat view
    await d.waitForFrame((f) => /message kimi/i.test(f), 8000)

    // OPEN — Ctrl+K raises the centered command dialog. Wait for the FOOTER (the last-painted
    // line) so we assert a FULLY-rendered dialog, not a half-drawn transitional frame.
    await d.ctrl("k")
    const open = await d.waitForFrame((f) => /esc close/.test(f), 6000)
    a.has(open, /Commands/, "Ctrl+K opens the palette")
    a.has(open, /New session/, "palette lists real commands")
    a.has(open, /↵ run · ↑↓ select · esc close/, "palette shows the run/nav/close footer")

    // FILTER — typing narrows to matching commands; non-matching ones drop out.
    await d.type("scroll")
    const filt = await d.waitForFrame((f) => /Scroll to bottom/.test(f) && !/New session/.test(f), 5000)
    a.has(filt, /Scroll to bottom/, "typing filters to matching commands")
    a.hasNot(filt, /New session/, "non-matching commands are filtered out")

    // DIALOG-SELECT REFACTOR PROOF — extend the query so nothing matches; the DialogSelect
    // controller renders its OWN empty state ("no matches"), NOT the old hand-rolled palette's
    // "no matching command". Seeing the former (and not the latter) proves the palette is now the
    // generic DialogSelect<T> primitive driven by useDialogSelect, not the deleted custom card.
    await d.type("zzz") // "scrollzzz" — matches no command title
    const none = await d.waitForFrame((f) => /no matches/.test(f), 5000)
    a.has(none, /no matches/, "no-match query shows DialogSelect's empty state (palette is DialogSelect-backed)")
    a.hasNot(none, /no matching command/, "the old hand-rolled palette empty-state copy is gone")
    // back to a real match so RUN below has something safe (a scroll) to execute
    await d.key("Backspace")
    await d.key("Backspace")
    await d.key("Backspace")
    await d.waitForFrame((f) => /Scroll to bottom/.test(f) && !/no matches/.test(f), 5000)

    // RUN — Enter executes the highlighted command AND closes the palette (here: a scroll, safe).
    // Wait for a FULLY-settled post-close frame: the dialog must be gone AND the composer back.
    // (Gating only on the negative `!/Commands/` can match a transitional mid-teardown frame where
    // the dialog title is torn off but its box + the composer footer haven't repainted yet — a
    // PTY race. The conjunctive positive wait — dialog footer gone AND composer prompt back —
    // pins the real behavior ("focus returns to the composer") without a transitional false-hit.)
    await d.key("Enter")
    const ran = await d.waitForFrame((f) => /message kimi/.test(f) && !/esc close/.test(f), 5000)
    a.hasNot(ran, /esc close/, "Enter runs the command and closes the palette")
    a.has(ran, /message kimi/, "focus returns to the composer after the palette closes")
  } finally {
    await d.stop()
  }
})
