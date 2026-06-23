#!/usr/bin/env bun
// FRAME GATE — THEME. Proves the theme re-shape (src/tui/theme.ts lifted to a termcast-style
// ResolvedTheme token object, Catppuccin-Mocha as the ONE default palette) is a pure re-skin:
//
//  (1) RENDER UNCHANGED — mount the REAL chat.tsx headlessly (terminal-control PTY + AX2_MOCK
//      mock AI, zero Cloudflare), drive a mock turn, and capture a real frame. Every color attr
//      in chat.tsx / orch-tree.ts resolves through `theme.*`; if the re-shape dropped or renamed
//      a token the components read, those modules wouldn't compile / the frame wouldn't render
//      its known structure. So a frame that still paints the `⏺` reply marker + the `│` user row
//      + the status line proves the palette object still backs every render site. (A captured
//      cell grid carries glyphs, not RGB, so the durable assertion is STRUCTURE, not raw hex.)
//
//  (2) NO INLINE HEX LEFT — grep src/tui for a 6-digit hex literal; the ONLY file allowed to
//      hold raw hex is theme.ts (the single palette source). Any other hit means a color was
//      hard-coded at a call site instead of named by role — the exact smell this step removes.
//
// Frame-stable waits only (driver.waitFor), never setTimeout-then-assert.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

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

  // ── (1) the re-shaped palette still drives a real, structured frame ──────────────────────
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
    a.has(reply, "⏺", "agent reply marker (theme.ok-styled) renders unchanged after the re-shape")
    a.has(reply, /Cmd\+K commands/, "shell footer action-bar (theme.textMuted) still paints — palette backs every render site")

    console.log("  ── captured post-turn frame (theme re-shape, render unchanged) ──")
    console.log(
      reply
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )
  } finally {
    await d.stop()
  }
})
