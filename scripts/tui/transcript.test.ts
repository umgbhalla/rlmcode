#!/usr/bin/env bun
// FRAME GATE — TRANSCRIPT MATURITY (the matured tool render + reasoning-collapse).
//
// Drives the TRANSCRIPT variant of the mock (mock-ai.ts wantsTranscript → the mock calls the
// test-only `mock_transcript` tool, which replays a per-tool cluster as the MAIN TURN's own steps):
// a SETTLED multi-line bash, a SETTLED read_file, a SETTLED FAILED bash, and a RUNNING grep (a
// tool CALL with no result). The W1 render overhaul moved a NODE's tools out of the tree into its
// detail pane, so the matured block/collapse/✗-card render is now the MAIN-TURN surface — these
// land as turn STEPS. Expanding the turn (Enter on the steps header) reveals them via the MATURED
// proves the three render MODES + the output-collapse + the reasoning-collapse the SPEC asks for:
//   (1) INLINE — the running grep is a dim one-line "Search(TODO)  running…" with NO body; a
//       SETTLED read_file is likewise inline ("Read(src/big.ts)  12 lines") — its summary says
//       it all, so it gets no body (opencode renders Read/Glob/Grep as InlineTool).
//   (2) BLOCK  — a settled bash (Shell) is a row + a COLLAPSED stdout body (opencode BlockTool),
//       shown by default with a "▸" expander to reveal the rest.
//   (3) ERROR  — the failed bash is a RED ✗ card carrying its "exit 127" Shell detail.
//   (4) COLLAPSE — the 12-line bash body caps at 10 lines + "… +2 more" (Shell cap 10) by DEFAULT.
//   (5) REASONING-COLLAPSE — the settled reply's reasoning folds to "▸ Thought · <duration>".
// Then a Tab→Enter EXPANDS the bash block to prove the collapse is EXPANDABLE (the hidden lines
// 11-12 reveal). orch.ts/atoms/toolui are driven for real; ONLY the per-tool feed is mocked.
// Waits are frame-stable (waitFor over captured text), never setTimeout-then-assert.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("transcript.test", async (a) => {
  const d = await launchDriver({ rows: 44 })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── drive the TRANSCRIPT variant: the per-tool cluster as the main turn's STEPS ──────────
    await d.type("show the transcript demo")
    await d.key("Enter")
    // The matured tool rows live under the COLLAPSED "▸ N steps" header — expand it first. The
    // focus ring starts on turn:0 (the steps header), so Enter on the settled turn opens it.
    await d.waitFor((f) => /❯ ▸ \d+ steps/.test(f), { label: "settled turn steps header focused", timeoutMs: 40000 })
    await d.key("Enter")
    // Gate on a fully-settled frame carrying EVERY mode at once: the bash collapse footer (+2
    // more), the inline read row, the settled error row, AND the still-running inline grep. A
    // transitional frame would miss one, so this single predicate pins the whole matured render
    // before we assert (de-flake: assert one stable frame, not a moving target).
    const settled = await d.waitFor(
      (f) =>
        /\$ Bash\(seq 12\)/.test(f) &&
        /\+2 more/.test(f) &&
        /Read\(src\/big\.ts\)\s+12 lines/.test(f) &&
        /✗ Bash\(missing-bin\)\s+error/.test(f) &&
        /Search\(TODO\)\s+running/.test(f),
      { label: "settled tool cluster (all modes + collapse)", timeoutMs: 40000 },
    )

    // (1) INLINE — the running grep AND the settled read_file are dim one-liners with NO body.
    a.has(settled, /⠋?\s*Search\(TODO\)\s+running/, "a RUNNING tool renders as an inline 'running…' line")
    a.hasNot(settled, /Search\(TODO\).*▸/, "the running inline tool has NO ▸ expander / body")
    a.has(settled, /→ Read\(src\/big\.ts\)\s+12 lines/, "a settled read_file is an inline row showing its 12-line count (summary, no body)")
    a.hasNot(settled, /Read\(src\/big\.ts\).*▸/, "the inline read_file has NO ▸ expander / body (its summary says it all)")

    // (2) BLOCK — the settled bash renders as a row with a "▸" expander + a collapsed stdout body.
    a.has(settled, /\$ Bash\(seq 12\)\s+12 lines.*▸/, "a settled bash renders as a BLOCK row (12 lines + ▸ expander)")

    // (3) ERROR — the failed bash is a RED ✗ card carrying its Shell exit detail.
    a.has(settled, /✗ Bash\(missing-bin\)\s+error\s+exit 127/, "a failed tool renders as a ✗ error card with its 'exit 127' Shell detail")
    a.hasNot(settled, /✗ Read\(/, "a successful tool row is NOT marked as an error")

    // (4) COLLAPSE — the bash body caps at 10 lines + "… +2 more" (Shell cap 10) by default. The
    // cap + footer are the SPEC's "3 lines + +N more, Shell 10" (Shell variant shown here).
    a.has(settled, /line 10/, "the bash block shows up to line 10 (Shell cap 10)")
    a.has(settled, /… \+2 more/, "the bash output collapses the rest behind a '+2 more' footer")
    a.hasNot(settled, /line 12/, "lines past the Shell cap are hidden behind the '+2 more' footer (collapsed by default)")

    // (5) REASONING-COLLAPSE — the settled reply's reasoning folds to a "▸ Thought · <duration>"
    // header (the body hidden by default); the duration summary proves it settled.
    a.has(settled, /▸ Thought · \d/, "the settled reasoning folds to a collapsed 'Thought · <duration>' header")

    // EXPANDABLE — Tab rings focus onto the bash row (turn:0 then its tool steps), then
    // Enter toggles it OPEN, revealing the hidden lines 11-12. waitFor (a STABLE frame) gates each
    // step so Enter acts on the committed focus state (no read-then-act race).
    let tabs = 0
    for (; tabs < 8; tabs++) {
      await d.key("Tab")
      const ok = await d
        .waitFor((f) => /❯ \$ Bash\(seq 12\)/.test(f), { timeoutMs: 1500, label: "bash focused" })
        .then(() => true)
        .catch(() => false)
      if (ok) break
    }
    a.ok(tabs < 8, "Tab rings focus onto the settled bash row (❯ gutter)")
    await d.key("Enter")
    const expanded = await d.waitFor((f) => /line 12/.test(f), { label: "expanded bash body reveals line 12", timeoutMs: 8000 })
    a.has(expanded, /line 11/, "expanding the bash block reveals the previously-hidden line 11")
    a.has(expanded, /line 12/, "expanding the bash block reveals the previously-hidden line 12")
    a.hasNot(expanded, /… \+2 more/, "the '+2 more' footer is gone once the bash block is fully expanded")
  } finally {
    await d.stop()
  }
})
