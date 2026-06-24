#!/usr/bin/env bun
// FRAME GATE — DIFF VIEWER (the matured edit/write diff: opentui's NATIVE <diff> renderable).
//
// Drives the DIFF variant of the mock (mock-ai.ts wantsDiff → the mock calls the test-only
// `mock_diff` tool, which replays a settled edit_file + write_file cluster owned by ONE still-
// running `editor` subagent NODE). Through the REAL turn loop + activity bus + atoms node-routing,
// the file-mutation tools render via tool-view.tsx ToolBody → opentui's NATIVE <diff> (Diff.ts),
// so the CAPTURED settled FRAME proves the diff-viewer SPEC, NOT the old crude LCS <text> block:
//   (1) NATIVE RENDER — each changed line carries a LINE NUMBER + a separate -/+ gutter sign, with
//       the line content shown WITH THE LEADING SIGN STRIPPED (Diff.ts buildLineMetadata: content =
//       line.slice(1); sign drawn after the line number). The crude <text> fallback glued the sign
//       to the content ("- const …") and had NO line numbers, so the "<n> -  <content>" shape is an
//       unambiguous native-<diff>-only marker.
//   (2) SYNTAX — the .ts filetype runs the diff through the populated SyntaxStyle (theme.makeSyntax
//       Style), the same highlighter the reply <markdown> uses (theme.test pins the wiring; a frame
//       can't compare cell color, so the syntax assertion is the structural render landing).
//   (3) SPLIT vs UNIFIED by WIDTH — cols>120 ⇒ a two-pane SPLIT (old | new on the SAME row); else a
//       single-column UNIFIED (interleaved -/+). Two driver launches (cols 100 + 140) pin the gate.
//   (4) WRITE — write_file renders as a native all-add diff (every line a "+" with a line number).
// The diff body renders inline by DEFAULT (opencode shows the diff inline; a block tool shows its
// body and the running `editor` node stays expanded), so the core assertion needs no expansion; a
// Tab then proves the diff row is a live, focusable Tab-ring member (the diff stays rendered under
// focus). orch.ts/atoms/toolui are driven for real; ONLY the per-tool feed is mocked. Waits are
// frame-stable (waitFor over captured text), never setTimeout-then-assert.
import { launchDriver, type Driver } from "./driver.ts"
import { report } from "./assert.ts"

// Drive the diff variant and return the settled frame carrying both file mutations' native diffs.
const driveDiff = async (d: Driver): Promise<string> => {
  await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
  await d.type("n")
  await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
  await d.type("show me a diff please")
  await d.key("Enter")
  // The matured diff rows live under the COLLAPSED "▸ N steps" header (the W1 overhaul made a node's
  // tools render in its detail pane, so the main turn's own STEPS carry the native <diff>). The focus
  // ring starts on turn:0 (the steps header), so Enter on the settled turn opens it.
  await d.waitFor((f) => /❯ ▸ \d+ steps/.test(f), { label: "settled turn steps header focused", timeoutMs: 40000 })
  await d.key("Enter")
  // Gate on a fully-settled frame carrying the WHOLE diff render at once: the edit row header, BOTH
  // of the edit's native -/+ lines (line-number + sign + stripped content), the edit's trailing
  // context, the write header, AND BOTH of the write's all-add lines. A native <diff> lays its lines
  // out asynchronously, so a transitional frame can carry only the FIRST line of a hunk; gating on
  // the LAST line of each diff pins the COMPLETE render before any assert runs (de-flake: wait for
  // one fully-settled frame, never a partially-laid-out one).
  return d.waitFor(
    (f) =>
      /Update\(src\/greet\.ts\)/.test(f) &&
      /2 -\s+const msg = "hi " \+ name/.test(f) &&
      /2 \+\s+const msg = "hello, " \+ name/.test(f) &&
      /3\s+return msg/.test(f) &&
      /Write\(src\/version\.ts\)/.test(f) &&
      /1 \+\s+export const VERSION = "0\.0\.1"/.test(f) &&
      /2 \+\s+export const NAME = "rlmcode"/.test(f),
    { label: "settled native diff (edit + write, both hunks complete)", timeoutMs: 40000 },
  )
}

