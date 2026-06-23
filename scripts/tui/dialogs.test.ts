// FRAME GATE — the SESSION SWITCHER + MODEL PICK actually WORK, driven through the REAL chat.tsx
// under the terminal-control PTY (RLM_MOCK=1, zero network). These are the two extra pickers the
// command palette opens (dialogs.tsx), each a THIN wrapper over the SAME generic DialogSelect<T>
// the palette uses — opencode reuse: one searchable primitive, three dialogs (commands / sessions /
// models) that read identically.
//
// WHAT THIS PINS (behavior, not glyphs):
//   - ⌘K opens the command palette (DialogSelect) and OFFERS "Switch session…" + "Pick model…"
//     (the palette no longer inlines one "Switch: <session>" row per session — it opens a picker).
//   - Filtering the palette to "Switch" narrows + drops non-matches; ↵ RUNS it → a SECOND, DISTINCT
//     DialogSelect dialog opens: "Switch session" with the SWITCH footer ("↵ switch …"), NOT the
//     palette's "↵ run" footer. Same primitive, different dialog — the reuse proof.
//   - The switcher lists BOTH sessions + the "current" tag on the active one; its OWN filter narrows.
//   - ↵ in the switcher switches the session AND returns focus to the composer (the dialog closes).
//   - The model pick lists Kimi K2.7 + GLM 5.2 (the fixed pool) with the "selected" tag; esc closes
//     it WITHOUT changing anything (back to the composer).
//
// Assertions wait on FRAME-STABLE text (titles / footers / tags / the composer prompt) via the
// driver's waitForFrame — never a spinner glyph or byte-exact golden (assert.ts discipline). The
// PTY frames are timing-sensitive; a transient miss that passes on re-run is a FLAKE, not a bug.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("dialogs", async (a) => {
  const d = await launchDriver({ cols: 80, rows: 26 })
  try {
    // TWO SESSIONS so "Switch session…" is offered (it's listed only with >1 session — nothing to
    // switch to otherwise). From the list view: n → session 1 (chat view), esc back to list, n →
    // session 2 (chat view, the active one). Now there are two sessions; session 2 is current.
    await d.waitForFrame((f) => /press n|no sessions|SESSIONS/i.test(f), 8000)
    await d.type("n") // → session 1, chat view
    await d.waitForFrame((f) => /message kimi/i.test(f), 8000)
    await d.key("Escape") // back to the list (idle composer)
    await d.waitForFrame((f) => /SESSIONS/i.test(f) && /session 1/.test(f), 6000)
    await d.type("n") // → session 2, chat view (the active session)
    await d.waitForFrame((f) => /message kimi/i.test(f), 8000)

    // OPEN the command palette and confirm it OFFERS the two pickers (not inline switch rows).
    await d.ctrl("k")
    const pal = await d.waitForFrame((f) => /Commands/.test(f) && /esc close/.test(f), 6000)
    a.has(pal, /Commands/, "Ctrl+K opens the command palette")
    a.has(pal, /Switch session/, "palette offers the session switcher (with >1 session)")
    a.has(pal, /Pick model/, "palette offers the model pick")
    a.has(pal, /↵ run · ↑↓ select · esc close/, "palette shows the RUN footer (the command dialog)")

    // FILTER the palette to the switch command; non-matches drop out.
    await d.type("Switch")
    const filt = await d.waitForFrame((f) => /Switch session/.test(f) && !/Pick model/.test(f), 5000)
    a.has(filt, /Switch session/, "typing narrows the palette to the switch command")
    a.hasNot(filt, /Pick model/, "non-matching palette commands are filtered out")

    // RUN it → the SESSION SWITCHER opens: a DISTINCT dialog on the SAME primitive. The tell is the
    // SWITCH footer ("↵ switch …") in place of the palette's "↵ run …" — proof it's a separate
    // dialog, not the palette relabeled. It lists BOTH sessions + the "current" tag on the active one.
    await d.key("Enter")
    const sw = await d.waitForFrame((f) => /Switch session/.test(f) && /↵ switch/.test(f), 6000)
    a.has(sw, /Switch session/, "Enter opens the session switcher (a second DialogSelect dialog)")
    a.has(sw, /↵ switch · ↑↓ select · esc close/, "the switcher shows its OWN switch footer (not the palette's run footer)")
    a.hasNot(sw, /↵ run/, "the palette's run footer is gone — this is a distinct dialog on the same primitive")
    a.has(sw, /session 1/, "the switcher lists the first session")
    a.has(sw, /session 2/, "the switcher lists the second session")
    a.has(sw, /current/, "the active session carries the 'current' tag")

    // The switcher's OWN filter narrows (proves it's a live DialogSelect controller, not static).
    await d.type("session 1")
    const swFilt = await d.waitForFrame((f) => /session 1/.test(f) && !/session 2/.test(f), 5000)
    a.has(swFilt, /session 1/, "the switcher's own filter narrows to the typed session")
    a.hasNot(swFilt, /session 2/, "the switcher filters out the non-matching session")

    // ↵ SWITCHES to session 1 AND returns focus to the composer (the dialog closes). Gate on a
    // FULLY-settled post-switch frame: the dialog footer gone AND the composer prompt back.
    await d.key("Enter")
    const switched = await d.waitForFrame((f) => /message kimi/.test(f) && !/↵ switch/.test(f), 6000)
    a.hasNot(switched, /↵ switch/, "Enter switches the session and closes the switcher")
    a.has(switched, /message kimi/, "focus returns to the composer after the switch")

    // MODEL PICK — open via ⌘K → "Pick model…". It lists the fixed two-model pool with the
    // "selected" tag on the current one, and a DISTINCT pick footer. esc closes it unchanged.
    await d.ctrl("k")
    await d.waitForFrame((f) => /Commands/.test(f) && /Pick model/.test(f), 6000)
    await d.type("model")
    await d.waitForFrame((f) => /Pick model/.test(f) && !/Scroll to bottom/.test(f), 5000)
    await d.key("Enter")
    const pick = await d.waitForFrame((f) => /Pick model/.test(f) && /↵ pick/.test(f), 6000)
    a.has(pick, /Pick model/, "⌘K → Pick model opens the model picker (same primitive)")
    a.has(pick, /↵ pick · ↑↓ select · esc close/, "the model picker shows its OWN pick footer")
    a.has(pick, /Kimi K2\.7/, "the model picker lists Kimi K2.7 (the default pool model)")
    a.has(pick, /GLM 5\.2/, "the model picker lists GLM 5.2 (the alternate pool model)")
    a.has(pick, /selected/, "the current model carries the 'selected' tag")

    // esc closes the picker and returns to the composer WITHOUT changing the model.
    await d.key("Escape")
    const closed = await d.waitForFrame((f) => /message kimi/.test(f) && !/↵ pick/.test(f), 5000)
    a.hasNot(closed, /↵ pick/, "esc closes the model picker")
    a.has(closed, /message kimi/, "focus returns to the composer after the picker closes")

    console.log("  ── captured session switcher + model pick frames ──")
    console.log(
      sw
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )
    console.log(
      pick
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )
  } finally {
    await d.stop()
  }
})
