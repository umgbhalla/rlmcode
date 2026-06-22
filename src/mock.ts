// DETERMINISTIC MOCK FEED — the canned NodeEvent script so the orch tree renders from
// fixed data with NO forward()/network. TEST-ONLY: consumed by scripts/tui/mock.test.ts
// (outside the src/-only design-check scan, so mock.ts is an ENTRY root there). The
// zero-network AI itself lives in mock-ai.ts; the agent.ts AX2_MOCK seam mounts it. Keep
// this SMALL — fixtures, not a second provider.
import type { AxFunction } from "@ax-llm/ax"
import { emitActivity } from "./activity.ts"
import type { NodeEvent } from "./orch.ts"

// ── CANNED ORCH FEED ────────────────────────────────────────────────────────────────
// A fixed NodeEvent script so the orch tree renders deterministically with NO model: a
// root fan-out, three parallel children (one errors), and a judge leaf — the exact shape
// the velocity tree (orch-tree.ts) draws with ├─ └─ │ connectors. Feed these through the
// activity bus / onEvent to populate an OrchTree without any forward(). `research` +
// `orchestrate` are LEFT RUNNING (no done event) so a live-tree snapshot keeps their
// nested subtrees expanded (a settled+collapsed parent hides them — that path is covered
// by orch-tree-render.test).
export const MOCK_NODES: readonly NodeEvent[] = [
  { type: "start", nodeId: "orchestrate", phase: "fan-out" },
  { type: "start", nodeId: "plan", parentId: "orchestrate", phase: "decompose" },
  { type: "done", nodeId: "plan", result: "3 subtasks", tokens: 1200 },
  { type: "start", nodeId: "research", parentId: "orchestrate", phase: "parallel ×3" },
  { type: "start", nodeId: "auth", parentId: "research", phase: "scan auth" },
  { type: "start", nodeId: "db", parentId: "research", phase: "read models" },
  { type: "start", nodeId: "api", parentId: "research", phase: "scan routes" },
  { type: "done", nodeId: "auth", result: "found 12 refs", tokens: 3100 },
  { type: "error", nodeId: "api", cause: "rate_limited 429" },
  { type: "done", nodeId: "db", result: "ok", tokens: 900 },
  { type: "start", nodeId: "judge", parentId: "orchestrate", phase: "scoring" },
  { type: "done", nodeId: "judge", result: "picked auth", tokens: 500 },
]

// Replay the canned NodeEvent feed through the REAL activity bus (kind:"node"). The atoms
// sink (installed for the duration of the turn) folds these into the live OrchTree exactly
// as real orch.emit() events would, so flatten() draws the velocity tree in the live UI.
// Mapped to the bus shape: start carries parentId+detail(phase); done carries tokens; error
// carries the cause as detail. Pure replay — no forward(), no network.
const feedMockNodes = (): void => {
  for (const e of MOCK_NODES) {
    if (e.type === "start")
      emitActivity({ kind: "node", nodeId: e.nodeId, event: "start", parentId: e.parentId, detail: e.phase })
    else if (e.type === "done")
      emitActivity({ kind: "node", nodeId: e.nodeId, event: "done", detail: String(e.result), tokens: e.tokens })
    else if (e.type === "error") emitActivity({ kind: "node", nodeId: e.nodeId, event: "error", detail: String(e.cause) })
  }
}

// TEST-ONLY orch tool (registered into the mock chat gen's toolset under the AX2_MOCK seam
// in agent.ts). When the mock AI scripts a call to it, it replays MOCK_NODES through the
// activity bus so the orch-tree frame renders from canned data. Returns a fixed string so
// the tool loop settles to the canned final reply. NOT in BASE_TOOLS — off in production.
export const MOCK_ORCH_TOOL: AxFunction = {
  name: "mock_orch",
  description: "TEST ONLY: replay a canned orchestration node feed for the headless TUI harness.",
  parameters: { type: "object", properties: {}, required: [] },
  func: async () => {
    feedMockNodes()
    return "orchestrated 4 nodes (1 error)"
  },
}
