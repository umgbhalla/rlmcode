#!/usr/bin/env bun
// FRAME GATE — ICONS. Proves the lifted icon map (src/tui/icons.ts, a name→terminal-safe
// glyph Record + getIconShape with a ● fallback, the termcast subset ax2 renders) actually
// PAINTS through the live app — not merely compiles. Two halves:
//
//  1. UNIT: getIconShape resolves the ax2 render roles to the right glyph and falls back to
//     ● for an unknown name (the termcast contract).
//  2. FRAME: an ORCHESTRATE turn routes the node status + tool glyphs through getIconShape
//     (orch-tree.glyphOf / moreRow, toolui.toolIcon). We capture the LIVE frame and assert
//     the icon-sourced glyphs appear where the eye reads them — the ✗ on the errored node,
//     the ✓ on a settled node, and (under a tight velocity cap) the ┄ "+N earlier" marker.
//     If the icon map were unwired or wrong, these glyphs would vanish from the frame.
import { getIconShape } from "../../src/tui/icons.ts"
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("icons.test", async (a) => {
  // ── 1. UNIT — the map resolves ax2's roles + the ● fallback ──────────────────────────
  a.ok(getIconShape("error") === "✗", "getIconShape('error') === ✗")
  a.ok(getIconShape("done") === "✓", "getIconShape('done') === ✓")
  a.ok(getIconShape("running") === "◌", "getIconShape('running') === ◌")
  a.ok(getIconShape("bash") === "$", "getIconShape('bash') === $")
  a.ok(getIconShape("read") === "→", "getIconShape('read') === →")
  a.ok(getIconShape("write") === "←", "getIconShape('write') === ←")
  a.ok(getIconShape("search") === "✱", "getIconShape('search') === ✱")
  a.ok(getIconShape("more") === "┄", "getIconShape('more') === ┄")
  a.ok(getIconShape("node") === "▣", "getIconShape('node') === ▣")
  a.ok(getIconShape("focus") === "❯", "getIconShape('focus') === ❯")
  a.ok(getIconShape("nope-unknown") === "●", "unknown name falls back to ●")

  // ── 2. FRAME — the node-status glyphs PAINT in the live orch tree ─────────────────────
  // A tight velocity cap (AX2_ORCH_MAX_SHOWN=2) makes research's 3 children collapse into a
  // "┄ +1 earlier" marker, so the icon-sourced ┄ is on-screen alongside the ✓/✗ glyphs.
  const d = await launchDriver({ env: { AX2_ORCH_MAX_SHOWN: "2" } })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })
    await d.type("orchestrate the research")
    await d.key("Enter")
    // Gate on the COMPLETE settled tree (error node landed + the velocity marker) so the
    // capture is stable — not a partial paint.
    const tree = await d.waitFor((f) => /earlier/.test(f) && /Σ.*1 error/.test(f), { label: "orch tree", timeoutMs: 40000 })

    a.has(tree, "✗", "errored node renders the icon-map ✗ (getIconShape('error'))")
    a.has(tree, "✓", "settled node renders the icon-map ✓ (getIconShape('done'))")
    a.has(tree, /┄\s*\+1 earlier/, "velocity marker renders the icon-map ┄ (getIconShape('more'))")

    console.log("  ── captured icon frame ──")
    console.log(
      tree
        .split("\n")
        .map((l) => `  │ ${l}`)
        .join("\n"),
    )
  } finally {
    await d.stop()
  }
})
