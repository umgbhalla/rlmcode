// @effect/vitest port of scripts/toolui-diff.test.ts — self-check for the LCS line diff
// (toolui.lcsDiffLines) + the edit-tool diff plumbing (toolDiff → the native <diff> patch;
// toolPreview → the tiny text fallback). Pins that a small change renders as context + minimal
// -/+, NOT a whole-block rewrite, AND that the fallback is itself a minimal diff.
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { lcsDiffLines, toolDiff, toolPreview } from "../src/tui/toolui.ts"

it.effect("lcsDiffLines: minimal context + -/+ (single change, insert, delete, identical, empty)", () =>
  Effect.sync(() => {
    expect(lcsDiffLines(["a", "b", "c"], ["a", "B", "c"]).join("|"), "single-line change keeps context").toBe(" a|-b|+B| c")
    expect(lcsDiffLines(["a", "c"], ["a", "b", "c"]).join("|"), "pure insert").toBe(" a|+b| c")
    expect(lcsDiffLines(["a", "b", "c"], ["a", "c"]).join("|"), "pure delete").toBe(" a|-b| c")
    expect(lcsDiffLines(["x", "y"], ["x", "y"]).join("|"), "identical → all context, no -/+").toBe(" x| y")
    expect(lcsDiffLines([""], ["one", "two"]).join("|"), "empty → new content").toBe("-|+one|+two")
  }),
)

it.effect("toolDiff (edit_file) → a real unified patch; null for a non-mutation tool", () =>
  Effect.sync(() => {
    const ed = toolDiff("edit_file", JSON.stringify({ path: "x.ts", old_string: "a\nb\nc", new_string: "a\nB\nc" }), false)
    expect(ed !== null, "toolDiff returns a patch for edit_file").toBe(true)
    expect(!!ed && ed.diff.startsWith("--- a/x.ts\n+++ b/x.ts\n@@ "), "toolDiff emits a real unified-diff header + hunk").toBe(true)
    expect(!!ed && ed.diff.includes("\n-b\n+B\n") && ed.filetype === "ts", "toolDiff body is the minimal LCS -/+ with the file's type").toBe(true)
    expect(toolDiff("bash", JSON.stringify({ command: "ls" }), false), "toolDiff is null for a non-mutation tool").toBe(null)
  }),
)

it.effect("toolPreview (edit_file) tiny fallback is a minimal LCS diff, not a block dump", () =>
  Effect.sync(() => {
    const fb = toolPreview("edit_file", JSON.stringify({ old_string: "a\nb\nc", new_string: "a\nB\nc" }), "updated", false)
    expect(fb.map((p) => `${p.tone[0]}${p.text}`).join("|"), "edit fallback is a minimal LCS diff (context dim, b→del, B→add)").toBe("da|db|aB|dc")
  }),
)
