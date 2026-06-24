// @effect/vitest port of scripts/turn-memo.test.ts — STATIC-COMMIT unit gate. Proves the
// TurnView memo comparator (src/tui/turn-memo.ts) skips the re-render for a SETTLED turn whose
// output is unchanged, and re-renders otherwise. Pure logic — no PTY — it.effect/sync.
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Msg, OrchTree } from "../src/tui/atoms.ts"
import { contentKey, interactionSig, isSettled, type MemoProps, turnPropsEqual, turnRowKeys } from "../src/tui/turn-memo.ts"

const EMPTY: ReadonlySet<string> = new Set()
const tool = (id: string, status: "running" | "ok" | "error"): Msg => ({ kind: "tool", id, name: "bash", args: "{}", status, result: "out" })

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
const settledWf = { ...settled, idx: 2, workflow: orch }

const STYLE = { style: "default" }
const props = (t: MemoProps["t"], over: Partial<Omit<MemoProps, "t">> = {}): MemoProps => ({
  t,
  first: false,
  expanded: false,
  expTools: EMPTY,
  expNodes: EMPTY,
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
