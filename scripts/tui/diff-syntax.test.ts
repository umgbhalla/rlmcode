#!/usr/bin/env bun
// FRAME GATE — DIFF VIEWER, FILETYPE-GENERAL SYNTAX (the matured edit diff renders ANY language
// through opentui's NATIVE <diff>, not a TS-hardcoded path).
//
// diff-viewer.test.ts already pins the native render (line-number + -/+ gutter + sign-stripped
// content) + split/unified-by-width over the .ts edit + the write. This gate adds the missing
// claim the SPEC emphasises — "syntax-highlighted" — by proving the SAME native renderer is
// FILETYPE-GENERAL: the mock_diff cluster also carries a .py edit (mock.ts MOCK_DIFF_TOOLS / df_py),
// and the .py filetype runs through the SAME populated SyntaxStyle (theme.makeSyntaxStyle, the
// highlighter the reply <markdown> uses) as .ts — the renderer keys on the file extension, it does
// not special-case TypeScript. A captured frame can't compare cell COLOUR, so the syntax claim
// lands as the STRUCTURAL native render of a non-TS language: a Python edit shows the native
// numbered-gutter -/+ shape, NOT the crude sign-glued <text> LCS fallback. The fallback would
// render "-     return …" with NO line number and the sign glued to the content; the native <diff>
// draws the line number, then the sign, then the stripped content, so the "<n> -  <content>" shape
// over Python source is an unambiguous native-renderable-only marker.
//   WHY a separate file (not another case in diff-viewer.test): that file's settled-wait gates on
// the .ts edit + the write hunks; this gate gates on the .py hunk specifically, so the two assert
// DISJOINT slices of the same canned render and a layout shift in one can't silently mask the
// other. Drives the REAL turn loop + activity bus + atoms node-routing + tool-view.tsx ToolBody →
// the native opentui <diff>; ONLY the per-tool feed is mocked. Waits are frame-stable (waitFor over
// captured text), never setTimeout-then-assert.
import { launchDriver, type Driver } from "./driver.ts"
import { report } from "./assert.ts"

// Drive the diff variant and return a settled frame carrying the COMPLETE .py edit diff. A native
// <diff> lays its lines out asynchronously, so gating on the LAST line of the .py hunk pins the
// fully-laid-out render before any assert runs (de-flake: one fully-settled frame, never a
// partially-laid-out one). The list wait gets a generous deadline so a slow PTY mount doesn't read
// as a real failure (the mount race is pure flake; the content asserts run only after it settles).
const driveDiff = async (d: Driver): Promise<string> => {
  await d.waitFor((f) => /no sessions/.test(f), { label: "list", timeoutMs: 20000 })
  await d.type("n")
  await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
  await d.type("show me a diff please")
  await d.key("Enter")
  // Expand the turn STEPS (W1 overhaul: a node's tools moved to its detail pane, so the native
  // <diff> now rides the main turn's own steps under the collapsed "▸ N steps" header).
  await d.waitFor((f) => /❯ ▸ \d+ steps/.test(f), { label: "settled turn steps header focused", timeoutMs: 40000 })
  await d.key("Enter")
  return d.waitFor(
    (f) =>
      /Update\(src\/greet\.py\)/.test(f) &&
      /2 -\s+return "hi " \+ name/.test(f) &&
      /2 \+\s+return "hello, " \+ name/.test(f),
    { label: "settled native .py diff (hunk complete)", timeoutMs: 40000 },
  )
}

// ── FILETYPE-GENERAL (a .py edit renders through the SAME native <diff> as the .ts edit) ──────────
await report("diff-syntax.test (python)", async (a) => {
  const d = await launchDriver({ cols: 100, rows: 44 })
  try {
    const f = await driveDiff(d)

    // The .py edit gets its own native diff body, headed by the Update(.py) label — proof the
    // renderer is keyed on the file (its extension), not a single hardcoded TS diff.
    a.has(f, /Update\(src\/greet\.py\)/, "the .py edit renders its own native <diff> body (filetype-general, not TS-only)")

    // NATIVE RENDER over PYTHON source — a numbered CONTEXT line, then the removed + added line each
    // as line-number + -/+ gutter + content with the leading sign STRIPPED. The leading digit before
    // the sign is the discriminator: the crude <text> fallback has NO line number.
    a.has(f, /1\s+def greet\(name\):/, "native .py diff shows a numbered CONTEXT line (the unchanged def)")
    a.has(f, /2 -\s+return "hi " \+ name/, "native .py diff shows the removed line: line-number + '-' gutter + stripped Python content")
    a.has(f, /2 \+\s+return "hello, " \+ name/, "native .py diff shows the added line: line-number + '+' gutter + stripped Python content")

    // CRUDE-FALLBACK NEGATIVE — the crude <text> fallback rendered a changed line with the sign at
    // the LINE START and NO line number ("│ " gutter / a bare "-…"); the native render ALWAYS draws
    // the line number FIRST, then the sign. So the .py change must NEVER appear sign-first with no
    // preceding digit. The positive assertions above already require the leading "2" before the
    // sign, which the crude fallback cannot emit; this pins the absence of the old shape directly.
    a.hasNot(f, /^\s*[-+]\s+return "h(i|ello)" \+ name/m, "the crude line-start-sign LCS <text> preview is GONE for .py (native <diff> renders the line number first)")

    // MULTI-LANGUAGE IN ONE RENDER — the .ts edit and the .py edit BOTH render their native diffs in
    // the same settled frame, proving the renderer handles a heterogeneous cluster (not one global
    // hardcoded filetype). This is the broader "filetype-driven" landing.
    a.has(f, /Update\(src\/greet\.ts\)/, "the .ts edit also renders natively in the same frame (mixed-language cluster)")
    a.has(f, /2 \+\s+const msg = "hello, " \+ name/, "the .ts edit's native added line renders alongside the .py edit (one frame, two languages)")
  } finally {
    await d.stop()
  }
})
