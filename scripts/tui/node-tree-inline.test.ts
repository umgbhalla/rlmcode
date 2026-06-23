#!/usr/bin/env bun
// FRAME GATE — NODE TREE INLINE. Proves the orchestration node-tree renders INLINE per-turn
// (opencode-ux-blueprint Option B), not as a session-level footer pinned below ALL turns:
//   1) a PLAIN turn (single bash step → reply) renders NO orchestration block — no
//      "orchestration" header, no "├─"/"└─" connectors, no "Σ … node" footer. computeShowOrch
//      is false ⇒ Turn.workflow undefined ⇒ TurnView renders no <WorkflowPart>.
//   2) a WORKFLOW turn (mock_orch replays MOCK_NODES through the REAL bus) renders the tree
//      INLINE under THAT turn — its user message, the velocity unicode tree (├─ └─ │), and the
//      Σ run-total footer all co-present, BELOW the user message that triggered it. The tree
//      hangs off the turn (Turn.workflow), not a session footer.
// Determinism: gate on the COMPLETE Σ footer (…1 error) — it paints in pieces as the tree
// settles, so a bare /Σ/ can capture a half-painted frame.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("node-tree-inline.test", async (a) => {
  // ── 1) PLAIN TURN → NO orchestration block ──────────────────────────────────────────
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // A plain message (no "orchestrate"/"explore"/"fail") runs the single bash step → the canned
    // reply. NO fan-out ⇒ computeShowOrch false ⇒ no inline tree.
    await d.type("just answer please")
    await d.key("Enter")
    // Wait for the settled reply (the canned MOCK_REPLY) so the turn is fully rendered.
    const plain = await d.waitFor((f) => /Found .*3 matches/.test(f), { label: "plain reply", timeoutMs: 40000 })
    a.has(plain, "just answer please", "plain turn's user message rendered")
    a.has(plain, /Found .*3 matches/, "plain turn's reply rendered")
    // The CORE non-workflow contract: a plain turn renders NO orchestration block.
    a.hasNot(plain, "orchestration", "plain turn renders NO 'orchestration' header")
    a.hasNot(plain, "├─", "plain turn renders NO tree branch connectors")
    a.hasNot(plain, /Σ.*node/, "plain turn renders NO Σ node-tree footer")
  } finally {
    await d.stop()
  }

  // ── 2) WORKFLOW TURN → tree renders INLINE under that turn ────────────────────────────
  const w = await launchDriver()
  try {
    await w.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await w.type("n")
    await w.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    await w.type("orchestrate the research")
    await w.key("Enter")
    const tree = await w.waitFor((f) => /fan-out/.test(f) && /Σ.*1 error/.test(f), { label: "inline tree", timeoutMs: 40000 })

    // INLINE PLACEMENT: the user message that triggered the fan-out, the orchestration header,
    // the unicode tree (├─ └─ │ connectors), and the Σ footer are ALL present in the SAME frame —
    // the tree hangs under THIS turn (Turn.workflow), not a detached session footer.
    a.has(tree, "orchestrate the research", "workflow turn's user message rendered")
    a.has(tree, "orchestration", "inline orchestration section header rendered under the turn")
    a.has(tree, "├─", "inline tree draws ├─ branch connectors")
    a.has(tree, "└─", "inline tree draws └─ last-child connector")
    a.has(tree, /Σ.*5\.7k tok.*7 node.*1 error/, "inline Σ footer: run-total tokens · node count · error count")

    // ORDERING (inline, not a footer): the user message comes BEFORE the orchestration block,
    // which comes BEFORE the Σ footer — i.e. the tree sits in the turn's body, after the prompt.
    const userAt = tree.indexOf("orchestrate the research")
    const headerAt = tree.indexOf("orchestration")
    const sigmaAt = tree.search(/Σ.*node/)
    a.ok(userAt >= 0 && headerAt > userAt, "orchestration header sits BELOW the turn's user message")
    a.ok(sigmaAt > headerAt, "Σ footer sits BELOW the inline tree (turn body order)")
  } finally {
    await w.stop()
  }
})
