// The canned AI service — split from mock.ts so it imports NOTHING from agent.ts
// (mock.ts → agent.ts; agent.ts → mock-ai.ts for the AX2_MOCK seam; keeping the AI
// builder here breaks that cycle). Zero network, zero Cloudflare.
import { AxMockAIService, type AxChatRequest, type AxChatResponse } from "@ax-llm/ax"

// The model id the mock answers as — a fixed fake so meta/tracing read a stable value.
export const MOCK_MODEL = "@mock/kimi"

// Canned reasoning (thinking) — surfaced on the response result's `thought` field, the
// same slot a real thinking model (Kimi/GLM) fills with reasoning_content.
const MOCK_THOUGHT =
  "User wants the file count. I'll grep the source dir, then report the number."

// The scripted reply — the final assistant text once the tool loop finishes. Markdown,
// since the UI renders GitHub-flavored markdown (chat.tsx).
const MOCK_REPLY = "Found **3 matches** in `src/`. Done."

// One canned tool call: a `bash` invocation the real tool loop executes (the BASE_TOOLS
// bash runs unsandboxed, so the args are a harmless echo — deterministic stdout).
const MOCK_TOOL = {
  id: "call_mock_1",
  type: "function" as const,
  function: { name: "bash", params: JSON.stringify({ command: "echo mock" }) },
}

// ORCH variant: when the user message asks to orchestrate, the mock instead calls the
// test-only `mock_orch` tool (registered under the AX2_MOCK seam in agent.ts). That tool
// replays the canned NodeEvent feed (mock.ts) through the REAL activity bus, so the REAL
// atoms node-routing + REAL flatten() draw the velocity tree in the live UI — no network,
// no real orchestration. Keyed off the prompt so the same scriptedChat covers both the
// plain tool-loop and the orch-tree frame test deterministically.
const MOCK_ORCH_TOOL = {
  id: "call_mock_orch",
  type: "function" as const,
  function: { name: "mock_orch", params: JSON.stringify({}) },
}
const wantsOrch = (req: Readonly<AxChatRequest<unknown>>): boolean =>
  req.chatPrompt.some((m) => m.role === "user" && typeof m.content === "string" && /orchestrate/i.test(m.content))

// Fixed usage triple (prompt/completion/total + reasoning) so token meta + cost-meter
// read deterministic numbers. reasoningTokens drives the THINKING attribution path.
const MOCK_TOKENS = { promptTokens: 100, completionTokens: 40, totalTokens: 140, reasoningTokens: 25 }

// The SCRIPTED chat() — ax calls chat() once per step: a turn with a prior tool result in
// the prompt returns the final content + thought; otherwise it returns a functionCalls
// step (ax executes the tool, appends the result to mem, calls again). Stateful by request
// shape, not a module counter — deterministic and re-entrant (a fresh memory restarts it).
const scriptedChat = (req: Readonly<AxChatRequest<unknown>>): Promise<AxChatResponse> => {
  const hasToolResult = req.chatPrompt.some((m) => m.role === "function")
  const tool = wantsOrch(req) ? MOCK_ORCH_TOOL : MOCK_TOOL
  const result = hasToolResult
    ? { index: 0, content: MOCK_REPLY, thought: MOCK_THOUGHT, finishReason: "stop" as const }
    : { index: 0, content: "", thought: MOCK_THOUGHT, functionCalls: [tool], finishReason: "function_call" as const }
  return Promise.resolve({
    remoteId: "mock-resp-1",
    results: [result],
    modelUsage: { ai: "mock", model: MOCK_MODEL, tokens: MOCK_TOKENS },
  })
}

// The canned AI service — ax's real AxMockAIService with our scripted chat. `functions:
// true` so ax permits the tool-call path; `streaming: false` matches the app (stream:false
// in agent.ts). Built fresh per call so two harnesses never share latch state.
export const makeMockAI = (): AxMockAIService<string> =>
  new AxMockAIService<string>({
    name: "mock",
    id: "mock-ai",
    modelInfo: { name: MOCK_MODEL, provider: "mock" },
    features: { functions: true, streaming: false },
    chatResponse: scriptedChat,
  })

// The canned reply/thought/usage are re-exported so a headless test can assert the
// EXACT strings the mock yields (the determinism contract).
export const MOCK_FIXTURE = { reply: MOCK_REPLY, thought: MOCK_THOUGHT, tokens: MOCK_TOKENS } as const
