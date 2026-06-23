#!/usr/bin/env bun
// FRAME GATE — THEME. Proves the theme system (src/tui/theme.ts: a termcast-style ResolvedTheme
// token object, a registry of selectable palettes (Catppuccin-Mocha the default), PLUS the syntax-scope SyntaxStyle that
// makes fenced code + markdown + diff render in palette) is correct AND a pure re-skin:
//
//  (1) RENDER UNCHANGED — mount the REAL chat.tsx headlessly (terminal-control PTY + RLM_MOCK
//      mock AI, zero Cloudflare), drive a mock turn, and capture a real frame. Every color attr
//      in chat.tsx / orch-tree.ts resolves through `theme.*`; if the re-shape dropped or renamed
//      a token the components read, those modules wouldn't compile / the frame wouldn't render
//      its known structure. So a frame that still paints the reply + the `│` user row + the status
//      line proves the palette object still backs every render site. (A captured cell grid carries
//      glyphs, not RGB, so the durable FRAME assertion is STRUCTURE, not raw hex.)
//
//  (2) NO INLINE HEX LEFT — grep src/tui for a 6-digit hex literal; the ONLY file allowed to
//      hold raw hex is theme.ts (the single palette source). Any other hit means a color was
//      hard-coded at a call site instead of named by role — the exact smell this step removes.
//
//  (3) SYNTAX-SCOPE WIRING (deterministic, no frame) — the bare SyntaxStyle.create() rlmcode
//      shipped registered NO styles, so highlighted code rendered flat. makeSyntaxStyle() now
//      registers every tree-sitter / markup / diff scope onto the palette. We round-trip it:
//      getStyle(scope).fg back to a hex and compare to the theme token it should resolve to —
//      the exact wiring a frame can't see (a cell grid has glyphs, not RGB). registerStyle/
//      getStyle are real opentui APIs (syntax-style.d.ts), so the assertion is effective.
//
//  (3b) CODE RENDERS — a second "show code" turn returns a fenced ```ts block; the reply
//      <markdown> runs its tree-sitter highlighter through that populated SyntaxStyle. We assert
//      the code body lands in the frame (the render path the bare style left colorless).
//
// Frame-stable waits only (driver.waitFor), never setTimeout-then-assert.
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { rgbToHex } from "@opentui/core"
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"
import {
  DEFAULT_THEME,
  makeSyntaxStyle,
  resolveTheme,
  type ResolvedTheme,
  theme,
  themes,
  THEME_NAMES,
} from "../../src/tui/theme.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..", "..")
const TUI_DIR = join(REPO_ROOT, "src", "tui")
const HEX = /#[0-9a-fA-F]{6}\b/

// Recursively collect every .ts/.tsx under src/tui except theme.ts (the palette home).
const tuiSources = (dir: string): Array<string> => {
  const out: Array<string> = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tuiSources(p))
    else if (/\.tsx?$/.test(e.name) && e.name !== "theme.ts") out.push(p)
  }
  return out
}

