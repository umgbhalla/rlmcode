// The canned AI service — split from mock.ts so it imports NOTHING from agent.ts
// (mock.ts → agent.ts; agent.ts → mock-ai.ts for the RLM_MOCK seam; keeping the AI
// builder here breaks that cycle). Zero network, zero Cloudflare.
import { AxMockAIService, type AxChatRequest, type AxChatResponse } from "@ax-llm/ax"
import type { ActivitySink } from "./orch.ts"

// TEST-ONLY per-turn activity sink (off in prod — only reachable under RLM_MOCK). The activity
// bus is per-turn now (no module-global sink): turn() threads runTurn's per-turn `emit` here via
// setMockEmit() at the top of each turn, so the GROUP variant below can surface its tool-CALL
// rows onto THIS turn's live feed (AxMockAIService.chat() bypasses ax's response logging, so
// those rows would otherwise never render). Absent ⇒ no-op (a direct ai.chat() caller with no
// turn boundary, e.g. mock.test). Re-set per turn, so two turns never cross-feed.
const mockEmitState: { sink: ActivitySink } = { sink: () => {} }
export const setMockEmit = (emit: ActivitySink): void => {
  mockEmitState.sink = emit
}

// The model id the mock answers as — a fixed fake so meta/tracing read a stable value.
export const MOCK_MODEL = "@mock/kimi"

// Canned reasoning (thinking) — surfaced on the response result's `thought` field, the
// same slot a real thinking model (Kimi/GLM) fills with reasoning_content.
const MOCK_THOUGHT =
  "User wants the file count. I'll grep the source dir, then report the number."

// The scripted reply — the final assistant text once the tool loop finishes. Markdown,
// since the UI renders GitHub-flavored markdown (chat.tsx).
const MOCK_REPLY = "Found **3 matches** in `src/`. Done."

// CODE variant reply: a fenced ```ts block so the reply <markdown> runs its tree-sitter code
// highlighter through the now-populated SyntaxStyle (theme.ts makeSyntaxStyle). The theme frame
// test drives a "show code" turn and asserts the code body renders (proving syntax scopes wired,
// not the bare SyntaxStyle.create() that highlighted nothing). Deterministic, harmless content.
const MOCK_CODE_REPLY = 'Here:\n\n```ts\nconst greet = "hello"\nconsole.log(greet)\n```'
const wantsCode = (req: Readonly<AxChatRequest<unknown>>): boolean => {
  const users = req.chatPrompt.filter((m) => m.role === "user")
  const last = users[users.length - 1]
  return last !== undefined && typeof last.content === "string" && /show code/i.test(last.content)
}

// One canned tool call: a `bash` invocation the real tool loop executes (the BASE_TOOLS
// bash runs unsandboxed, so the args are a harmless echo — deterministic stdout).
const MOCK_TOOL = {
  id: "call_mock_1",
  type: "function" as const,
  function: { name: "bash", params: JSON.stringify({ command: "echo mock" }) },
}

// ORCH variant: when the user message asks to orchestrate, the mock instead calls the
// test-only `mock_orch` tool (registered under the RLM_MOCK seam in agent.ts). That tool
// replays the canned NodeEvent feed (mock.ts) through the REAL activity bus, so the REAL
// atoms node-routing + REAL flatten() draw the velocity tree in the live UI — no network,
// no real orchestration. Keyed off the prompt so the same scriptedChat covers both the
// plain tool-loop and the orch-tree frame test deterministically.
const MOCK_ORCH_TOOL = {
  id: "call_mock_orch",
  type: "function" as const,
  function: { name: "mock_orch", params: JSON.stringify({}) },
}

