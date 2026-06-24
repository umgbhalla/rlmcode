// @effect/vitest port of scripts/turn-memo.test.ts — STATIC-COMMIT unit gate. Proves the
// TurnView memo comparator (src/tui/turn-memo.ts) skips the re-render for a SETTLED turn whose
// output is unchanged, and re-renders otherwise. Pure logic — no PTY — it.effect/sync.
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Msg, OrchTree } from "../src/tui/atoms.ts"
import { contentKey, interactionSig, isSettled, type MemoProps, turnPropsEqual, turnRowKeys } from "../src/tui/turn-memo.ts"
import { workflowRows } from "../src/tui/workflow.tsx"

const EMPTY: ReadonlySet<string> = new Set()
// A6: every Msg carries a per-session `seq` (minted on append). The fixture mints seq from the id
// digit (a1→1, b1→1, nt1→1) so equal-content fixtures share a stable seq and contentKey is stable.
const tool = (id: string, status: "running" | "ok" | "error"): Msg => ({ kind: "tool", seq: Number(id.replace(/\D/g, "")) || 0, id, name: "bash", args: "{}", status, result: "out" })

const settled = {
  idx: 0,
  user: "do the thing",
  steps: [tool("a1", "ok"), tool("a2", "ok")] as Array<Msg>,
  final: "done.",
  meta: { model: "kimi", ms: 1200, tokens: 800, budget: false },
  streaming: false,
}
const inflight = {
  idx: 1,
  user: "another",
  steps: [tool("b1", "running")] as Array<Msg>,
  final: "partial",
  streaming: true,
}

const orch: OrchTree = {
  roots: ["n1"],
  totalTokens: 500,
  nodes: { n1: { id: "n1", label: "scan", phase: "", status: "done", tokens: 500, tools: [tool("nt1", "ok")] } },
}
// FLATTEN MEMO (W3.2): a workflow turn now carries its assembly-flattened Row[] on `rows` (toTurns
// → t.rows); turnRowKeys reads it instead of re-flattening, so the fixture supplies it the same way.
const settledWf = { ...settled, idx: 2, workflow: orch, rows: workflowRows(orch, EMPTY) }

const STYLE = { style: "default" }
const props = (t: MemoProps["t"], over: Partial<Omit<MemoProps, "t">> = {}): MemoProps => ({
  t,
  first: false,
  expanded: false,
  expTools: EMPTY,
  expNodes: EMPTY,
  detailKey: null,
  focusedKey: undefined,
  cols: 80,
  syntaxStyle: STYLE,
  ...over,
})

const liveNodeOrch: OrchTree = {
  roots: ["r"],
  totalTokens: 0,
  nodes: { r: { id: "r", label: "fan-out", phase: "running", status: "running" } },
}
const settledButLiveNode = { ...settled, idx: 5, workflow: liveNodeOrch }

it.effect("isSettled + live-node never-settled", () =>
  Effect.sync(() => {
    expect(isSettled(settled), "a turn with a final reply and not streaming is settled").toBe(true)
    expect(isSettled(inflight), "a streaming turn is NOT settled").toBe(false)
    expect(isSettled({ idx: 9, user: "", steps: [], final: null }), "a turn with no final reply is NOT settled").toBe(false)
    expect(isSettled(settledButLiveNode), "a settled-reply turn with a RUNNING workflow node is NOT settled").toBe(false)
    expect(turnPropsEqual(props(settledButLiveNode), props({ ...settledButLiveNode })), "a turn with a live node ⇒ always re-render").toBe(false)
  }),
)

// FIRST-CLASS SETTLED BOUNDARY (W5.2, F12): isSettled now READS the assembly-stamped `settled` flag
// when present (toTurns stamps it once via the shared turnSettled predicate) and only FALLS BACK to
// re-deriving when it is absent (a raw fixture). Proves the memo no longer re-walks workflow.nodes on
// every compare — the boundary is a property of the assembled turn, inferred at the single site.
it.effect("isSettled reads the first-class settled stamp (F12), not a per-compare re-derivation", () =>
  Effect.sync(() => {
    // The stamp WINS over the raw signals: a turn whose raw signals say in-flight (a live workflow
    // node) but carries settled:true reads settled — proving isSettled consults the stamp, not nodes.
    expect(isSettled({ ...settledButLiveNode, settled: true }), "settled:true stamp ⇒ settled (no node re-walk)").toBe(true)
    // And the inverse: a turn whose raw signals say settled but carries settled:false reads NOT settled.
    expect(isSettled({ ...settled, settled: false }), "settled:false stamp ⇒ NOT settled (stamp wins)").toBe(false)
    // ABSENT stamp ⇒ fall back to the shared predicate, identical to the old derivation (back-compat).
    expect(isSettled(settled), "absent stamp ⇒ derived-settled (fallback to turnSettled)").toBe(true)
    expect(isSettled(settledButLiveNode), "absent stamp + live node ⇒ derived NOT settled").toBe(false)
    // The comparator honours the stamp end-to-end: two stamped-settled turns with equal content SKIP.
    expect(turnPropsEqual(props({ ...settled, settled: true }), props({ ...settled, settled: true })), "stamped-settled equal turns ⇒ SKIP").toBe(true)
  }),
)

