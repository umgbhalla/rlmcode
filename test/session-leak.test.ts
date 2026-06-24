// SESSION LEAK (adoption #9 + #10 + #14): the FOUR leak-prone per-session module Maps (sessionsRT,
// turnEmits, turnCtx, turnAborters + the aborterClearers Set) are now ONE SessionState cell owned by
// the SessionServices LayerMap. This proves: (a) the single store holds the per-turn emit/ctx/aborter
// that used to live in four Maps, populated by driving a REAL mock turn; (b) deleteSession frees the
// cell from the one store — no per-Map fan-out, no leak. (The idle auto-release is proven separately
// in session-memo.test.ts with TestClock.)
//
// NO network (RLM_MOCK=1 swaps the canned mock AI, read at module load before the dynamic imports).
// it.live so the REAL mock turn loop runs on the real runtime.
import { context as otelContext } from "@opentelemetry/api"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

process.env.RLM_MOCK = "1"

const { makeMockAI, MOCK_MODEL } = await import("../src/core/mock-ai.ts")
const { BASE_TOOLS } = await import("../src/core/tools.ts")
const { createAgent } = await import("../src/core/agent.ts")
const { setTurnContext } = await import("../src/core/orch-spans.ts")
const { deleteSession, ensureSession, getTurnEmit, getTurnContext, sessionsRT, setTurnEmit } = await import(
  "../src/core/sessions.ts"
)
const { makeRunTurn } = await import("../src/core/run.ts")

const drive = async (runTurn: ReturnType<typeof makeRunTurn>, sessionId: string): Promise<void> => {
  for await (const _ of runTurn(sessionId, "hi")) {
    /* drain — the side effect (the cell's aborter/emit set inside turn()) is what we assert on */
    void _
  }
}

it.live("ONE SessionState cell unifies the four old Maps, and deleteSession frees it (no leak)", () =>
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

    // SINGLE STORE: the emit + ctx + aborter that used to be three separate Maps now all read off
    // the one cell. A turn ran, so its controller settled (auto-cleared by the turn-exit finalizer).
    expect(sessionsRT.has(ids[0]!), "(setup) the single store holds the session before delete").toBe(true)
    expect(typeof getTurnEmit(ids[0]!), "(single store) the cell carries the per-turn emit").toBe("function")
    expect(getTurnContext(ids[0]!) !== undefined, "(single store) the cell carries the per-turn ctx").toBe(true)
    expect(
      agent.abortTurn(ids[0]!),
      "(#14) the controller auto-finalized on turn exit — abort is a no-op on a settled turn",
    ).toBe(false)

    const sizeBefore = sessionsRT.size
    expect(sizeBefore, `(setup) the store has >= ${N} sessions`).toBeGreaterThanOrEqual(N)

    for (const id of ids) deleteSession(id)

    // LEAK FIX: one deleteSession frees the whole cell — all four old Maps at once.
    expect(sessionsRT.size, `(#9) the store shrank by ${N} after deleteSession`).toBe(sizeBefore - N)
    expect(sessionsRT.has(ids[0]!), "(#9) the store no longer holds a deleted session").toBe(false)
    let leaked = 0
    for (const id of ids) {
      if (sessionsRT.has(id)) leaked += 1
      if (getTurnContext(id) !== undefined) leaked += 1
    }
    expect(leaked, "(#9) NO session leaks any cell/ctx after deleteSession").toBe(0)
    expect(agent.abortTurn(ids[0]!), "(#9) abortTurn on a deleted session is a no-op (cell freed)").toBe(false)
  }),
)
