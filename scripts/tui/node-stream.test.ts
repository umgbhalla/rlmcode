#!/usr/bin/env bun
// FRAME GATE — PER-NODE STREAM ROUTING (W2 / F8 + F9). Proves the latent-critical seam is closed:
// a sub-agent NODE that streams its reply (node-tagged replyDelta/thinkingDelta) routes that text
// to ITS OrchTree node (node.liveText), NOT the main transcript. Before W2, replyDelta carried no
// nodeId, so the moment any node forwarded with stream:true its entire streamed output GREW the main
// turn's reply — silently corrupting the transcript. The mock_nodestream tool (mock.ts) replays the
// EXACT activity shape drainWithWatchdog emits for a streaming node (nodeId-tagged deltas) through
// the REAL activity bus → run.ts → atoms.growNode → the live OrchTree, so this drives the real
// routing path, not a fake.
//
// The streamed node text is the sentinel "NODE-STREAM-LEAK-SENTINEL". The CORE assertion: that
// sentinel NEVER appears in the main transcript reply (the corruption), yet DOES grow the node — its
// detail pane (opened via the focus ring → Enter) shows it as the node's live streamed text. The
// node is LEFT RUNNING so its transient liveText is still live for the snapshot.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("node-stream.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // "node-stream" routes the mock to mock_nodestream → a node-tagged streamed reply replays
    // through the REAL bus → the live OrchTree. The turn's OWN reply is the canned MOCK_REPLY.
    await d.type("node-stream the answer")
    await d.key("Enter")

    // Wait for the settled MAIN reply (the canned reply) AND the inline tree (the running writer
    // node). The writer is LEFT RUNNING so its streamed text stays a TRANSIENT node.liveText —
    // shown only in the detail pane, never inline in the tree one-liner.
    const frame = await d.waitFor((f) => /Found .*3 matches/.test(f) && /stream answer/.test(f), { label: "node-stream tree", timeoutMs: 40000 })

    // ── CORE (F8): the node-streamed sentinel did NOT leak into the main transcript reply ───────
    // The main reply is the clean canned reply; the sub-agent's streamed text is routed UNDER its
    // node, so the sentinel must be ABSENT from the transcript reply region. (It is the writer
    // node's liveText, only shown in the detail pane — opened below.)
    a.has(frame, /Found .*3 matches/, "main transcript reply is the clean canned reply")
    a.hasNot(frame, "NODE-STREAM-LEAK-SENTINEL", "the node's streamed text did NOT leak into the main transcript (F8 fixed)")

    // ── POSITIVE ROUTING: drill into the writer node's DETAIL pane and assert its TRANSIENT streamed
    // text (node.liveText) shows THERE, under the node — proving the deltas grew the node, not the
    // main reply. Tab cycles the focus ring into the inline tree (the first Tab lands on the deepest
    // running node — the writer); Enter on a focused node:<id> opens its detail pane (node-detail.tsx
    // renders node.liveText while the node runs). FRAME-GATED on the sentinel (no setTimeout-assert).
    await d.key("Tab")
    await d.key("Enter")
    const opened = await d.waitFor((f) => /NODE-STREAM-LEAK-SENTINEL/.test(f) && /Running/.test(f), { label: "writer detail pane", timeoutMs: 8000 })
    a.has(opened, "NODE-STREAM-LEAK-SENTINEL", "node detail pane renders the node's transient streamed text (atoms.growNode → node.liveText)")
    a.has(opened, /Running/, "the streaming node detail shows the Running status (text is still live, not yet committed)")
    // The pane that opened is the WRITER node's (its label titles the pane) — the sentinel is its
    // text, NOT the main transcript's (which stayed the clean canned reply, asserted above).
    a.has(opened, /stream answer/, "the opened detail pane is the WRITER node (its label titles the pane)")
  } finally {
    await d.stop()
  }
})
