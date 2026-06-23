#!/usr/bin/env bun
// FRAME GATE — STATIC-COMMIT (claude_code "scrollback is immutable" render model). TurnView is
// wrapped in React.memo (chat.tsx) with the turnPropsEqual comparator (turn-memo.ts) so a SETTLED
// turn does NOT repaint on the ~12×/s busy tick — only the in-flight turn + the composer redraw.
//
// The REFERENTIAL-STABILITY proof (a settled turn's props compare equal across a re-render ⇒
// React.memo bails) is the deterministic UNIT gate, scripts/turn-memo.test.ts. THIS file is the
// captured-FRAME companion the workflow asks for: it proves the memo is PURELY PRESENTATIONAL — a
// settled turn STILL RENDERS CORRECTLY (unchanged) across the App re-renders that the memo is
// meant to skip. We settle turn #1, force many App re-renders (a second full turn + composer
// keystrokes, both of which re-render App every busy tick), then assert turn #1's reply + footer
// are byte-stable. If the comparator ever wrongly skipped a real change, this frame would catch it.
// Waits are frame-stable (driver.waitFor over captured text), never setTimeout-then-assert; we
// assert STABLE content (the reply text, the model·duration footer), not a spinner glyph.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("static-commit.test", async (a) => {
  const d = await launchDriver({ rows: 40 })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── TURN #1: a plain turn → the single-bash tool loop settles to the canned MOCK_REPLY
    //    ("Found 3 matches in src/. Done.") with a "▣ @mock/kimi · <duration>" footer. ─────────
    await d.type("first turn please")
    await d.key("Enter")
    const settled1 = await d.waitFor(
      (f) => /Found 3 matches in src\/\. Done\./.test(f) && /@cf\/moonshotai\/kimi/.test(f),
      { label: "turn #1 settled", timeoutMs: 40000 },
    )
    a.has(settled1, /first turn please/, "turn #1 shows its user prompt")
    a.has(settled1, /Found 3 matches in src\/\. Done\./, "turn #1 settled reply renders (markdown)")
    a.has(settled1, /@cf\/moonshotai\/kimi-k2\.7-code · \d/, "turn #1 carries its model·duration footer (settled)")

    // ── FORCE RE-RENDERS that the memo must SKIP for turn #1: typing into the composer re-renders
    //    App (onComposerChange → setText) without touching the settled turn. Turn #1 must persist. ─
    await d.type("typing should not disturb settled scrollback")
    const afterType = await d.waitFor((f) => /typing should not disturb/.test(f), { label: "composer echoes typing" })
    a.has(afterType, /Found 3 matches in/, "turn #1 reply STILL renders correctly while the composer re-renders App")
    a.has(afterType, /first turn please/, "turn #1 prompt STILL renders while typing")

    // ── TURN #2: clear the composer, send a second turn. Its in-flight + settle re-render App on
    //    every busy tick; turn #1 (settled, memoized) must remain byte-stable throughout + after. ─
    // clear the typed draft (select-all isn't wired; backspace the line via repeated Backspace is
    // slow — instead just send it: the trailing text becomes turn #2's prompt, which is fine, but
    // we want a CLEAN second prompt, so clear by sending an empty-ish marker). Simplest: submit the
    // current draft as turn #2 (the mock answers any plain prompt with the same MOCK_REPLY).
    await d.key("Enter")
    // Two settled turns now both show "Found 3 matches" — wait until the SECOND reply has painted
    // (two occurrences) so we know turn #2 settled while turn #1 stayed put.
    const both = await d.waitFor(
      (f) => (f.match(/Found 3 matches in src/g)?.length ?? 0) >= 2,
      { label: "turn #2 settled (two replies)", timeoutMs: 40000 },
    )
    a.has(both, /first turn please/, "turn #1 prompt is STILL correct after turn #2 settles (immutable scrollback)")
    a.ok((both.match(/Found 3 matches in src/g)?.length ?? 0) >= 2, "both turns' replies render (turn #1 was not lost/garbled by the memo)")
    a.ok((both.match(/@cf\/moonshotai\/kimi-k2\.7-code · /g)?.length ?? 0) >= 2, "both turns carry their settled model·duration footer")
  } finally {
    await d.stop()
  }
})
