// @effect/vitest port of scripts/rlm-contract.test.ts — D4: runRlm's "answer is ALWAYS returned"
// contract. NO network: a stub AxAIService whose chat() REJECTS, so the internal rlm.forward()
// rejects. Asserts runRlm RESOLVES to the partial shape (empty answer + evidence, counters
// present) and emits an error NodeEvent on the root node. Uses it.live (real runtime; the RLM
// path uses real timers internally).
import { AxMockAIService } from "@ax-llm/ax"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { NodeEvent } from "../src/core/orch.ts"
import { runRlm } from "../src/core/rlm-node.ts"

// A provider whose chat() ALWAYS rejects — the deterministic stand-in for a forward fault.
const makeFaultingAI = (): AxMockAIService<string> =>
  new AxMockAIService<string>({
    name: "mock",
    id: "mock-fault",
    modelInfo: { name: "@mock/fault", provider: "mock" },
    features: { functions: true, streaming: false },
    chatResponse: () => Promise.reject(new Error("forced provider fault (D4 unit)")),
  })

it.live("runRlm returns a PARTIAL on a forward fault, never throws, and emits a root error event", () =>
  Effect.promise(async () => {
    const events: Array<NodeEvent> = []
    const onEvent = (e: NodeEvent): void => void events.push(e)

    let threw = false
    let out: { answer: string; evidence: Array<string>; turns: number; callbacks: number } | undefined
    try {
      out = await runRlm(
        "some big blob of context to mine",
        "which function does X?",
        makeFaultingAI(),
        "d4-unit-rlm",
        new AbortController().signal,
        onEvent,
      )
    } catch {
      threw = true
    }

    expect(threw, "runRlm RESOLVED on a forward fault (did not throw/reject)").toBe(false)
    expect(out, "runRlm returned a result object").toBeDefined()
    expect(out?.answer, "the partial has an EMPTY answer (no fabricated text)").toBe("")
    expect(Array.isArray(out?.evidence) && out!.evidence.length === 0, "the partial has empty evidence").toBe(true)
    expect(typeof out?.turns === "number" && typeof out?.callbacks === "number", "turns/callbacks counters are present").toBe(true)
    expect(
      events.some((e) => e.type === "error" && e.nodeId === "d4-unit-rlm"),
      "an error NodeEvent was emitted on the root node — the fault is visible in the tree",
    ).toBe(true)
  }),
)
