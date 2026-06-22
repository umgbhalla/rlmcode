#!/usr/bin/env bun
// FRAME GATE — TOOL GROUPING + ERROR CARDS. The mock_orch feed (mock.ts) replays a per-node
// tool cluster — read_file / glob / grep — plus one ERRORED tool, all owned by the running
// `research` node. We assert the CAPTURED FRAME shows: (1) the cluster as grouped tool rows
// nested UNDER their node (the PER-NODE TOOL ROUTING — tools hang inside the tree, NOT in the
// main transcript), each via the real ToolView label/summary; (2) the errored tool as a red
// ✗ card. This is the "tools rendering under the wrong node" + "errors invisible" bug as a
// real frame assertion. orch.ts + toolui.ts are UNTOUCHED; only the feed is mocked.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("tool-grouping.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    await d.type("orchestrate the scan")
    await d.key("Enter")
    // Wait for the cluster to land (the ✗ error tool row is the last of the feed).
    const frame = await d.waitFor((f) => /Bash\(missing-bin\)/.test(f) && /Read\(/.test(f), { label: "tool cluster", timeoutMs: 40000 })

    // ── the read/glob/grep cluster renders as grouped tool rows (real toolui labels) ────
    a.has(frame, /Read\(src\/auth\.ts\)/, "read_file tool renders as a Read(...) row")
    a.has(frame, /Search\(src\/\*\*\/\*\.ts\)/, "glob tool renders as a Search(...) row")
    a.has(frame, /Search\(login\)/, "grep tool renders as a Search(...) row")

    // ── nesting: the cluster hangs UNDER the running research node (the │ tree stem), not
    // in the main transcript. The owned-tool rows sit deeper than the node header. ───────
    a.has(frame, /│\s+→ Read\(/, "the tool cluster is nested under its node (│ stem), not in the transcript")

    // ── the errored tool is a red ✗ card (✗ marker + error summary) ─────────────────────
    a.has(frame, /✗ Bash\(missing-bin\)/, "the errored tool renders as a ✗ card")
    a.has(frame, /✗ Bash\(missing-bin\).*error/, "the error card carries an error summary")

    // ── the non-errored cluster rows do NOT carry the ✗ error marker ────────────────────
    a.hasNot(frame, /✗ Read\(/, "a successful tool row is not marked as an error")
  } finally {
    await d.stop()
  }
})
