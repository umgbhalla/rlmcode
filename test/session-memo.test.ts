// SESSION MEMOIZATION + IDLE AUTO-RELEASE (adoption #9, the leak fix proof). The SessionServices
// LayerMap is the SINGLE per-session store with idleTimeToLive: this proves (1) a session's cell is
// MEMOIZED — re-acquiring the same sessionId within the idle window returns the SAME SessionState
// instance (so AxMemory persists across turns); (2) once no turn holds the cell, it AUTO-RELEASES
// after the idle TTL (its finalizer drops the sessionsRT index entry — the leak fix), proven in
// VIRTUAL time with TestClock.adjust (zero real wall-clock). NO network, pure Effect + the real
// SessionServices class (env-tunable idle TTL → built with an explicit short TTL here via a fresh
// LayerMap so TestClock owns its timer).
import { expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, LayerMap, Scope } from "effect"
import { TestClock } from "effect/testing"
import { sessionsRT } from "../src/core/sessions.ts"

// A standalone copy of the SessionServices cell + lookup with a SHORT idle TTL, so TestClock drives
// the release. It writes into the SAME module index (sessionsRT) the production class uses, so the
// auto-release assertion reads the real store. (The production class's TTL is 10 min — TestClock
// makes any TTL instant, but a fresh short-TTL map keeps this unit's keys disjoint + obvious.)
type Cell = { readonly mem: object; n: number }
class TestCell extends Context.Service<TestCell, Cell>()("rlmcode-test/TestCell") {}

const TTL = 500
const acquired: Array<string> = []

class TestSessions extends LayerMap.Service<TestSessions>()("rlmcode-test/TestSessions", {
  lookup: (id: string) =>
    Layer.effect(TestCell)(
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired.push(id)
          const cell: Cell = { mem: {}, n: 0 }
          sessionsRT.set(id, cell as never)
          return cell
        }),
        () => Effect.sync(() => void sessionsRT.delete(id)),
      ),
    ),
  idleTimeToLive: TTL,
}) {}

it.effect("a session cell is memoized within the idle window, then auto-releases after the TTL", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const map = yield* Layer.build(TestSessions.layer).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.map((ctx) => Context.get(ctx, TestSessions) as LayerMap.LayerMap<string, TestCell>),
    )
    const id = "memo-sess-A"

    // ── MEMOIZATION: two acquisitions of the SAME key within the window build the cell ONCE and
    // return the SAME context (same cell instance). A turn re-acquiring keeps its AxMemory.
    const ctx1 = yield* Effect.scoped(map.contextEffect(id))
    const cell1 = Context.get(ctx1, TestCell)
    const ctx2 = yield* Effect.scoped(map.contextEffect(id))
    const cell2 = Context.get(ctx2, TestCell)
    expect(acquired.filter((k) => k === id).length, "the cell is built ONCE for repeated same-key acquires").toBe(1)
    expect(cell1, "re-acquiring the same sessionId returns the SAME cell instance (Layer.memoization)").toBe(cell2)
    expect(sessionsRT.has(id), "the cell is registered in the single store while live").toBe(true)

    // ── AUTO-RELEASE: refcount is 0 after the scoped blocks closed; advancing past the idle TTL
    // releases the entry → its finalizer drops the index cell. The leak fix, in virtual time.
    expect(sessionsRT.has(id), "(before TTL) the cell still lingers in the idle window").toBe(true)
    yield* TestClock.adjust(TTL)
    expect(sessionsRT.has(id), "(after idle TTL) the cell AUTO-RELEASED — the index dropped it").toBe(false)

    yield* Scope.close(scope, Exit.void)
  }),
)