// GROUP variant: when the user message asks to explore, the mock scripts THREE CONSECUTIVE
// explore tool calls (read_file → glob → grep) in ONE tool-loop step. ax executes all three,
// appends their results to memory, then calls again → the final reply. These land as three
// TURN STEPS (no nodeId → main transcript), so chat.tsx's groupSteps() collapses them into a
// single "⊙ explored 3 (1 read · 1 glob · 1 grep)" row — the render path the per-node tool
// test never hits (it routes tools UNDER a node, not into turn steps). Args are harmless real
// ops over this repo (read AGENTS.md, glob the source tree, grep a literal): the unsandboxed
// BASE_TOOLS succeed, so each step settles status:"ok" (NOT error) — exactly what grouping
// requires (an errored explore tool is excluded from the group).
const MOCK_GROUP_TOOLS = [
  { id: "call_grp_read", type: "function" as const, function: { name: "read_file", params: JSON.stringify({ path: "AGENTS.md", limit: 1 }) } },
  { id: "call_grp_glob", type: "function" as const, function: { name: "glob", params: JSON.stringify({ pattern: "src/*.ts" }) } },
  { id: "call_grp_grep", type: "function" as const, function: { name: "grep", params: JSON.stringify({ pattern: "ponytail" }) } },
]
const wantsGroup = (req: Readonly<AxChatRequest<unknown>>): boolean => {
  const users = req.chatPrompt.filter((m) => m.role === "user")
  const last = users[users.length - 1]
  return last !== undefined && typeof last.content === "string" && /explore/i.test(last.content)
}
// AxMockAIService.chat() bypasses base.ts's response-logging, so unlike a real provider it
// NEVER fires the ChatResponseResults logger event that the activity bus turns into tool-CALL
// rows (kind:"tool"). The gen loop still logs FunctionResults (kind:"result"), but a result
// with no prior call is dropped by atoms' in-place settle, so the mock's tool STEPS never
// render. For the group variant we need the three explore steps to land as turn steps, so we
// emit their tool-call activities ourselves — exactly what logResponse would have, onto the
// THIS turn's per-turn emit (set by setMockEmit at turn start). Scoped to the group path so the
// existing single-bash/orch frame fixtures are byte-unchanged.
const emitGroupCalls = (): void => {
  for (const c of MOCK_GROUP_TOOLS) mockEmitState.sink({ kind: "tool", id: c.id, name: c.function.name, args: c.function.params })
}
// Route on the CURRENT turn's user message (the LAST user turn), not "any historical user
// message" — a shared session memory retains prior turns, so matching any of them would make
// every later turn orchestrate once one did. The last user message is this turn's request.
const wantsOrch = (req: Readonly<AxChatRequest<unknown>>): boolean => {
  const users = req.chatPrompt.filter((m) => m.role === "user")
  const last = users[users.length - 1]
  return last !== undefined && typeof last.content === "string" && /orchestrate/i.test(last.content)
}

// FAIL variant: when the user message asks to "fail", scriptedChat THROWS, so the REAL turn
// loop's catchCause (run.ts errorResult) maps it to a "⚠ …" reply — the deterministic path the
// transcript ERROR CARD renders (messages.tsx ErrorCard). Keyed off the prompt like the other
// variants so one scriptedChat covers the error frame test without a real provider failure.
const wantsFail = (req: Readonly<AxChatRequest<unknown>>): boolean => {
  const users = req.chatPrompt.filter((m) => m.role === "user")
  const last = users[users.length - 1]
  return last !== undefined && typeof last.content === "string" && /\bfail\b/i.test(last.content)
}

// Fixed usage triple (prompt/completion/total + reasoning) so token meta + cost-meter
// read deterministic numbers. reasoningTokens drives the THINKING attribution path.
const MOCK_TOKENS = { promptTokens: 100, completionTokens: 40, totalTokens: 140, reasoningTokens: 25 }

// The SCRIPTED chat() — ax calls chat() once per step: a turn with a tool result for THIS
// turn in the prompt returns the final content + thought; otherwise it returns a
// functionCalls step (ax executes the tool, appends the result to mem, calls again).
// Stateful by request SHAPE, not a module counter — deterministic and re-entrant.
//
// MULTI-TURN CORRECTNESS: a shared session memory (AxMemory) retains PRIOR turns' function
// results, so "is there any function message?" wrongly fires on every later turn's FIRST
// call — the mock would skip the tool step and never reach mock_orch. The right signal is a
// function result for the CURRENT turn: a function message AFTER the LAST user message.
const hasCurrentTurnToolResult = (req: Readonly<AxChatRequest<unknown>>): boolean => {
  const lastUser = req.chatPrompt.map((m) => m.role).lastIndexOf("user")
  return req.chatPrompt.slice(lastUser + 1).some((m) => m.role === "function")
}
const scriptedChat = (req: Readonly<AxChatRequest<unknown>>): Promise<AxChatResponse> => {
  // FAIL turn: reject so the REAL catchCause maps it to a "⚠ …" reply → the transcript ErrorCard.
  if (wantsFail(req)) return Promise.reject(new Error("mock turn failed on request"))
  const hasToolResult = hasCurrentTurnToolResult(req)
  // The explore turn fans out the read/glob/grep cluster (grouping path); the orchestrate
  // turn calls mock_orch; everything else runs the single bash step. One call returns one
  // step's functionCalls — the group variant returns all three at once.
  const calls = wantsGroup(req) ? MOCK_GROUP_TOOLS : wantsOrch(req) ? [MOCK_ORCH_TOOL] : [MOCK_TOOL]
  // On the tool-call step of an explore turn, surface the cluster's calls to the activity bus
  // (the mock service doesn't, see emitGroupCalls) so the three explore steps render + group.
  if (!hasToolResult && wantsGroup(req)) emitGroupCalls()
  // The final reply is the fenced code block for a "show code" turn (syntax-highlight render
  // path), else the standard MOCK_REPLY. Both arrive once the (single bash) tool step settles.
  const reply = wantsCode(req) ? MOCK_CODE_REPLY : MOCK_REPLY
  const result = hasToolResult
    ? { index: 0, content: reply, thought: MOCK_THOUGHT, finishReason: "stop" as const }
    : { index: 0, content: "", thought: MOCK_THOUGHT, functionCalls: calls, finishReason: "function_call" as const }
  return Promise.resolve({
    remoteId: "mock-resp-1",
    results: [result],
    modelUsage: { ai: "mock", model: MOCK_MODEL, tokens: MOCK_TOKENS },
  })
}

