#!/usr/bin/env bun
// UNIT proof for D4 — runRlm's "answer is ALWAYS returned" contract. NO network: it injects a
// stub AxAIService whose chat() REJECTS, so the internal rlm.forward() rejects.
//
// The DEFECT (ENGINE-HARDEN.md D4): runRlm awaited withTimeout(rlm.forward(...)) with NO
// try/catch, so a forward rejection (provider/network fault), a NodeTimeoutError (hung run), or a
// HARD-ceiling BudgetExhaustedError from the tail budget.charge propagated UNCAUGHT — violating
// the contract (rlm-node.ts:21-23) that "the RLM answer is ALWAYS returned" and breaking direct
// callers (scripts/telemetry-live.test.ts calls runRlm bare). The FIX: wrap the forward + tail
// charge so any fault emits an error on the root node and returns a PARTIAL
// { answer: "", evidence: [], turns, callbacks } instead of throwing.
//
// This drives the REAL runRlm (the exact function the rlm() prim + the telemetry harness call)
// with a provider that faults, and asserts: (1) it RESOLVES (does not throw/reject), (2) to the
// partial shape (empty answer + evidence, counters present), (3) an error NodeEvent was emitted on
// the root node so the fault is visible in the tree. Runs in `bun run test` (the lint gate).

import { AxMockAIService } from "@ax-llm/ax"
import type { NodeEvent } from "../src/core/orch.ts"
import { runRlm } from "../src/core/rlm-node.ts"

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

// A provider whose chat() ALWAYS rejects — the deterministic stand-in for a forward fault
// (network drop / 5xx / the RLM actor loop throwing). Same construction shape as makeMockAI, but
// the scripted response rejects instead of returning canned results, so rlm.forward() inside
// runRlm rejects and exercises the D4 catch. Zero network.
const makeFaultingAI = (): AxMockAIService<string> =>
  new AxMockAIService<string>({
    name: "mock",
    id: "mock-fault",
    modelInfo: { name: "@mock/fault", provider: "mock" },
    features: { functions: true, streaming: false },
    chatResponse: () => Promise.reject(new Error("forced provider fault (D4 unit)")),
  })

await (async () => {
  console.log("D4 — runRlm returns a PARTIAL on a forward fault, never throws")
  const events: NodeEvent[] = []
  const onEvent = (e: NodeEvent): void => void events.push(e)

  let threw = false
  let out: { answer: string; evidence: string[]; turns: number; callbacks: number } | undefined
  try {
    // Drive the REAL runRlm with the faulting provider. A bare AbortController signal (never
    // aborted) so the fault — not a cancel — is what we exercise. rootId nests the (empty) node.
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

  assert(!threw, "(D4) runRlm RESOLVED on a forward fault (did not throw/reject) — honors the contract")
  assert(out !== undefined, "(D4) runRlm returned a result object")
  assert(out?.answer === "", "(D4) the partial has an EMPTY answer (no fabricated text)")
  assert(Array.isArray(out?.evidence) && out!.evidence.length === 0, "(D4) the partial has empty evidence")
  assert(typeof out?.turns === "number" && typeof out?.callbacks === "number", "(D4) turns/callbacks counters are present (telemetry harness reads them)")
  assert(
    events.some((e) => e.type === "error" && e.nodeId === "d4-unit-rlm"),
    "(D4) an error NodeEvent was emitted on the root node — the fault is visible in the tree",
  )
})()

if (failures > 0) {
  console.error(`\nrlm-contract.test: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log("\nrlm-contract.test: all pass ✓")
