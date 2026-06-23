#!/usr/bin/env bun
// Self-check for the LCS line diff (toolui.lcsDiffLines) + the edit-tool diff plumbing
// (toolDiff → the native <diff> patch; toolPreview → the tiny text fallback). Plain asserts, no
// framework (rlmcode style). Pins that a small change renders as context + minimal -/+, NOT a
// whole-block rewrite (the bug the LCS replaced), AND that the fallback is itself a minimal diff.
import { lcsDiffLines, toolDiff, toolPreview } from "../src/tui/toolui.ts"

let failed = 0
const eq = (got: string, want: string, msg: string) => {
  if (got !== want) {
    console.error(`  FAIL: ${msg}\n      got:  ${got}\n      want: ${want}`)
    failed++
  }
}
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

// 1-line change in a 3-line block: 2 lines stay context, 1 del + 1 add (not a full rewrite).
eq(lcsDiffLines(["a", "b", "c"], ["a", "B", "c"]).join("|"), " a|-b|+B| c", "single-line change keeps context")
eq(lcsDiffLines(["a", "c"], ["a", "b", "c"]).join("|"), " a|+b| c", "pure insert")
eq(lcsDiffLines(["a", "b", "c"], ["a", "c"]).join("|"), " a|-b| c", "pure delete")
eq(lcsDiffLines(["x", "y"], ["x", "y"]).join("|"), " x| y", "identical → all context, no -/+")
eq(lcsDiffLines([""], ["one", "two"]).join("|"), "-|+one|+two", "empty → new content")

// toolDiff (edit_file) → a unified patch fed to the native <diff>: real ---/+++ headers + a hunk
// + the LCS body (context kept, one -/+). This is the PRIMARY diff render (native), not text.
const ed = toolDiff("edit_file", JSON.stringify({ path: "x.ts", old_string: "a\nb\nc", new_string: "a\nB\nc" }), false)
ok(ed !== null, "toolDiff returns a patch for edit_file")
ok(!!ed && ed.diff.startsWith("--- a/x.ts\n+++ b/x.ts\n@@ "), "toolDiff emits a real unified-diff header + hunk")
ok(!!ed && ed.diff.includes("\n-b\n+B\n") && ed.filetype === "ts", "toolDiff body is the minimal LCS -/+ with the file's type")
// A non-mutation tool has no diff (native <diff> is edit/write only).
ok(toolDiff("bash", JSON.stringify({ command: "ls" }), false) === null, "toolDiff is null for a non-mutation tool")

// TINY FALLBACK (toolPreview edit_file, hit only when the diff is too big for the native renderer):
// a MINIMAL LCS diff — context dim, the changed line as one del + one add — NOT the old whole-block
// del+add dump (every old line then every new line). The leading sign is stripped (tone carries it).
const fb = toolPreview("edit_file", JSON.stringify({ old_string: "a\nb\nc", new_string: "a\nB\nc" }), "updated", false)
eq(fb.map((p) => `${p.tone[0]}${p.text}`).join("|"), "da|db|aB|dc", "edit fallback is a minimal LCS diff (context dim, b→del, B→add), not a block dump")

if (failed > 0) {
  console.error(`toolui-diff.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("toolui-diff.test: all pass ✓")
