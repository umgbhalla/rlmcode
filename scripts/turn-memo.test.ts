#!/usr/bin/env bun
// STATIC-COMMIT unit gate — proves the TurnView memo comparator (src/tui/turn-memo.ts) skips the
// re-render for a SETTLED turn whose output is unchanged, and re-renders otherwise. This is the
// claude_code "scrollback is immutable" perf model: the busy tick re-renders the App ~12×/s; a
// settled turn must NOT repaint just because the spinner `frame` advanced. Plain asserts, no
// framework (rlmcode fixture style). Pure logic — no PTY — so it rides the `test` (lint) target.
import type { Msg, OrchTree } from "../src/tui/atoms.ts"
import { contentKey, interactionSig, isSettled, type MemoProps, turnPropsEqual, turnRowKeys } from "../src/tui/turn-memo.ts"

let failed = 0
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

const EMPTY: ReadonlySet<string> = new Set()
const tool = (id: string, status: "running" | "ok" | "error"): Msg => ({ kind: "tool", id, name: "bash", args: "{}", status, result: "out" })

// A SETTLED turn with two tool steps + a reply (carries meta, not streaming).
const settled = {
  idx: 0,
  user: "do the thing",
  steps: [tool("a1", "ok"), tool("a2", "ok")] as Msg[],
  final: "done.",
  meta: { model: "kimi", ms: 1200, tokens: 800, budget: false },
  streaming: false,
}
// An IN-FLIGHT turn: a streaming reply (no meta, streaming flag) + a still-running tool.
const inflight = {
  idx: 1,
  user: "another",
  steps: [tool("b1", "running")] as Msg[],
  final: "partial",
  streaming: true,
}

// A small workflow tree so the node/tool keys exercise the workflow branch.
const orch: OrchTree = {
  roots: ["n1"],
  totalTokens: 500,
  nodes: {
    n1: { id: "n1", label: "scan", phase: "", status: "done", tokens: 500, tools: [tool("nt1", "ok")] },
  },
}
const settledWf = { ...settled, idx: 2, workflow: orch }

// A stable SyntaxStyle sentinel — App rebuilds the real one only on a theme switch (useMemo keyed on
// the active theme name), so across busy ticks its IDENTITY is stable. Using one shared object as the
// default makes `{ ...settled }` (a fresh-Turn re-render) carry the SAME style identity ⇒ the
// comparator still SKIPS; a DIFFERENT object models a theme switch (must force a repaint).
const STYLE = { style: "default" }
// Build a MemoProps with the live interaction inputs (defaults: nothing expanded/focused, cols 80).
const props = (
  t: MemoProps["t"],
  over: Partial<Omit<MemoProps, "t">> = {},
): MemoProps => ({ t, first: false, expanded: false, expTools: EMPTY, expNodes: EMPTY, focusedKey: undefined, cols: 80, syntaxStyle: STYLE, ...over })

// A turn whose reply is settled but whose workflow still has a RUNNING node (its glyph animates
// off `frame`) — the orch tree is attached to the last turn, which can settle its reply while a
// node is left running. Memoizing it would FREEZE the spinner, so it must NOT be treated settled.
const liveNodeOrch: OrchTree = {
  roots: ["r"],
  totalTokens: 0,
  nodes: { r: { id: "r", label: "fan-out", phase: "running", status: "running" } },
}
const settledButLiveNode = { ...settled, idx: 5, workflow: liveNodeOrch }

// ── isSettled ──────────────────────────────────────────────────────────────────────────────
ok(isSettled(settled), "a turn with a final reply and not streaming is settled")
ok(!isSettled(inflight), "a streaming turn is NOT settled")
ok(!isSettled({ idx: 9, user: "", steps: [], final: null }), "a turn with no final reply is NOT settled")
ok(!isSettled(settledButLiveNode), "a settled-reply turn with a RUNNING workflow node is NOT settled (its spinner must keep animating)")
ok(!turnPropsEqual(props(settledButLiveNode), props({ ...settledButLiveNode })), "a turn with a live node ⇒ always re-render (the node spinner ticks)")

// ── THE PERF WIN: a settled turn skips the re-render when only `frame` would have changed ────
// (frame isn't even in MemoProps — that's the point: the comparator can't see it, so a spinner
// tick that re-renders App leaves a settled turn's props provably equal ⇒ React.memo bails.)
ok(turnPropsEqual(props(settled), props({ ...settled })), "settled turn: equal props (fresh Turn object, same content) ⇒ SKIP re-render")

