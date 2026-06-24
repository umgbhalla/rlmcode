// LAYER-INJECTED MOCK AxAIService (adoption D / #11 Layer mocks) — the clean exit from the
// switch-on-prompt singleton (`src/core/mock-ai.ts` keys its canned reply off a prompt regex, so
// every new variant grows a global keyword). Here a test declares its OWN canned `chatResponse`
// and provides it as a Layer value: `Effect.provide(AxAI.layer(chatResponse))`, read back inside
// the test with `yield* AxAI` — no global keyword, no shared singleton, one mock per test.
//
// src/core/mock-ai.ts STAYS as-is for the TUI / RLM_MOCK headless path (it drives the REAL
// scriptedChat the frame gate asserts on); this file is the UNIT-test seam only.
import { AxMockAIService, type AxChatRequest, type AxChatResponse } from "@ax-llm/ax"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

// The canned chat() a test scripts: maps a request to a single response or a streaming one. The
// SAME shape ax's real chatResponse has, so the mock drives the REAL turn loop / streaming drain.
export type MockChat = (req: Readonly<AxChatRequest<unknown>>) => Promise<AxChatResponse | ReadableStream<AxChatResponse>>

// A keyed Context.Service for the injected AxAIService (a real AxMockAIService under the hood).
// `Layer.succeed(AxAI, …)` is memoized by reference (one instance across dependents), the v4
// answer to passing `ai` as a factory arg in a test. Production injects its own service via
// createAgent({ ai }); this tag is the test-graph leaf the deterministic units provide.
export class AxAI extends Context.Service<AxAI, AxMockAIService<string>>()("test/AxAI") {
  // Build the test layer from a scripted chat + a streaming flag. `id` keeps the model name stable
  // so meta/tracing read a deterministic value, mirroring mock-ai.ts's MOCK_MODEL contract.
  static layer = (chatResponse: MockChat, opts: { streaming?: boolean; model?: string } = {}): Layer.Layer<AxAI> =>
    Layer.succeed(
      AxAI,
      new AxMockAIService<string>({
        name: "mock",
        id: "test-ax-layer",
        modelInfo: { name: opts.model ?? "@mock/test", provider: "mock" },
        features: { functions: false, streaming: opts.streaming ?? false },
        chatResponse,
      }),
    )
}
