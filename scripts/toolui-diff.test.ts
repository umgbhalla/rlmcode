#!/usr/bin/env bun
// Self-check for the LCS line diff (toolui.lcsDiffLines) — the non-trivial logic behind the
// edit-tool diff preview. Plain asserts, no framework (ax2 style). Pins that a small change
// renders as context + minimal -/+, NOT a whole-block rewrite (the bug the LCS replaced).
import { lcsDiffLines } from "../src/toolui.ts"

let failed = 0
const eq = (got: string, want: string, msg: string) => {
  if (got !== want) {
    console.error(`  FAIL: ${msg}\n      got:  ${got}\n      want: ${want}`)
    failed++
  }
}

// 1-line change in a 3-line block: 2 lines stay context, 1 del + 1 add (not a full rewrite).
eq(lcsDiffLines(["a", "b", "c"], ["a", "B", "c"]).join("|"), " a|-b|+B| c", "single-line change keeps context")
eq(lcsDiffLines(["a", "c"], ["a", "b", "c"]).join("|"), " a|+b| c", "pure insert")
eq(lcsDiffLines(["a", "b", "c"], ["a", "c"]).join("|"), " a|-b| c", "pure delete")
eq(lcsDiffLines(["x", "y"], ["x", "y"]).join("|"), " x| y", "identical → all context, no -/+")
eq(lcsDiffLines([""], ["one", "two"]).join("|"), "-|+one|+two", "empty → new content")

if (failed > 0) {
  console.error(`toolui-diff.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("toolui-diff.test: all pass ✓")