// ── never skip an in-flight turn (it grows/animates every tick) ──────────────────────────────
ok(!turnPropsEqual(props(inflight), props({ ...inflight })), "in-flight turn ⇒ always re-render (never memoized)")
ok(!turnPropsEqual(props(settled), props(inflight)), "settled→in-flight transition ⇒ re-render")

// ── re-render when a render-relevant input changes ───────────────────────────────────────────
ok(!turnPropsEqual(props(settled), props(settled, { cols: 120 })), "cols change (width-driven layout) ⇒ re-render")
ok(!turnPropsEqual(props(settled), props(settled, { first: true })), "first change ⇒ re-render")
ok(!turnPropsEqual(props(settled), props(settled, { expanded: true })), "this turn's steps toggle ⇒ re-render")
ok(
  !turnPropsEqual(props(settled), props(settled, { expTools: new Set(["a1"]) })),
  "expanding one of THIS turn's tool rows ⇒ re-render",
)
ok(
  !turnPropsEqual(props(settled), props(settled, { focusedKey: "tool:a1" })),
  "Tab focus landing on one of THIS turn's rows ⇒ re-render (the ❯ gutter moves)",
)
// content edit (defensive — settled history is immutable, but the key must still detect it)
ok(!turnPropsEqual(props(settled), props({ ...settled, final: "different reply" })), "a different reply ⇒ re-render")
ok(!turnPropsEqual(props(settled), props({ ...settled, steps: [tool("a1", "ok")] })), "a different step set ⇒ re-render")

// THEME SWITCH: the SyntaxStyle identity changes (App rebuilds it on a switch) ⇒ a settled turn must
// repaint so its diffs/markdown recolor in the new palette. A stable identity (the busy tick) ⇒ skip.
ok(!turnPropsEqual(props(settled), props(settled, { syntaxStyle: { style: "other" } })), "a theme switch (new SyntaxStyle identity) ⇒ re-render (recolor)")
ok(turnPropsEqual(props(settled), props(settled, { syntaxStyle: STYLE })), "same SyntaxStyle identity (busy tick) ⇒ SKIP re-render (no recolor churn)")

// ── focus/expansion ELSEWHERE in the transcript does NOT repaint this settled turn ───────────
// turn idx 0 owns keys turn:0 / tool:a1 / tool:a2 — a focus/expansion on UNRELATED keys is inert.
ok(turnPropsEqual(props(settled), props(settled, { focusedKey: "turn:7" })), "focus on ANOTHER turn ⇒ SKIP (irrelevant to this turn)")
ok(
  turnPropsEqual(props(settled), props(settled, { focusedKey: "tool:zzz", expTools: new Set(["zzz", "other"]) })),
  "expansion/focus on UNRELATED rows ⇒ SKIP (scoped sig unchanged)",
)

// ── workflow turn: its node + owned-tool keys are in the scope; toggling them re-renders ─────
ok(turnRowKeys(settledWf, EMPTY).includes("node:n1"), "a workflow turn owns its node key")
ok(turnRowKeys(settledWf, EMPTY).includes("tool:nt1"), "a workflow turn owns its node's tool key")
ok(turnPropsEqual(props(settledWf), props({ ...settledWf })), "settled workflow turn: equal props ⇒ SKIP re-render")
ok(!turnPropsEqual(props(settledWf), props(settledWf, { expNodes: new Set(["n1"]) })), "expanding this turn's workflow node ⇒ re-render")
ok(
  !turnPropsEqual(props(settledWf), props(settledWf, { focusedKey: "node:n1" })),
  "focus on this turn's workflow node ⇒ re-render",
)

// ── the building blocks are sane ─────────────────────────────────────────────────────────────
ok(contentKey(settled) === contentKey({ ...settled }), "contentKey is stable for equal-content turns")
ok(contentKey(settled) !== contentKey({ ...settled, final: "x" }), "contentKey changes when the reply changes")
ok(
  interactionSig(settled, false, EMPTY, EMPTY, "turn:7") === interactionSig(settled, false, EMPTY, EMPTY, undefined),
  "interactionSig ignores focus that isn't on this turn",
)
ok(
  interactionSig(settled, false, EMPTY, EMPTY, "tool:a1") !== interactionSig(settled, false, EMPTY, EMPTY, undefined),
  "interactionSig reflects focus that IS on this turn",
)

if (failed > 0) {
  console.error(`turn-memo.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("turn-memo.test: all pass ✓")
