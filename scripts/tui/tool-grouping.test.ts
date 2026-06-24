#!/usr/bin/env bun
// FRAME GATE — W1 RENDER OVERHAUL (the render-target gold standard). The mock_orch feed (mock.ts)
// replays a per-node tool cluster — read_file / glob / grep + one ERRORED bash — all owned by the
// running `research` node. This gate asserts the THREE-TIER render the target screenshots specify:
//
//   TIER 1 (the tree): a COMPACT one-liner per node — status dot + label + a RIGHT-ALIGNED cost
//     meter ("Nk tok · N tools"), a ✗ N failed badge on a node whose child tool failed (F5), and
//     CRUCIALLY *no tool OUTPUT and no Read/Search/Bash rows inline* — the splatter (F1) is gone.
//   TIER 2 (the detail pane): arrow/Tab-drill-down to the `research` node + Enter OPENS its detail
//     pane, which shows "Activity · last N of M tool calls" as recent tool CALL one-liners
//     (Read(...)/Search(...)/Bash(...)), still with NO tool OUTPUT.
//
// This is the "tool-output splatter / no detail tier" failure (F1) + the node-tool asymmetry (F2)
// + the missing error glyph (F5) as one real frame assertion. orch.ts + toolui.ts are UNTOUCHED.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

// The research node's LABEL is its start phase ("parallel ×3"); reduceNode labels a node by its
// phase detail. A frame line carrying both the ❯ focus gutter and that label ⇒ research is SELECTED.
const researchFocused = (f: string): boolean => f.split("\n").some((l) => l.includes("❯") && /parallel ×3/.test(l))

await report("tool-grouping.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    await d.type("orchestrate the scan")
    await d.key("Enter")
    // Wait for the tree to settle: the errored `api` node shows ✗ and the research node bubbles
    // its failed-tool badge (the mock cluster has one errored bash owned by research).
    const tree = await d.waitFor(
      (f) => /orchestration/.test(f) && /✗.*scan routes|✗ \d+ failed/.test(f) && /Σ.*node/.test(f),
      { label: "compact tree", timeoutMs: 40000 },
    )

    // ── TIER 1: the COMPACT tree — structure + status + cost meter, NO tool output inline ──────
    a.has(tree, "orchestration", "orchestration section header rendered")
    a.has(tree, /●|✓|✗/, "nodes render as STATUS DOTS (● running / ✓ done / ✗ error)")
    a.has(tree, /parallel ×3/, "the research node (label = its phase) renders in the tree")
    a.has(tree, /✗ 1 failed/, "the research node bubbles a '✗ 1 failed' badge (its errored child tool, F5)")
    a.has(tree, /\d+ tools?/, "a node's cost meter shows its tool COUNT (e.g. '4 tools'), right-aligned")
    // THE HEADLINE FIX (F1): NO tool OUTPUT and NO Read/Search rows splatter in the tree.
    a.hasNot(tree, /Read\(src\/auth\.ts\)/, "F1: the tool CALL labels do NOT render inline in the tree")
    a.hasNot(tree, /found 18 files/, "F1: tool OUTPUT does NOT splatter into the tree")
    a.hasNot(tree, /12 matches/, "F1: tool OUTPUT does NOT splatter into the tree")
    a.hasNot(tree, /120 lines/, "F1: tool OUTPUT does NOT splatter into the tree")

    // ── TIER 2: drill down to `research` + Enter → the DETAIL pane (Activity = tool CALLS) ──────
    // Tab cycles the focus ring (turn-steps → tools → nodes). Press Tab until the ❯ gutter lands
    // on the research node line (frame-stable, no fixed count), then Enter to open its pane.
    const tabUntilResearch = async (): Promise<boolean> => {
      for (let i = 0; i < 14; i++) {
        await d.key("Tab")
        // FRAME-STABLE: wait (briefly) for THIS Tab's re-render to settle before testing the gutter,
        // so we never read a pre-Tab frame and mis-detect (or overshoot) the research row.
        const ok = await d.waitFor(researchFocused, { label: "research focused", timeoutMs: 400 }).then(() => true).catch(() => false)
        if (ok) return true
      }
      return false
    }
    a.ok(await tabUntilResearch(), "Tab drill-down can SELECT the research node (❯ on its row)")
    await d.key("Enter")
    const detail = await d.waitFor((f) => /Activity · last/.test(f), { label: "node detail pane", timeoutMs: 8000 })

    // ── the detail pane shows the windowed Activity = recent tool CALL one-liners, NO output ────
    a.has(detail, /Activity · last \d+ of 4 tool calls/, "detail pane: 'Activity · last N of 4 tool calls' header")
    a.has(detail, /Search\(login\)|Bash\(missing-bin\)/, "detail pane: recent tool CALLS render as one-liners")
    a.has(detail, /✗ Bash\(missing-bin\)/, "detail pane: the failed tool CALL is marked ✗")
    // STILL no tool OUTPUT — Activity is CALLS, the output is a deeper drill-down / absent.
    a.hasNot(detail, /12 matches/, "detail pane: a tool's OUTPUT is NOT shown (Activity is CALLS, not output)")
    a.hasNot(detail, /exit 127/, "detail pane: even a failed tool's OUTPUT is NOT splattered")

    // ── Esc closes the detail pane (returns to the tree) ────────────────────────────────────────
    await d.key("Escape")
    await d.waitFor((f) => !/Activity · last/.test(f), { label: "detail closed", timeoutMs: 8000 })
  } finally {
    await d.stop()
  }
})
