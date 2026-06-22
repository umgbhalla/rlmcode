#!/usr/bin/env bun
// FRAME GATE — TURN-STEP TOOL GROUPING (the gap the per-node tool-grouping.test never hits).
//
// `tool-grouping.test.ts` exercises PER-NODE tools (read/glob/grep routed UNDER an orch node),
// NOT turn steps. chat.tsx's groupSteps()/groupSummary() (the "⊙ explored N" collapse) only
// runs over a TURN's own steps — tools with NO nodeId that land in the main transcript. The
// mock never drove multiple consecutive explore tools into a single turn, so that render path
// was untested: a bug in groupSteps() (run detection, single-unwrap) or groupSummary() (the
// "N (a read · b glob · c grep)" tally) would ship green.
//
// This test drives the GROUP variant of the mock (mock-ai.ts wantsGroup → an "explore" user
// turn fans out read_file → glob → grep as THREE consecutive turn steps in ONE tool-loop step;
// the unsandboxed BASE_TOOLS run for real over this repo, so each settles status:"ok"). We
// expand the turn's steps and assert the CAPTURED FRAME collapses the three into a single
// "⊙ explored 3 (1 read · 1 glob · 1 grep)" row — NOT three individual Read/Search rows.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("tool-grouping-steps.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── drive the GROUP variant: an "explore" turn → read/glob/grep cluster as turn steps ─
    await d.type("explore the repo")
    await d.key("Enter")
    // The turn settles when the canned final reply lands AND the collapsed steps header shows
    // all three steps ("▸ 3 steps"). Wait for the header, not just the reply, so the steps are
    // present before we expand.
    await d.waitFor((f) => /3 steps/.test(f) && /Done\./.test(f), { label: "3-step turn", timeoutMs: 40000 })

    // ── expand the turn's steps: Tab rings the turn header (first focusable), Enter toggles ─
    await d.key("Tab")
    await d.waitFor((f) => /❯.*steps|❯/.test(f), { label: "turn header ringed" })
    await d.key("Enter")
    const frame = await d.waitFor((f) => /▾ 3 steps/.test(f) && /explored/.test(f), { label: "expanded group", timeoutMs: 8000 })

    // ── the three explore steps collapse into ONE grouped row (the groupSteps/groupSummary
    // path), with the per-kind tally — NOT three individual tool rows. ────────────────────
    a.has(frame, /⊙ explored 3 \(1 read · 1 glob · 1 grep\)/, "the read/glob/grep cluster collapses into one '⊙ explored 3 (1 read · 1 glob · 1 grep)' row")

    // ── grouping replaced the individual rows: no standalone Read(AGENTS.md)/Search rows for
    // the grouped tools (they live inside the collapsed summary, not as their own lines). ──
    a.hasNot(frame, /→ Read\(AGENTS\.md\)/, "the grouped read step does NOT also render as its own Read(...) row")
    a.hasNot(frame, /→ Search\(/, "the grouped glob/grep steps do NOT also render as their own Search(...) rows")
  } finally {
    await d.stop()
  }
})
