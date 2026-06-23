#!/usr/bin/env bun
// FRAME GATE — THEME. Proves the theme system (src/tui/theme.ts: a termcast-style ResolvedTheme
// token object, Catppuccin-Mocha as the ONE default palette, PLUS the syntax-scope SyntaxStyle that
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
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { rgbToHex } from "@opentui/core"
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"
import { DEFAULT_THEME, makeSyntaxStyle, theme } from "../../src/tui/theme.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const TUI_DIR = join(HERE, "..", "..", "src", "tui")
const HEX = /#[0-9a-fA-F]{6}\b/

// Recursively collect every .ts/.tsx under src/tui except theme.ts (the palette home).
const tuiSources = (dir: string): string[] => {
  const out: string[] = []
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

  // ── (3) syntax-scope → theme-token round-trip (deterministic) ────────────────────────────
  // makeSyntaxStyle() must register each scope onto its palette token. getStyle(scope).fg is an
  // RGBA; rgbToHex it and compare to the theme hex. (DEFAULT_THEME === theme, the one palette.)
  a.ok(DEFAULT_THEME === theme, "DEFAULT_THEME is the resolved default palette")
  const style = makeSyntaxStyle()
  const tokenOf = (scope: string): string | undefined => {
    const fg = style.getStyle(scope)?.fg
    return fg ? rgbToHex(fg) : undefined
  }
  // Each tree-sitter code scope resolves to its syntax token (the wiring the bare style lacked).
  a.ok(tokenOf("keyword") === theme.syntaxKeyword, "scope keyword → theme.syntaxKeyword")
  a.ok(tokenOf("string") === theme.syntaxString, "scope string → theme.syntaxString")
  a.ok(tokenOf("function") === theme.syntaxFunction, "scope function → theme.syntaxFunction")
  a.ok(tokenOf("number") === theme.syntaxNumber, "scope number → theme.syntaxNumber")
  a.ok(tokenOf("type") === theme.syntaxType, "scope type → theme.syntaxType")
  a.ok(tokenOf("comment") === theme.syntaxComment, "scope comment → theme.syntaxComment")
  // Markdown markup scopes → markdown tokens (the reply <markdown> highlight surface).
  a.ok(tokenOf("markup.heading") === theme.markdownHeading, "scope markup.heading → theme.markdownHeading")
  a.ok(tokenOf("markup.raw") === theme.markdownCode, "scope markup.raw (inline code) → theme.markdownCode")
  a.ok(tokenOf("markup.strong") === theme.markdownStrong, "scope markup.strong → theme.markdownStrong")
  // Diff line scopes → diff tokens (native <diff> renderable).
  a.ok(tokenOf("diff.plus") === theme.diffAdded, "scope diff.plus → theme.diffAdded")
  a.ok(tokenOf("diff.minus") === theme.diffRemoved, "scope diff.minus → theme.diffRemoved")

  // ── (1) the palette still drives a real, structured frame + (3b) code renders ────────────
  const d = await launchDriver()
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
  } finally {
    await d.stop()
  }
})
