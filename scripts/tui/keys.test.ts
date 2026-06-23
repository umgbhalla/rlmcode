#!/usr/bin/env bun
// FRAME GATE — KEY REGISTRY + MODE STACK. Proves the wire-registry step: chat.tsx's keyboard is
// now driven by the keys.ts {mode,chord,when,run}[] registry + a MODE STACK (opening an overlay
// PUSHES its mode, closing POPS it), NOT the old onChatKey/onListKey/onPaletteKey if-chains. The
// headline contract this gate exists for: a DIALOG MODE SCOPES THE KEYBOARD — while the command
// palette ("palette" mode) is on the stack top, a BASE nav key does NOT fire its base action; it
// is scoped to the dialog (the char feeds the dialog filter). Once the mode is popped, the base
// binding fires again — the scope is restored.
//
// Two layers, both the assert.ts discipline (STABLE content via the frame-stable waitFor, never a
// spinner glyph or byte-exact golden; reproduces across retries):
//   (1) PURE gates over the registry machinery — the chord matcher (parseChord/matchesChord), the
//       mode-stack scoping (dispatch only runs the ACTIVE mode's rows), and activeBindings.
//   (2) the REAL chat.tsx under the terminal-control PTY (RLM_MOCK=1, zero network): open the
//       palette in list view, press `n` (the base "new session" key) → it does NOT spawn a chat
//       (base nav scoped out), the palette stays open; esc closes it; `n` THEN spawns a chat
//       (base binding restored after the pop).
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"
import { activeBindings, type Bind, dispatch, matchesChord, parseChord } from "../../src/tui/keys.ts"

await report("keys", async (a) => {
  // ── (1) PURE: chord matcher ─────────────────────────────────────────────────────────────────
  a.ok(parseChord("ctrl+k").ctrl && parseChord("ctrl+k").key === "k", "parseChord splits mods + key")
  a.ok(parseChord("shift+tab").shift && parseChord("shift+tab").key === "tab", "parseChord reads shift+tab")
  a.ok(parseChord("esc").key === "escape", "parseChord normalizes the esc alias to opentui's 'escape'")
  a.ok(matchesChord({ name: "k", ctrl: true }, "ctrl+k"), "matchesChord matches Ctrl+K")
  a.ok(!matchesChord({ name: "k" }, "ctrl+k"), "matchesChord requires the ctrl modifier (plain k ≠ ctrl+k)")
  a.ok(!matchesChord({ name: "tab" }, "shift+tab") && matchesChord({ name: "tab", shift: true }, "shift+tab"), "shift is matched exactly (tab ≠ shift+tab)")
  a.ok(matchesChord({ name: "return" }, "return") && !matchesChord({ name: "return", shift: true }, "return"), "return and shift+return stay distinct (submit vs newline)")
  a.ok(matchesChord({ sequence: "?" }, "?"), "matchesChord matches a literal '?' via the raw sequence")
  a.ok(matchesChord({ sequence: "?", shift: true }, "?"), "a literal-char chord ignores shift (the printable already encodes it)")

  // ── (1) PURE: the MODE STACK scopes dispatch — a base row does NOT fire under another mode ────
  let baseFired = 0
  let palFired = 0
  const binds: ReadonlyArray<Bind> = [
    { mode: "base", chord: "n", keys: "n", desc: "new", group: "G", run: () => void baseFired++ },
    { mode: "palette", chord: "escape", keys: "esc", desc: "close", group: "P", run: () => void palFired++ },
  ]
  // base mode: the base "n" row fires; the palette "esc" row is inert.
  a.ok(dispatch({ name: "n" }, "base", binds) && baseFired === 1, "dispatch runs the base 'n' row under base mode")
  a.ok(!dispatch({ name: "escape" }, "base", binds) && palFired === 0, "a palette row does NOT fire under base mode")
  // palette mode (a dialog pushed): the SAME "n" event no longer fires the base row — it's scoped
  // out (dispatch returns false; the host routes the char to the dialog filter). The palette "esc"
  // row now fires. THIS is the "dialog mode scopes keys" contract, proven at the unit level.
  a.ok(!dispatch({ name: "n" }, "palette", binds) && baseFired === 1, "base 'n' is SCOPED OUT under palette mode (does NOT fire; count unchanged)")
  a.ok(dispatch({ name: "escape" }, "palette", binds) && palFired === 1, "the palette's own 'esc' row fires under palette mode")
  // activeBindings projects only the active mode's visible rows (the which-key seam).
  a.ok(activeBindings("base", binds).length === 1 && activeBindings("base", binds)[0]!.keys === "n", "activeBindings yields the active mode's display rows")
  a.ok(activeBindings("palette", binds).some((b) => b.desc === "close"), "activeBindings switches with the active mode")

  // ── (2) FRAME: the dialog mode scopes keys in the REAL chat.tsx ──────────────────────────────
  const d = await launchDriver({ cols: 80, rows: 26 })
  try {
    await d.waitForFrame((f) => /press n|no sessions|SESSIONS/i.test(f), 8000)

    // OPEN the palette from LIST view (Ctrl+K pushes "palette" mode). Wait for the FOOTER (the
    // last-painted line) so we assert a FULLY-rendered dialog, not a half-drawn transitional frame.
    await d.ctrl("k")
    const open = await d.waitForFrame((f) => /esc close/.test(f), 6000)
    a.has(open, /Commands/, "Ctrl+K pushes the palette mode (the command dialog opens)")

    // SCOPED: press `n` — the BASE "new session" key. If base nav still fired under the dialog, it
    // would spawn a chat session and jump to the composer ("message kimi"). Under the mode stack
    // `n` is NOT a palette binding, so it does NOT fire the base action — it feeds the dialog filter
    // instead. The palette STAYS open and NO chat composer appears. (We wait for the filter to
    // settle to "New session" only — a stable post-keystroke frame — then assert the negative.)
    await d.type("n")
    const scoped = await d.waitForFrame((f) => /New session/.test(f) && /esc close/.test(f), 6000)
    a.has(scoped, /esc close/, "base `n` did NOT quit/leave the dialog — the palette stays open (key scoped to the dialog)")
    a.hasNot(scoped, /message kimi/, "base `n` (new session) did NOT fire under the palette mode — no chat composer appeared")

    // POP: esc fires the palette-mode `esc` binding → the dialog closes, the mode pops back to base.
    await d.key("Escape")
    const closed = await d.waitForFrame((f) => !/esc close/.test(f) && /no sessions|SESSIONS/i.test(f), 6000)
    a.hasNot(closed, /Commands/, "esc (a palette-mode binding) closes the dialog and pops the mode")

    // RESTORED: with the mode popped back to base, `n` fires the BASE "new session" action again —
    // proof the base binding wasn't deleted, just SCOPED while the dialog mode was on top.
    await d.type("n")
    const restored = await d.waitForFrame((f) => /message kimi/.test(f), 8000)
    a.has(restored, /message kimi/, "after the pop, base `n` fires the new-session action again (scope restored)")
  } finally {
    await d.stop()
  }
})
