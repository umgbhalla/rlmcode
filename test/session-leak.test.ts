// @effect/vitest port of scripts/session-leak.test.ts — D3: the per-session module-Map LEAK.
// NO network (RLM_MOCK=1 swaps the canned mock AI). Drives the REAL code: populates turnEmits +
// turnCtx via their public setters, populates turnAborters by driving a REAL mock turn through
// createAgent/makeRunTurn, then asserts deleteSession drops the session's entry from EVERY Map.
//
// RLM_MOCK is set BEFORE the dynamic engine imports (read at module load). it.live so the REAL
// mock turn loop runs on the real runtime. (No process.exit needed — the vitest worker tears down
// even though the eager otel SDK holds live exporters/timers.)
import { context as otelContext } from "@opentelemetry/api"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

process.env.RLM_MOCK = "1"

const { makeMockAI, MOCK_MODEL } = await import("../src/core/mock-ai.ts")
const { BASE_TOOLS } = await import("../src/core/tools.ts")
const { clearTurnAborter, createAgent } = await import("../src/core/agent.ts")
const { clearTurnContext, setTurnContext } = await import("../src/core/orch-spans.ts")
const { clearTurnEmit, setTurnEmit } = await import("../src/core/runtime.ts")
const { deleteSession, ensureSession, sessionsRT } = await import("../src/core/sessions.ts")
const { makeRunTurn } = await import("../src/core/run.ts")

const drive = async (runTurn: ReturnType<typeof makeRunTurn>, sessionId: string): Promise<void> => {
  for await (const _ of runTurn(sessionId, "hi")) {
    /* drain — the side effect (turnAborters.set inside turn()) is what we assert on */
    void _
  }
}

it.live("deleteSession frees the session's entry from ALL FOUR per-session Maps (D3)", () =>
  Effect.promise(async () => {
    const N = 5
    const ids = Array.from({ length: N }, (_, i) => `leak-sess-${i}`)
    const agent = createAgent({ ai: makeMockAI(), model: MOCK_MODEL, tools: [...BASE_TOOLS] })
    const runTurn = makeRunTurn(agent)

    for (const id of ids) {
      ensureSession(id)
      setTurnEmit(id, () => {})
      setTurnContext(id, otelContext.active())
      await drive(runTurn, id)
    }

    expect(sessionsRT.has(ids[0]!), "(setup) sessionsRT holds the session before delete").toBe(true)
    expect(agent.abortTurn(ids[0]!), "(setup) turnAborters holds a live controller after a turn ran").toBe(true)

    const sizeBefore = sessionsRT.size
    expect(sizeBefore, `(setup) sessionsRT has >= ${N} sessions`).toBeGreaterThanOrEqual(N)

    for (const id of ids) deleteSession(id)

    expect(sessionsRT.size, `(D3) sessionsRT shrank by ${N} after deleteSession`).toBe(sizeBefore - N)
    expect(sessionsRT.has(ids[0]!), "(D3) sessionsRT no longer holds a deleted session").toBe(false)

    let emitLeak = 0
    let ctxLeak = 0
    let aborterLeak = 0
    for (const id of ids) {
      if (clearTurnEmit(id)) emitLeak += 1
      if (clearTurnContext(id)) ctxLeak += 1
      if (clearTurnAborter(id)) aborterLeak += 1
    }
    expect(emitLeak, "(D3) turnEmits dropped on deleteSession").toBe(0)
    expect(ctxLeak, "(D3) turnCtx dropped on deleteSession").toBe(0)
    expect(aborterLeak, "(D3) turnAborters dropped on deleteSession").toBe(0)

    expect(agent.abortTurn(ids[0]!), "(D3) abortTurn on a deleted session is a no-op (controller freed)").toBe(false)
  }),
)