// ── UNIFIED (cols 100 ≤ 120 ⇒ single-column interleaved -/+) ──────────────────────────────────────
await report("diff-viewer.test (unified)", async (a) => {
  const d = await launchDriver({ cols: 100, rows: 44 })
  try {
    const f = await driveDiff(d)

    // (1) NATIVE RENDER — the edit's changed line shows as a LINE-NUMBER + -/+ gutter + stripped
    // content (the native <diff> shape). The leading digit before the sign is the discriminator: the
    // crude <text> fallback rendered "- const …" with NO line number, so this can ONLY be the native
    // renderable. Context lines also carry their line number.
    a.has(f, /1\s+export function greet\(name: string\) \{/, "native diff shows a numbered CONTEXT line")
    a.has(f, /2 -\s+const msg = "hi " \+ name/, "native diff shows the removed line: line-number + '-' gutter + stripped content")
    a.has(f, /2 \+\s+const msg = "hello, " \+ name/, "native diff shows the added line: line-number + '+' gutter + stripped content")
    a.has(f, /3\s+return msg/, "native diff keeps the trailing context (the edit is minimal, not a whole-block rewrite)")

    // CRUDE-FALLBACK NEGATIVE — the old hand-rolled preview rendered the changed line as a SIGN-GLUED
    // "- const msg …" / "+ const msg …" with NO line number. The native render never glues the sign to
    // the content, so neither sign-glued form may appear (this is the "not the crude block" assertion).
    a.hasNot(f, /[-+] const msg = "h(i|ello)/, "the crude sign-glued LCS <text> preview is GONE (native <diff> replaced it)")

    // (4) WRITE — write_file is a native ALL-ADD diff (every line a numbered '+').
    a.has(f, /1 \+\s+export const VERSION = "0\.0\.1"/, "write_file renders as a native all-add diff (numbered '+' lines)")
    a.has(f, /2 \+\s+export const NAME = "rlmcode"/, "write_file's second added line also renders in the native diff")

    // FOCUSABLE ROW — the edit (diff) row joins the Tab focus ring (it's an interactive, drill-down
    // row, not static text). Tab rings focus onto it (the ❯ gutter); waitFor gates the step so the
    // assertion reads a committed focus frame (no read-then-act race). The diff body itself renders
    // inline by default (opencode shows the diff inline), so this proves the row is live, not collapsed.
    let tabs = 0
    for (; tabs < 12; tabs++) {
      await d.key("Tab")
      const ok = await d
        .waitFor((g) => /❯ .*Update\(src\/greet\.ts\)/.test(g), { timeoutMs: 1500, label: "edit focused" })
        .then(() => true)
        .catch(() => false)
      if (ok) break
    }
    a.ok(tabs < 12, "Tab rings focus onto the edit (diff) row (❯ gutter)")
    // The native diff is STILL shown while the row is focused (it renders inline, not behind a toggle).
    const focused = await d.waitFor((g) => /❯ .*Update\(src\/greet\.ts\)/.test(g), { label: "edit row focused", timeoutMs: 8000 })
    a.has(focused, /2 \+\s+const msg = "hello, " \+ name/, "the native diff stays rendered inline under the focused edit row")
  } finally {
    await d.stop()
  }
})

// ── SPLIT (cols 140 > 120 ⇒ two side-by-side panes, old | new) ────────────────────────────────────
await report("diff-viewer.test (split)", async (a) => {
  const d = await launchDriver({ cols: 140, rows: 44 })
  try {
    const f = await driveDiff(d)

    // (3) SPLIT — at cols>120 the diff is a TWO-PANE split: the removed (old) line and the added (new)
    // line render on the SAME row (left pane | right pane). The crude <text> fallback AND the unified
    // view are single-column and can NEVER put both contents on one line, so this is the split-proof.
    a.has(f, /hi " \+ name.*hello, " \+ name/, "split view renders the old (left) + new (right) line on the SAME row")
    // Both panes carry their own line numbers + gutter signs (native split render).
    a.has(f, /2 -\s+const msg = "hi " \+ name.*2 \+\s+const msg = "hello, " \+ name/, "split panes each carry a line-number + -/+ gutter")
    // A context line is mirrored across BOTH panes (same content twice on one row) — split-only.
    a.has(f, /export function greet\(name: string\) \{.*export function greet\(name: string\) \{/, "split view mirrors a context line across both panes")
  } finally {
    await d.stop()
  }
})