// The reply split into a few literal pieces so the STREAMING variant yields incremental
// `content` deltas (the same shape a real provider streams) — ax assembles them back into
// MOCK_REPLY, so the resolved turn result is byte-identical to the non-streaming path.
const REPLY_PIECES = ["Found **3 ", "matches** in ", "`src/`. Done."] as const

// STREAMING variant of the FINAL reply step: a real `ReadableStream<AxChatResponse>` whose
// chunks carry the cumulative `thought` (reasoning_content, sent first — the model reasons,
// then answers) and then incremental `content` pieces. ax consumes this as a stream and
// fires the per-chunk logger (ChatResponseStreamingResult) the activity bus turns into
// thinkingDelta/replyDelta → the live thinking block + streamed reply cursor in chat.tsx.
// NOT a fake: it is ax's documented streaming surface (chatResponse may return a
// ReadableStream), exercising the SAME render path the real CF-Kimi stream drives.
// RLM_MOCK_DELAY_MS (default 0) paces the stream: a pause after the thought chunk and between
// reply pieces, so the busy/thinking state is HOLDABLE for a screenshot/recording and the demo
// looks like a real turn (not a sub-second flash). Default 0 keeps the frame tests fast +
// deterministic (they assert the settled frame, not timing). ponytail: a fixed sleep, not a
// token-rate model. Upgrade: pace by real CF inter-chunk latency if a recording needs it.
const MOCK_DELAY_MS = Number(process.env.RLM_MOCK_DELAY_MS ?? 0)
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
const streamReply = (): ReadableStream<AxChatResponse> => {
  const usage = { ai: "mock", model: MOCK_MODEL, tokens: MOCK_TOKENS }
  return new ReadableStream<AxChatResponse>({
    async start(c) {
      // 1) reasoning_content first (cumulative thought, no content yet → thinking block).
      c.enqueue({ remoteId: "mock-resp-1", results: [{ index: 0, content: "", thought: MOCK_THOUGHT }], modelUsage: usage })
      await sleep(MOCK_DELAY_MS) // hold the thinking state (capture/demo); no-op when unset
      // 2) the reply, piece by piece (each chunk is the incremental delta ax appends).
      for (let i = 0; i < REPLY_PIECES.length; i++) {
        const last = i === REPLY_PIECES.length - 1
        c.enqueue({ remoteId: "mock-resp-1", results: [{ index: 0, content: REPLY_PIECES[i]!, ...(last ? { finishReason: "stop" as const } : {}) }], modelUsage: usage })
        if (!last) await sleep(Math.round(MOCK_DELAY_MS / 3))
      }
      c.close()
    },
  })
}

// The streaming scriptedChat: the FINAL reply step (tool result present, non-orch turn)
// streams; the tool-call step and orch turns stay plain (their reply is the orch tree, not
// streamed prose). Returns a ReadableStream only where the live render is under test.
const scriptedStreamChat = (req: Readonly<AxChatRequest<unknown>>): Promise<AxChatResponse | ReadableStream<AxChatResponse>> =>
  hasCurrentTurnToolResult(req) && !wantsOrch(req) && !wantsGroup(req) ? Promise.resolve(streamReply()) : scriptedChat(req)

// The canned AI service — ax's real AxMockAIService with our scripted chat. `functions:
// true` so ax permits the tool-call path. `streaming` toggles the live-delta variant (used
// only by the streaming frame test via RLM_MOCK_STREAM); default false keeps direct
// `ai.chat()` callers (mock.test) on the single-response contract. Built fresh per call so
// two harnesses never share latch state.
export const makeMockAI = (streaming = false): AxMockAIService<string> =>
  new AxMockAIService<string>({
    name: "mock",
    id: "mock-ai",
    modelInfo: { name: MOCK_MODEL, provider: "mock" },
    features: { functions: true, streaming },
    chatResponse: streaming ? scriptedStreamChat : scriptedChat,
  })

// The canned reply/thought/usage are re-exported so a headless test can assert the
// EXACT strings the mock yields (the determinism contract).
export const MOCK_FIXTURE = { reply: MOCK_REPLY, thought: MOCK_THOUGHT, tokens: MOCK_TOKENS } as const
