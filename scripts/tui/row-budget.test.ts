#!/usr/bin/env bun
// FRAME GATE — TURN-AWARE ROW BUDGET (W4/F6). Drives the BIG-BODY mock variant (mock-ai.ts
// wantsBigBody → the test-only `mock_bigbody` tool replays ONE bash with a 400-line stdout as the
// MAIN TURN's own step). Before F6, EXPANDING that bash set max=Number.MAX_SAFE_INTEGER and dumped
// all 400 lines inline — the splatter that blew the viewport off-screen. F6 threads a per-turn
// bodyBudget (chat.tsx derives it from the viewport height, divided among the turn's expanded
// tools) so even a fully-EXPANDED body is BOUNDED to a viewport-fitting cap + keeps its "… +N more"
// footer. This gate proves that: expand the bash, an EARLY line shows, but a FAR line stays bounded
// OUT and the "+N more" footer survives. orch.ts/atoms/toolui are driven for real; ONLY the per-tool
// feed is mocked. Waits are frame-stable (waitFor over captured text), never setTimeout-then-assert.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("row-budget.test", async (a) => {
  // rows=40 ⇒ bodyBudget = max(24, 40-10) = 30; one expanded bash ⇒ a ~30-line bounded body.
  const d = await launchDriver({ rows: 40 })
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── drive the BIG-BODY variant: one bash with a 400-line stdout as the main turn's step ──────
    await d.type("show the big output")
    await d.key("Enter")
    // The matured tool row lives under the COLLAPSED "▸ N steps" header — expand it first.
    await d.waitFor((f) => /❯ ▸ \d+ steps?/.test(f), { label: "settled turn steps header focused", timeoutMs: 40000 })
    await d.key("Enter")
    // COLLAPSED by default: Shell caps at 10 lines + a "… +N more" footer; the far lines are hidden.
    const collapsed = await d.waitFor(
      (f) => /\$ Bash\(cat huge\.log\)/.test(f) && /BIG line 1\b/.test(f) && /\+\d+ more/.test(f),
      { label: "collapsed big-body bash (Shell cap 10)", timeoutMs: 40000 },
    )
    a.has(collapsed, /\$ Bash\(cat huge\.log\)/, "the big-body bash renders as a BLOCK row")
    a.has(collapsed, /BIG line 1\b/, "collapsed body shows the head of the output")
    a.hasNot(collapsed, /BIG line 399/, "collapsed body does NOT show a far line (line 399)")

    // ── EXPAND the bash — the F6 proof: the body grows but stays BOUNDED to the row budget ───────
    // Tab the focus ring onto the bash row, then Enter to expand it (frame-stable per Tab).
    let tabs = 0
    for (; tabs < 8; tabs++) {
      await d.key("Tab")
      const ok = await d
        .waitFor((f) => /❯ \$ Bash\(cat huge\.log\)/.test(f), { timeoutMs: 1500, label: "bash focused" })
        .then(() => true)
        .catch(() => false)
      if (ok) break
    }
    a.ok(tabs < 8, "Tab rings focus onto the big-body bash row (❯ gutter)")
    await d.key("Enter")
    // Expanding reveals MORE than the collapsed 10 lines (line 20 now shows) — the expand is real.
    // Gate on a SINGLE STABLE frame carrying both a deeper line AND the still-present "+N more"
    // footer (the body is bounded), so we never read a mid-scroll transitional frame.
    const expanded = await d.waitFor((f) => /BIG line 20\b/.test(f) && /\+\d+ more/.test(f), { label: "expanded big-body bash", timeoutMs: 8000 })
    a.has(expanded, /BIG line 20\b/, "expanding reveals meaningfully more than the collapsed cap (line 20)")
    // THE HEADLINE FIX (F6): even EXPANDED, the body is BOUNDED by the per-turn bodyBudget — a far
    // line (399) is NOT dumped inline, and the "… +N more" drill-down footer survives. Pre-F6 this
    // was Number.MAX_SAFE_INTEGER → all 400 lines splattered and the viewport blew.
    a.hasNot(expanded, /BIG line 399/, "F6: an EXPANDED big body stays BOUNDED — a far line (399) is NOT splattered inline")
    a.hasNot(expanded, /BIG line 400/, "F6: the last line of a 400-line body is bounded out (viewport-safe)")
    a.has(expanded, /\+\d+ more/, "F6: the '… +N more' drill-down footer survives even when expanded (body still bounded)")
  } finally {
    await d.stop()
  }
})
