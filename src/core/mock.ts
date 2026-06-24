// DETERMINISTIC MOCK FEED — the canned NodeEvent script so the orch tree renders from
// fixed data with NO forward()/network. TEST-ONLY: consumed by scripts/tui/mock.test.ts
// (outside the src/-only design-check scan, so mock.ts is an ENTRY root there). The
// zero-network AI itself lives in mock-ai.ts; the agent.ts RLM_MOCK seam mounts it. Keep
// this SMALL — fixtures, not a second provider.
import type { AxFunction } from "@ax-llm/ax"
import type { Activity } from "./activity.ts"
import { type ActivitySink, type NodeEvent, retryStatus } from "./orch.ts"
import { getTurnEmit } from "./sessions.ts"

// Holdable pace for the time-sensitive fixtures (the rate-limit retry below): a real backoff is
// brief, so without a pause the "⏳ rate-limited" retry state flips to ✓ faster than the frame gate
// can capture it. RLM_MOCK_DELAY_MS (the same knob mock-ai's stream uses) holds the retry state so
// the frame gate sees it DURING the backoff; default 0 keeps non-timed tests instant.
const MOCK_DELAY_MS = Number(process.env.RLM_MOCK_DELAY_MS ?? 0)
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

// ── CANNED ORCH FEED ────────────────────────────────────────────────────────────────
// A fixed NodeEvent script so the orch tree renders deterministically with NO model: a
// root fan-out, three parallel children (one errors), and a judge leaf — the exact shape
// the velocity tree (orch-tree.ts) draws with ├─ └─ │ connectors. Feed these through the
// activity bus / onEvent to populate an OrchTree without any forward(). `research` +
// `orchestrate` are LEFT RUNNING (no done event) so a live-tree snapshot keeps their
// nested subtrees expanded (a settled+collapsed parent hides them — that path is covered
// by orch-tree-render.test).
export const MOCK_NODES: ReadonlyArray<NodeEvent> = [
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
  // MAIN-TURN tools (NO nodeId) — they land as the TURN's own steps, which is where the matured
  // ToolView render modes (inline / block + collapse / ✗ error card) live (the W1 render overhaul
  // moved a NODE's tools out of the tree into its detail pane, so the block/collapse render is the
  // main-turn surface). The transcript frame gate expands the turn steps to assert these modes.
  for (const t of MOCK_TRANSCRIPT_TOOLS) {
    push({ kind: "tool", id: t.id, name: t.name, args: t.args })
    if (t.settle) push({ kind: "result", id: t.id, result: t.result, isError: t.isError })
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

// ── CANNED DIFF FEED (diff-viewer frame gate) — a settled edit_file + a settled write_file owned by
// one still-running `editor` subagent NODE, so the MATURED diff render (tool-view.tsx ToolBody) draws
// the native opentui <diff> from canned data. edit_file carries deterministic old/new strings whose
// LCS (toolui.toolDiff) yields a clean context + one -/+ pair; write_file is an all-add diff. The
// content tokens are unique + line-stable so the frame gate can assert the native diff (line numbers +
// the +/- gutter, content with the leading sign STRIPPED) over the crude LCS <text> fallback it
// replaces. NOT in production — replayed only by scripts/tui/diff-viewer.test.ts under RLM_MOCK.
//   The edit changes ONE line (the greeting string) inside three context lines, so the diff reads as a
// real minimal edit (context kept, one - then one +), not a whole-block rewrite. .ts filetype drives
// the syntax highlighter through the populated SyntaxStyle (theme.makeSyntaxStyle).
const DIFF_OLD = ['export function greet(name: string) {', '  const msg = "hi " + name', '  return msg', '}'].join("\n")
const DIFF_NEW = ['export function greet(name: string) {', '  const msg = "hello, " + name', '  return msg', '}'].join("\n")
const WRITE_BODY = ['export const VERSION = "0.0.1"', 'export const NAME = "rlmcode"'].join("\n")
// A SECOND edit on a .py file (a DIFFERENT filetype) so the diff-viewer gate proves the native
// <diff> is FILETYPE-GENERAL — the .py path runs through the SAME populated SyntaxStyle as .ts (the
// renderer is filetype-driven, not TS-hardcoded), which is the "syntax-highlighted" claim across a
// second language. One changed line inside two context lines ⇒ a clean minimal -/+ diff.
const PY_OLD = ['def greet(name):', '    return "hi " + name'].join("\n")
const PY_NEW = ['def greet(name):', '    return "hello, " + name'].join("\n")
const MOCK_DIFF_TOOLS: ReadonlyArray<{ id: string; name: string; args: string; result: string; isError: boolean }> = [
  { id: "df_edit", name: "edit_file", args: JSON.stringify({ path: "src/greet.ts", old_string: DIFF_OLD, new_string: DIFF_NEW }), result: "updated", isError: false },
  { id: "df_py", name: "edit_file", args: JSON.stringify({ path: "src/greet.py", old_string: PY_OLD, new_string: PY_NEW }), result: "updated", isError: false },
  { id: "df_write", name: "write_file", args: JSON.stringify({ path: "src/version.ts", content: WRITE_BODY }), result: "written", isError: false },
]
const feedDiffNodes = (emit: ActivitySink): void => {
  const push = (a: Activity): void => emit(a)
  // MAIN-TURN file-mutation tools (NO nodeId) — they land as the TURN's own steps, where the
  // matured native <diff> render lives (the W1 render overhaul moved a NODE's tools into its detail
  // pane, so the diff render is the main-turn surface). The diff-viewer frame gate expands the turn.
  for (const t of MOCK_DIFF_TOOLS) {
    push({ kind: "tool", id: t.id, name: t.name, args: t.args })
    push({ kind: "result", id: t.id, result: t.result, isError: t.isError })
  }
}

// TEST-ONLY diff tool — replays a canned edit_file + write_file cluster so the diff-viewer frame gate
// (scripts/tui/diff-viewer.test.ts) can assert the native opentui <diff> render (syntax-highlighted
// +/- lines, line numbers, split/unified by width). Off in production (registered only under RLM_MOCK).
export const MOCK_DIFF_TOOL: AxFunction = {
  name: "mock_diff",
  description: "TEST ONLY: replay a canned edit_file + write_file cluster (native diff render) for the headless TUI harness.",
  parameters: { type: "object", properties: {}, required: [] },
  func: async (_args: unknown, extra?: Readonly<{ sessionId?: string; abortSignal?: AbortSignal }>) => {
    feedDiffNodes(getTurnEmit(extra?.sessionId))
    return "edited 2 files (1 edit, 1 write)"
  },
}

// ── CANNED RATE-LIMIT RETRY FEED (rate-limit-visible frame gate) — a child node that hits a 429,
// emits the `retry` NodeEvent (so it shows "⏳ rate-limited · retry 2/3 · 4s" WHILE backing off),
// HOLDS (RLM_MOCK_DELAY_MS) so the frame gate captures the live retry state, then RECOVERS (done ✓).
// The retry detail uses retryStatus() — the SAME formatter the real path uses — so the fixture and
// production agree byte-for-byte. NOT in production — replayed only by rate-limit.test under RLM_MOCK.
const RL_BACKOFF_MS = 4000 // a fixed, legible backoff so the badge reads "· 4s" (test-stable)
const feedRateLimitNodes = async (emit: ActivitySink, signal?: AbortSignal): Promise<void> => {
  const push = (a: Activity): void => emit(a)
  // root fan-out + one child that will hit the 429.
  push({ kind: "node", nodeId: "orchestrate", event: "start", detail: "fan-out" })
  push({ kind: "node", nodeId: "scan", parentId: "orchestrate", event: "start", detail: "scan routes" })
  // the 429 RETRY — the live backoff signal (cause rate_limited, attempt 2/3, the 4s backoff).
  push({ kind: "node", nodeId: "scan", event: "retry", detail: retryStatus("rate_limited", 2, 3, RL_BACKOFF_MS) })
  await sleep(MOCK_DELAY_MS) // hold the "⏳ rate-limited" state so the frame gate captures it
  if (signal?.aborted) return // a cancelled turn leaves the node mid-retry (no spurious recover)
  // RECOVER — the retry cleared, the node finishes clean (✓), proving the backoff was transient.
  push({ kind: "node", nodeId: "scan", event: "done", detail: "found 3 routes", tokens: 800 })
}

// TEST-ONLY rate-limit tool — replays a 429-then-recover node so the rate-limit frame gate
// (scripts/tui/rate-limit.test.ts) asserts the "⏳ rate-limited · retry 2/3 · 4s" status shows
// DURING the backoff, then ✓ on recover. Off in production (registered only under RLM_MOCK).
export const MOCK_RATELIMIT_TOOL: AxFunction = {
  name: "mock_ratelimit",
  description: "TEST ONLY: replay a 429-then-recover node (visible retry backoff) for the headless TUI harness.",
  parameters: { type: "object", properties: {}, required: [] },
  func: async (_args: unknown, extra?: Readonly<{ sessionId?: string; abortSignal?: AbortSignal }>) => {
    await feedRateLimitNodes(getTurnEmit(extra?.sessionId), extra?.abortSignal)
    return "scanned routes (recovered after a rate-limit retry)"
  },
}