it.effect("the perf win: a settled turn skips re-render on a pure spinner tick", () =>
  Effect.sync(() => {
    expect(turnPropsEqual(props(settled), props({ ...settled })), "settled turn: equal props ⇒ SKIP re-render").toBe(true)
  }),
)

it.effect("never skip an in-flight turn; re-render on render-relevant input changes", () =>
  Effect.sync(() => {
    expect(turnPropsEqual(props(inflight), props({ ...inflight })), "in-flight turn ⇒ always re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props(inflight)), "settled→in-flight transition ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props(settled, { cols: 120 })), "cols change ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props(settled, { first: true })), "first change ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props(settled, { expanded: true })), "this turn's steps toggle ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props(settled, { expTools: new Set(["a1"]) })), "expanding one of THIS turn's tool rows ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props(settled, { focusedKey: "tool:a1" })), "Tab focus on one of THIS turn's rows ⇒ re-render").toBe(false)
    // DETAIL PANE: opening the detail pane for one of THIS turn's workflow nodes ⇒ re-render (the
    // pane appears under this turn's tree); an unrelated node's detailKey leaves this turn alone.
    expect(turnPropsEqual(props(settledWf), props(settledWf, { detailKey: "n1" })), "opening THIS turn's node detail pane ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settledWf, { detailKey: "other" }), props(settledWf, { detailKey: "elsewhere" })), "an UNRELATED node's detail pane ⇒ SKIP re-render").toBe(true)
    expect(turnPropsEqual(props(settled), props({ ...settled, final: "different reply" })), "a different reply ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props({ ...settled, steps: [tool("a1", "ok")] })), "a different step set ⇒ re-render").toBe(false)
  }),
)

it.effect("theme switch repaints; same SyntaxStyle identity skips", () =>
  Effect.sync(() => {
    expect(turnPropsEqual(props(settled), props(settled, { syntaxStyle: { style: "other" } })), "a theme switch (new SyntaxStyle identity) ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settled), props(settled, { syntaxStyle: STYLE })), "same SyntaxStyle identity ⇒ SKIP re-render").toBe(true)
  }),
)

it.effect("focus/expansion ELSEWHERE in the transcript does NOT repaint this settled turn", () =>
  Effect.sync(() => {
    expect(turnPropsEqual(props(settled), props(settled, { focusedKey: "turn:7" })), "focus on ANOTHER turn ⇒ SKIP").toBe(true)
    expect(turnPropsEqual(props(settled), props(settled, { focusedKey: "tool:zzz", expTools: new Set(["zzz", "other"]) })), "expansion/focus on UNRELATED rows ⇒ SKIP").toBe(true)
  }),
)

it.effect("workflow turn: node + owned-tool keys in scope; toggling them re-renders", () =>
  Effect.sync(() => {
    expect(turnRowKeys(settledWf, EMPTY).includes("node:n1"), "a workflow turn owns its node key").toBe(true)
    expect(turnRowKeys(settledWf, EMPTY).includes("tool:nt1"), "a workflow turn owns its node's tool key").toBe(true)
    expect(turnPropsEqual(props(settledWf), props({ ...settledWf })), "settled workflow turn: equal props ⇒ SKIP re-render").toBe(true)
    expect(turnPropsEqual(props(settledWf), props(settledWf, { expNodes: new Set(["n1"]) })), "expanding this turn's workflow node ⇒ re-render").toBe(false)
    expect(turnPropsEqual(props(settledWf), props(settledWf, { focusedKey: "node:n1" })), "focus on this turn's workflow node ⇒ re-render").toBe(false)
  }),
)

it.effect("the building blocks are sane (contentKey, interactionSig)", () =>
  Effect.sync(() => {
    expect(contentKey(settled), "contentKey is stable for equal-content turns").toBe(contentKey({ ...settled }))
    expect(contentKey(settled) !== contentKey({ ...settled, final: "x" }), "contentKey changes when the reply changes").toBe(true)
    expect(
      interactionSig(settled, false, EMPTY, EMPTY, "turn:7"),
      "interactionSig ignores focus that isn't on this turn",
    ).toBe(interactionSig(settled, false, EMPTY, EMPTY, undefined))
    expect(
      interactionSig(settled, false, EMPTY, EMPTY, "tool:a1") !== interactionSig(settled, false, EMPTY, EMPTY, undefined),
      "interactionSig reflects focus that IS on this turn",
    ).toBe(true)
  }),
)
