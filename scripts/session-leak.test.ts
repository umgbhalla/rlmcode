#!/usr/bin/env bun
// UNIT proof for D3 — the per-session module-Map LEAK. NO network, NO CF creds (RLM_MOCK=1
// swaps the canned mock AI). The DEFECT (ENGINE-HARDEN.md D3): four module Maps are keyed by a
// never-reused sessionId and SET per turn but never dropped — sessionsRT (sessions.ts), turnEmits
// (runtime.ts), turnCtx (orch-spans.ts) and turnAborters (closed over per agent in agent.ts) —
// so a long-lived process accumulates one dead entry per Map per session forever. deleteSession
// only dropped sessionsRT. The FIX: deleteSession now also calls clearTurnEmit / clearTurnContext
// / clearTurnAborter so ALL FOUR free the session's entry on close.
//
// This drives the REAL code: it populates turnEmits + turnCtx via their public setters, populates
// turnAborters by driving a REAL mock turn through the REAL createAgent/makeRunTurn boundary (the
// turn() generator is the ONLY thing that sets turnAborters), then asserts deleteSession drops the
// session's entry from EVERY Map. Runs in `bun run test` (the lint gate); no live flag.

// Swap the mock AI BEFORE importing the engine (read at module load). Zero network.
process.env.RLM_MOCK = "1"

import { context as otelContext } from "@opentelemetry/api"
import { makeMockAI, MOCK_MODEL } from "../src/core/mock-ai.ts"
import { BASE_TOOLS } from "../src/core/tools.ts"
import { clearTurnAborter, createAgent } from "../src/core/agent.ts"
import { clearTurnContext, setTurnContext } from "../src/core/orch-spans.ts"
import { clearTurnEmit, setTurnEmit } from "../src/core/runtime.ts"
import { deleteSession, ensureSession, sessionsRT } from "../src/core/sessions.ts"
import { makeRunTurn } from "../src/core/run.ts"

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

// Drain a runTurn AsyncGenerator to completion (we only care that the turn RAN — it populates
// turnAborters as a side effect inside turn()). The mock AI makes this zero-network + fast.
const drive = async (runTurn: ReturnType<typeof makeRunTurn>, sessionId: string): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of runTurn(sessionId, "hi")) {
    /* drain — the side effect (turnAborters.set inside turn()) is what we assert on */
  }
}

const N = 5
const ids = Array.from({ length: N }, (_, i) => `leak-sess-${i}`)

// A real agent over the canned mock AI — createAgent registers its turnAborters clearer in the
// module-level registry, and makeRunTurn drives turn() (which sets turnAborters per session).
const agent = createAgent({ ai: makeMockAI(), model: MOCK_MODEL, tools: [...BASE_TOOLS] })
const runTurn = makeRunTurn(agent)

await (async () => {
  // POPULATE all four Maps for N sessions:
  //  - sessionsRT via ensureSession (the runtime-object store)
  //  - turnEmits via setTurnEmit, turnCtx via setTurnContext (their public per-turn setters)
  //  - turnAborters by driving ONE real mock turn per session (the only writer)
  for (const id of ids) {
    ensureSession(id)
    setTurnEmit(id, () => {})
    setTurnContext(id, otelContext.active())
    await drive(runTurn, id)
  }

  // BEFORE delete: every Map holds the session — assert the entries are actually present, so the
  // "shrank" assertion below is meaningful (not vacuously true on an empty Map).
  assert(sessionsRT.has(ids[0]!), "(setup) sessionsRT holds the session before delete")
  // The turn-keyed Maps are private; probe presence via the clearer's boolean on a THROWAWAY id
  // pattern would mutate them, so instead assert presence indirectly after delete (below). Here we
  // assert the turn actually populated turnAborters by re-aborting: a populated aborter that has
  // NOT yet been aborted returns true from abortTurn; an absent/leak-cleared one returns false.
  assert(agent.abortTurn(ids[0]!) === true, "(setup) turnAborters holds a live controller after a turn ran")

  const sizeBefore = sessionsRT.size
  assert(sizeBefore >= N, `(setup) sessionsRT has >= ${N} sessions (got ${sizeBefore})`)

  // DELETE every session — the fix must drop the entry from ALL FOUR Maps.
  for (const id of ids) deleteSession(id)

  // AFTER delete: sessionsRT shrank by exactly N.
  assert(sessionsRT.size === sizeBefore - N, `(D3) sessionsRT shrank by ${N} after deleteSession (got ${sessionsRT.size}, was ${sizeBefore})`)
  assert(!sessionsRT.has(ids[0]!), "(D3) sessionsRT no longer holds a deleted session")

  // AFTER delete the turn-keyed Maps must NOT hold the session either. The clearers return whether
  // an entry STILL existed; after deleteSession they must all be gone, so a SECOND clear returns
  // false for every Map and every session. (A leak would leave the entry → true here.)
  let emitLeak = 0
  let ctxLeak = 0
  let aborterLeak = 0
  for (const id of ids) {
    if (clearTurnEmit(id)) emitLeak += 1
    if (clearTurnContext(id)) ctxLeak += 1
    if (clearTurnAborter(id)) aborterLeak += 1
  }
  assert(emitLeak === 0, `(D3) turnEmits dropped on deleteSession — no leaked emit entry (leaked ${emitLeak})`)
  assert(ctxLeak === 0, `(D3) turnCtx dropped on deleteSession — no leaked context entry (leaked ${ctxLeak})`)
  assert(aborterLeak === 0, `(D3) turnAborters dropped on deleteSession — no leaked controller entry (leaked ${aborterLeak})`)

  // The deleted session's aborter is truly gone: abortTurn now returns false (nothing to abort).
  assert(agent.abortTurn(ids[0]!) === false, "(D3) abortTurn on a deleted session is a no-op (controller freed)")
})()

if (failures > 0) {
  console.error(`\nsession-leak.test: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log("\nsession-leak.test: all pass ✓")
// otel SDK (eager appRuntime boot via sessions.ts) holds live exporters/timers that keep the
// event loop alive forever → a plain fall-off-the-end never exits and stalls the `&&` test chain.
// Every other test either exits naturally or process.exit(1) on failure; mirror that on success.
process.exit(0)