await report("theme.test", async (a) => {
  // ── (2) static guard: no inline hex outside theme.ts ────────────────────────────────────
  const offenders = tuiSources(TUI_DIR).filter((f) => HEX.test(readFileSync(f, "utf8")))
  a.ok(offenders.length === 0, `inline hex must live only in theme.ts; offenders: ${offenders.join(", ") || "(none)"}`)

  // ── (1b) THE REGISTRY (deterministic) — DEFAULT_THEME is now a NAME string the resolver maps to
  // a Theme; every palette is COMPLETE (same key set as the default) so a switch can't read an
  // undefined token. The live `theme` boots as the default palette (byte-identical to before). ──
  a.ok(DEFAULT_THEME === "rlmcode-dark", "DEFAULT_THEME is the registry NAME string (not the palette object)")
  a.ok(resolveTheme(DEFAULT_THEME).palette.text === theme.text, "the live `theme` boots as the default palette")
  a.ok(resolveTheme("nope-not-a-theme").name === DEFAULT_THEME, "an unknown name resolves to the default (no crash)")
  a.ok(THEME_NAMES.length >= 3, `registry has >=3 themes (got ${THEME_NAMES.length})`)
  a.ok(THEME_NAMES[0] === DEFAULT_THEME, "the default is first in the ordered name list")
  // COMPLETENESS: every palette must carry the EXACT key set of the default — a missing key is a
  // runtime crash (a reader gets undefined). Compare each theme's keys against rlmcode-dark's.
  const refKeys = Object.keys(resolveTheme(DEFAULT_THEME).palette).toSorted().join(",")
  for (const name of THEME_NAMES) {
    const keys = Object.keys(themes[name]!.palette).toSorted().join(",")
    a.ok(keys === refKeys, `theme "${name}" has the COMPLETE key set (no missing/extra token vs the default)`)
  }

  // ── (3) syntax-scope → theme-token round-trip (deterministic) ────────────────────────────
  // makeSyntaxStyle(palette) must register each scope onto that palette's token. syntaxTokenHex
  // round-trips getStyle(scope).fg back to a hex; compare to the palette hex. Assert it for EVERY
  // registry theme (so the switch genuinely re-skins the highlighter, not just the default).
  for (const name of THEME_NAMES) {
    const p: ResolvedTheme = themes[name]!.palette
    const style = makeSyntaxStyle(p)
    const tokenOf = (scope: string): string | undefined => {
      const fg = style.getStyle(scope)?.fg
      return fg ? rgbToHex(fg) : undefined
    }
    a.ok(tokenOf("keyword") === p.syntaxKeyword, `[${name}] scope keyword → syntaxKeyword`)
    a.ok(tokenOf("string") === p.syntaxString, `[${name}] scope string → syntaxString`)
    a.ok(tokenOf("function") === p.syntaxFunction, `[${name}] scope function → syntaxFunction`)
    a.ok(tokenOf("comment") === p.syntaxComment, `[${name}] scope comment → syntaxComment`)
    a.ok(tokenOf("markup.heading") === p.markdownHeading, `[${name}] scope markup.heading → markdownHeading`)
    a.ok(tokenOf("markup.raw") === p.markdownCode, `[${name}] scope markup.raw → markdownCode`)
    a.ok(tokenOf("markup.strong") === p.markdownStrong, `[${name}] scope markup.strong → markdownStrong`)
    a.ok(tokenOf("diff.plus") === p.diffAdded, `[${name}] scope diff.plus → diffAdded`)
    a.ok(tokenOf("diff.minus") === p.diffRemoved, `[${name}] scope diff.minus → diffRemoved`)
  }

  // ── (1) the palette still drives a real, structured frame + (3b) code renders ────────────
  // RLM_THEME pins the BOOT theme to the default so a `.rlmcode.json` left by a prior run (the
  // picker persists its pick) can't change which theme this run boots with — the picker assertions
  // below depend on rlmcode-dark being the live theme at start (env wins over the persisted name).
  const d = await launchDriver({ env: { RLM_THEME: "rlmcode-dark" } })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n") // new session
    const composer = await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
    a.has(composer, "message kimi", "composer placeholder renders (theme.muted-styled prompt paints)")

    await d.type("count the files")
    await d.key("Enter")
    const sent = await d.waitFor((f) => /count the files/.test(f), { label: "user row" })
    a.has(sent, /│/, "user message left-border (theme.border) row renders")

    const reply = await d.waitFor((f) => /Found 3 matches|Done\./.test(f), { label: "reply", timeoutMs: 40000 })
    a.has(reply, /Found 3 matches/, "agent reply body (theme.text-styled) renders unchanged after the re-shape")
    a.has(reply, /Cmd\+K commands/, "shell footer action-bar (theme.textMuted) still paints — palette backs every render site")

    // (3b) a "show code" turn returns a fenced ```ts block — the reply <markdown> highlights it
    // through the populated SyntaxStyle. Assert the code body lands (the render path the bare
    // style left colorless). Frame carries glyphs not RGB, so we assert the code TEXT renders.
    await d.type("show code")
    await d.key("Enter")
    const code = await d.waitFor((f) => /console\.log\(greet\)/.test(f), { label: "code reply", timeoutMs: 40000 })
    a.has(code, /const greet/, "fenced ```ts code body renders through the populated SyntaxStyle")
    a.has(code, /console\.log\(greet\)/, "the full code block flows through the syntax-highlight render path")

    console.log("  ── captured post-turn frame (theme step, render unchanged + code renders) ──")
    console.log(
      code
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )

    // ── (d) THE PICKER SWITCHES THE THEME LIVE (the new captured-frame assertion) ────────────────
    // Open /theme via the command palette (Ctrl+K → filter "theme" → run), assert the picker LISTS
    // >=2 theme names with the current one tagged, select a DIFFERENT theme, then RE-OPEN the picker
    // and assert the "current" mark MOVED — a stable structural signal the switch took (and stuck in
    // the active state), independent of the spinner glyph or raw RGB (a cell grid carries neither).
    await d.ctrl("k")
    await d.waitFor((f) => /Commands/.test(f), { label: "palette open" })
    await d.type("theme")
    await d.waitFor((f) => /Pick theme…/.test(f), { label: "palette filtered to /theme" })
    await d.key("Enter")
    // The theme dialog now lists the registry palettes; gate on the picker title + footer (fully drawn).
    const picker = await d.waitFor((f) => /Pick theme/.test(f) && /↵ apply/.test(f), { label: "theme picker open" })
    a.has(picker, /Pick theme/, "/theme opens the theme picker (title)")
    a.has(picker, /rlmcode dark/, "the picker lists the default theme name")
    a.has(picker, /gruvbox/, "the picker lists a second theme name (>=2 selectable themes)")
    a.has(picker, /tokyo night/, "the picker lists a third theme name")
    // The current theme (rlmcode-dark, the boot default) is marked "current" on its row.
    a.has(picker, /rlmcode dark.*current/, "the picker marks the CURRENTLY-active theme (rlmcode dark · current)")
    console.log("  ── captured theme picker (lists themes, current marked) ──")
    console.log(picker.split("\n").map((l) => `  │ ${l}`).join("\n"))

    // Move to a DIFFERENT theme (gruvbox is row 2) and apply it — the switch is LIVE + persisted.
    await d.key("ArrowDown")
    await d.key("Enter")
    // The dialog closes back to the chat (composer visible) — the switch took effect.
    await d.waitFor((f) => /message kimi/.test(f) && !/Pick theme/.test(f), { label: "picker closed after apply" })

    // RE-OPEN the picker: the "current" tag must now sit on gruvbox, NOT rlmcode-dark — proof the
    // active theme genuinely changed (the structural signal the frame can carry).
    await d.ctrl("k")
    await d.waitFor((f) => /Commands/.test(f), { label: "palette re-open" })
    await d.type("theme")
    await d.waitFor((f) => /Pick theme…/.test(f), { label: "palette re-filtered" })
    await d.key("Enter")
    const after = await d.waitFor((f) => /Pick theme/.test(f) && /↵ apply/.test(f), { label: "theme picker re-open" })
    a.has(after, /gruvbox.*current/, "after selecting gruvbox the picker now marks gruvbox · current (the switch took)")
    a.hasNot(after, /rlmcode dark.*current/, "the previously-current default is no longer marked current (the active theme changed)")
    console.log("  ── captured theme picker after switch (current moved to gruvbox) ──")
    console.log(after.split("\n").map((l) => `  │ ${l}`).join("\n"))
    await d.key("Escape") // close the picker
  } finally {
    await d.stop()
    // HERMETIC: the picker persisted its pick to .rlmcode.json (cwd) — remove it so the test leaves
    // no side effect (no cross-test theme contamination; the file is gitignored regardless).
    try { rmSync(join(REPO_ROOT, ".rlmcode.json")) } catch { /* never written / already gone */ }
  }
})
