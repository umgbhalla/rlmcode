// DETERMINISTIC MOCK FEED — the canned NodeEvent script so the orch tree renders from
// fixed data with NO forward()/network. TEST-ONLY: consumed by scripts/tui/mock.test.ts
// (outside the src/-only design-check scan, so mock.ts is an ENTRY root there). The
// zero-network AI itself lives in mock-ai.ts; the agent.ts RLM_MOCK seam mounts it. Keep
// this SMALL — fixtures, not a second provider.
import type { AxFunction } from "@ax-llm/ax"
import type { Activity } from "./activity.ts"
import type { ActivitySink, NodeEvent } from "./orch.ts"
import { getTurnEmit } from "./runtime.ts"

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

// CANNED PER-NODE TOOL FEED — a read/glob/grep CLUSTER plus one ERRORED tool, all owned by
// the still-running `research` node (a running node stays expanded, so its owned tools show).
// Routed by nodeId, these exercise the PER-NODE TOOL ROUTING (atoms patchNodeTools) + the
// ToolView render under a node: the cluster lands as grouped tool rows, the errored one as a
// red ✗ card. Each tool is a call (kind:"tool") then a result (kind:"result"); the error
// carries isError:true so ToolView marks it ✗ red. NOT in production — replayed only here.
const MOCK_NODE_TOOLS: ReadonlyArray<{ id: string; name: string; args: string; result: string; isError: boolean }> = [
  { id: "mt_read", name: "read_file", args: JSON.stringify({ path: "src/auth.ts" }), result: "120 lines", isError: false },
  { id: "mt_glob", name: "glob", args: JSON.stringify({ pattern: "src/**/*.ts" }), result: "found 18 files", isError: false },
  { id: "mt_grep", name: "grep", args: JSON.stringify({ pattern: "login" }), result: "12 matches", isError: false },
  { id: "mt_err", name: "bash", args: JSON.stringify({ command: "missing-bin" }), result: "exit 127: command not found", isError: true },
]

// Replay the canned NodeEvent feed through the PER-TURN activity emit (kind:"node"). The emit
// is the turn's closure (run.ts), threaded into the tool via the forward `extra.emit` — the
// atoms reducer folds these into the live OrchTree exactly as real orch.emit() events would, so
// flatten() draws the velocity tree in the live UI. Mapped to the bus shape: start carries
// parentId+detail(phase); done carries tokens; error carries the cause as detail. Then the
// per-node tool cluster + error card replay under the running `research` node. No forward/network.
const feedMockNodes = (emit: ActivitySink): void => {
  const push = (a: Activity): void => emit(a)
  for (const e of MOCK_NODES) {
    if (e.type === "start")
      push({ kind: "node", nodeId: e.nodeId, event: "start", parentId: e.parentId, detail: e.phase })
    else if (e.type === "done")
      push({ kind: "node", nodeId: e.nodeId, event: "done", detail: String(e.result), tokens: e.tokens })
    else if (e.type === "error") push({ kind: "node", nodeId: e.nodeId, event: "error", detail: String(e.cause) })
  }
  for (const t of MOCK_NODE_TOOLS) {
    push({ kind: "tool", id: t.id, name: t.name, args: t.args, nodeId: "research" })
    push({ kind: "result", id: t.id, result: t.result, isError: t.isError, nodeId: "research" })
  }
}

// TEST-ONLY orch tool (registered into the mock chat gen's toolset under the RLM_MOCK seam
// in agent.ts). When the mock AI scripts a call to it, it replays MOCK_NODES through the PER-TURN
// emit (recovered via getTurnEmit(sessionId) — ax forwards only a fixed extra to a tool func) so
// the orch-tree frame renders from canned data. Returns a fixed string so the tool loop settles
// to the canned final reply. NOT in BASE_TOOLS — off in production. No turn boundary ⇒ no-op feed.
export const MOCK_ORCH_TOOL: AxFunction = {
  name: "mock_orch",
  description: "TEST ONLY: replay a canned orchestration node feed for the headless TUI harness.",
  parameters: { type: "object", properties: {}, required: [] },
  func: async (_args: unknown, extra?: Readonly<{ sessionId?: string; abortSignal?: AbortSignal }>) => {
    feedMockNodes(getTurnEmit(extra?.sessionId))
    return "orchestrated 4 nodes (1 error)"
  },
}

// ── CANNED TRANSCRIPT-MATURITY FEED (separate from the orch fixture so tool-grouping.test stays
// byte-identical) — drives the MATURED tool render (tool-view.tsx): the three render MODES + the
// output-collapse, all owned by a single still-running `worker` subagent NODE (a node IS a
// sub-agent / the Task surface; running ⇒ its owned tools stay shown). Exercises:
//   - a SETTLED bash with a 12-line stdout → a BLOCK row whose body COLLAPSES to 10 lines + a
//     "+N more" footer (Shell cap 10), expandable;
//   - a SETTLED read_file (12 lines) → a BLOCK row carrying the "12 lines" per-tool detail;
//   - a SETTLED bash that FAILED (exit 127) → a RED ✗ error card;
//   - a tool CALL with NO result → a RUNNING tool, rendered as a dim INLINE one-liner (no body).
// The 12-line bodies are deterministic literal strings (no real shell), so the collapse math is
// frame-stable. NOT in production — replayed only by the transcript frame gate.
const TWELVE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")
const MOCK_TRANSCRIPT_TOOLS: ReadonlyArray<{ id: string; name: string; args: string; result: string; isError: boolean; settle: boolean }> = [
  { id: "tx_run", name: "bash", args: JSON.stringify({ command: "seq 12" }), result: TWELVE, isError: false, settle: true },
  { id: "tx_read", name: "read_file", args: JSON.stringify({ path: "src/big.ts" }), result: TWELVE, isError: false, settle: true },
  { id: "tx_err", name: "bash", args: JSON.stringify({ command: "missing-bin" }), result: "exit 127: command not found", isError: true, settle: true },
  { id: "tx_live", name: "grep", args: JSON.stringify({ pattern: "TODO" }), result: "", isError: false, settle: false }, // RUNNING (no result) → inline
]
const feedTranscriptNodes = (emit: ActivitySink): void => {
  const push = (a: Activity): void => emit(a)
  // one running subagent node owns the tools (start, never done ⇒ stays expanded).
  push({ kind: "node", nodeId: "worker", event: "start", detail: "subagent" })
  for (const t of MOCK_TRANSCRIPT_TOOLS) {
    push({ kind: "tool", id: t.id, name: t.name, args: t.args, nodeId: "worker" })
    if (t.settle) push({ kind: "result", id: t.id, result: t.result, isError: t.isError, nodeId: "worker" })
  }
}

// TEST-ONLY transcript tool — like MOCK_ORCH_TOOL but replays the richer per-tool cluster above so
// the transcript-maturity frame gate (scripts/tui/transcript.test.ts) can assert the inline/block/
// error modes + the "+N more" collapse. Off in production (registered only under RLM_MOCK).
export const MOCK_TRANSCRIPT_TOOL: AxFunction = {
  name: "mock_transcript",
  description: "TEST ONLY: replay a canned per-tool cluster (inline/block/error + collapse) for the headless TUI harness.",
  parameters: { type: "object", properties: {}, required: [] },
  func: async (_args: unknown, extra?: Readonly<{ sessionId?: string; abortSignal?: AbortSignal }>) => {
    feedTranscriptNodes(getTurnEmit(extra?.sessionId))
    return "ran 4 tools (1 error, 1 running)"
  },
}
