#!/usr/bin/env bun
// FRAME GATE — NODE TREE. Drives an ORCHESTRATE turn (the mock_orch tool replays the canned
// MOCK_NODES feed through the REAL activity bus) and asserts the CAPTURED FRAME shows the
// velocity unicode tree the way a human sees it: UNICODE connectors (├─ └─ │), each node's
// children nested UNDER it (not flattened into the main transcript), the error node as ✗, and
// the Σ run-total footer. This is the "flat tree / tools under the wrong node" bug as a real
// frame assertion — the orch.ts prims and flatten() renderer are UNTOUCHED; only the feed is
// mocked. (Render order + exact prefixes are golden-pinned headlessly by
// scripts/orch-tree-render.test.ts; here we prove the LIVE app paints them.)
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("node-tree.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // "orchestrate" routes the mock to mock_orch → MOCK_NODES replay → live OrchTree render.
    await d.type("orchestrate the research")
    await d.key("Enter")
    // Wait for the COMPLETE Σ footer (…1 error), not merely /Σ/: the footer paints in pieces
    // as the tree settles, so gating on a partial "Σ" can capture a frame where the trailing
    // "error" hasn't landed yet. Waiting for the whole line we assert makes the capture stable.
    const tree = await d.waitFor((f) => /fan-out/.test(f) && /Σ.*1 error/.test(f), { label: "orch tree", timeoutMs: 40000 })

    // ── the orchestration section header + UNICODE connectors ───────────────────────────
    a.has(tree, "orchestration", "orchestration section header rendered")
    a.has(tree, "├─", "tree draws ├─ branch connectors")
    a.has(tree, "└─", "tree draws └─ last-child connector")
    a.has(tree, "│", "tree draws │ vertical continuation")

    // ── nesting: research's three children hang UNDER research (deeper │ stem), not in the
    // main transcript. The `│  ├─` / `│  └─` prefixes prove a second indent level. ───────
    a.has(tree, /│\s+├─.*scan auth/, "child 'scan auth' nests under research (│ ├─ stem)")
    a.has(tree, /│\s+├─.*read models/, "child 'read models' nests under research")
    a.has(tree, /│\s+└─.*scan routes/, "last child 'scan routes' nests under research (│ └─)")

    // ── status glyphs: settled ✓, the errored node ✗, running spinner on the live roots ──
    a.has(tree, /✓\s*decompose/, "settled node shows ✓ done glyph")
    a.has(tree, /✗.*scan routes/, "errored node shows ✗ and its cause")
    a.has(tree, "rate_limited 429", "the error cause is surfaced on the node")

    // ── per-node tokens + the Σ run-total footer (cost-meter) ───────────────────────────
    a.has(tree, /3\.1k tok/, "per-node token usage rendered (scan auth: 3.1k)")
    a.has(tree, /Σ.*5\.7k tok.*7 node.*1 error/, "Σ footer: run-total tokens · node count · error count")

    // ── VELOCITY ROLLING WINDOW: with a tight cap, a node keeps the last N children +
    // collapses the older into one "┄ +M earlier" row (the fan-out wall guard). A second
    // mount with AX2_ORCH_MAX_SHOWN=2 makes research (3 kids) show 2 + "+1 earlier". The Σ
    // still counts ALL nodes (the hidden ones aren't dropped, just folded). ────────────
    await d.stop()
    const capped = await launchDriver({ env: { AX2_ORCH_MAX_SHOWN: "2" } })
    try {
      await capped.waitFor((f) => /no sessions/.test(f))
      await capped.type("n")
      await capped.waitFor((f) => /message kimi/.test(f))
      await capped.type("orchestrate it")
      await capped.key("Enter")
      // Same stability gate: wait for the COMPLETE Σ footer (…7 nodes) we assert, not a bare /Σ/.
      const windowed = await capped.waitFor((f) => /earlier/.test(f) && /Σ.*7 node/.test(f), { label: "velocity window", timeoutMs: 40000 })
      a.has(windowed, /┄\s*\+1 earlier/, "velocity cap collapses older siblings into '┄ +1 earlier'")
      a.has(windowed, /read models/, "the most-recent settled child stays visible under the cap")
      a.has(windowed, /Σ.*7 node/, "Σ still counts all 7 nodes — hidden children are folded, not dropped")
    } finally {
      await capped.stop()
    }
  } finally {
    await d.stop()
  }
})
