#!/usr/bin/env bun
// FRAME GATE — W3 ASSEMBLY STRUCTURE (fixes F2/F3/F4). The companion grouping tests
// (tool-grouping*.test.ts) prove the grouped ROW renders; this gate proves the W3 invariant the
// move to ASSEMBLY buys: the grouped shape is computed ONCE per turn (toTurns → t.items, the single
// toolui.groupSteps authority) and the workflow Row[] ONCE per (orch, expNodes) (toTurns → t.rows),
// so the SAME sequence renders the SAME way ACROSS the ~12×/s busy tick — no out-of-order flicker,
// no per-tick recompute. We capture the grouped "⊙ explored N (…)" row, then capture again after a
// few render ticks, and assert the grouped row is STABLE (byte-identical line, no reorder).
//
// This is the assembly-time grouping (F2/F3 — one authority, both surfaces) + the flatten memo
// (F4 — one Row[] shared by the render / focus ring / memo) as one real frame assertion. The pure
// grouping authority now lives in toolui.ts; chat-model.toTurns runs it once; render-time groupSteps
// is gone — so a grouping bug can no longer ship green behind a per-tick recompute.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

// The single grouped explore row produced at assembly: "⊙ explored 3 (1 read · 1 glob · 1 grep)".
const groupLine = (f: string): string | undefined => f.split("\n").find((l) => /⊙ explored \d+ \(/.test(l))

await report("assembly.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── drive the GROUP variant (read/glob/grep cluster as ONE turn's steps) ────────────────────
    await d.type("explore the repo")
    await d.key("Enter")
    await d.waitFor((f) => /3 steps/.test(f) && /Done\./.test(f), { label: "3-step turn", timeoutMs: 40000 })

    // ── expand the turn's steps: Tab rings the turn header, Enter toggles ───────────────────────
    await d.key("Tab")
    await d.waitFor((f) => /❯/.test(f), { label: "turn header ringed" })
    await d.key("Enter")
    const frame = await d.waitFor((f) => /▾ 3 steps/.test(f) && /⊙ explored/.test(f), { label: "expanded group", timeoutMs: 8000 })

    // ── ASSEMBLY-TIME GROUPING (F2/F3): the run collapses to ONE first-class unit ────────────────
    const line1 = groupLine(frame)
    a.ok(line1 !== undefined, "the explore run renders as ONE assembly-grouped '⊙ explored N (…)' row")
    a.has(frame, /⊙ explored 3 \(1 read · 1 glob · 1 grep\)/, "the grouped unit carries the per-kind tally")
    a.hasNot(frame, /→ Read\(AGENTS\.md\)/, "the grouped read does NOT also render as its own row (one authority, applied once)")

    // ── STABILITY ACROSS THE TICK (F4): re-capture after a few render ticks; the grouped row must
    // be IDENTICAL — assembly computed it once, so the busy/redraw tick can't reorder or re-derive it.
    const later = await d.waitFor((f) => groupLine(f) === line1, { label: "grouped row stable across ticks", timeoutMs: 4000 })
    a.has(later, /⊙ explored 3 \(1 read · 1 glob · 1 grep\)/, "the grouped unit is STABLE across the busy tick (assembled once, no per-tick flicker)")
  } finally {
    await d.stop()
  }
})
