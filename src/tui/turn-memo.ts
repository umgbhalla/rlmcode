// STATIC-COMMIT (claude_code render model) — SCROLLBACK IS IMMUTABLE, so a SETTLED turn must
// NOT repaint on every busy tick (the work spinner re-renders the App ~12×/s; without this every
// settled turn in the transcript re-renders each tick). This is the pure memo logic for TurnView:
// a React.memo COMPARATOR that returns `true` (skip the re-render) when a settled turn's visible
// output is provably unchanged — i.e. only the in-flight turn + the composer actually repaint.
//
// Why a custom comparator (not default shallow memo): TurnView's props include fresh objects every
// render (the Turn from toTurns, the expansion Sets, the injected callbacks), so a shallow compare
// would ALWAYS re-render. The win comes from comparing the RENDER-RELEVANT inputs by VALUE and
// deliberately ignoring the props that don't change a settled turn's frame — above all `frame`
// (the spinner glyph), which is the prop ticking 12×/s.
//
// CORRECTNESS: we skip ONLY when the turn is settled in BOTH renders AND every input that could
// change THIS turn's output is unchanged:
//   - settled = final !== null && !streaming. An in-flight / streaming turn always re-renders
//     (return false) — its reply grows, its tools animate, its thinking streams.
//   - content key — a frozen-content fingerprint (idx + reply + each step's id|status + meta +
//     workflow totals). A settled turn is append-only history so its content never mutates; the
//     key just proves "same settled turn" (and defends against the idx slot ever changing).
//   - first / cols — layout inputs (cols drives width-aware diff split/unified + truncation).
//   - interaction signature — the focus + expansion state SCOPED TO THIS TURN's row keys: the
//     turn-steps toggle, each owned tool's expand, each owned workflow node's expand, and whether
//     the Tab focus (❯ gutter) is on one of this turn's rows. A focus/expansion change ELSEWHERE
//     in the transcript is irrelevant to this turn, so it doesn't force a repaint.
//   `frame` is intentionally absent: a settled turn has no running glyph (its tools/nodes are all
//   settled), so the spinner tick can't change its output — that's the whole perf win.
import type { Msg, OrchTree } from "./atoms.ts"
import { turnSettled } from "./chat-model.ts"
import type { Row as OrchRow } from "./orch-tree.ts"

// The TurnView render shape this module reasons about (kept in sync with chat.tsx's Turn). Only
// the fields that affect the render are listed; `steps` carry the tool/narration parts.
// FLATTEN MEMO (W3.2, F4): `rows` is the assembly-flattened workflow Row[] (toTurns → t.rows); the
// comparator reads it instead of re-flattening, so the tree is walked ONCE per render, not 3×.
export type MemoTurn = {
  readonly idx: number
  readonly user: string
  readonly steps: ReadonlyArray<Msg>
  readonly final: string | null
  readonly meta?: { readonly model: string; readonly ms: number; readonly tokens?: number | undefined; readonly finishReason?: string | undefined; readonly budget: boolean } | undefined
  readonly thinking?: string | undefined
  readonly streaming?: boolean | undefined
  // FIRST-CLASS SETTLED BOUNDARY (W5.2, F12): the assembly-stamped settled flag (toTurns →
  // Turn.settled). Optional so a raw MemoTurn (a test fixture / a hand-built shape) still works —
  // isSettled below reads the stamp when present and falls back to the SHARED turnSettled predicate
  // (the single authority in chat-model.ts) otherwise, so there is exactly ONE inference of the rule.
  readonly settled?: boolean | undefined
  readonly workflow?: OrchTree | undefined
  readonly rows?: ReadonlyArray<OrchRow> | undefined
}

// SETTLED = the turn is done AND nothing in it still animates: a final reply exists, it is not the
// in-flight streaming reply, AND its workflow (if any) has no still-RUNNING node (the orch tree is
// attached to the LAST turn; a turn can carry a final reply while a node is left "running" — its
// glyph animates off `frame`, so memoizing it would FREEZE that spinner; a live node ⇒ NOT settled).
// W5.2 (F12): this is now a FIRST-CLASS flag stamped ONCE at assembly (toTurns → Turn.settled), not
// re-derived per memo compare. isSettled reads the stamp when present; absent (a raw fixture) it
// defers to turnSettled — the SAME shared predicate the assembly site uses, so the rule lives once.
export const isSettled = (t: MemoTurn): boolean => t.settled ?? turnSettled(t)

// CONTENT KEY — a compact, frozen-content fingerprint proving two renders carry the SAME settled
// turn. Cheap on purpose (no full JSON of tool results/args — those bodies are gated behind the
// expansion sig): idx + reply + each step's id|status (+ narration text) + meta tokens/ms/finish +
// the workflow's roots/total/node-count. Settled history is immutable, so this never has to detect
// a mid-body edit — it only has to change if the turn at this idx is genuinely a different one.
export const contentKey = (t: MemoTurn): string => {
  // A6 — IDENTITY ON seq, NOT ARRAY INDEX. Each step keys on its stable per-session `seq` (minted
  // once on append, never mutated) instead of its array position + a length proxy. seq makes the
  // fingerprint robust to the index-as-identity fragility (the multi-session-drift / resume-skip
  // lesson): a step is the SAME step iff its seq matches, regardless of where it sits in the array.
  // The mutable per-step signal still travels alongside (tool status, agent text length) so a
  // settled turn whose tool flips status / whose narration grows still repaints.
  const steps = t.steps
    .map((s) => (s.kind === "tool" ? `t:${s.seq}:${s.id}:${s.status}` : s.kind === "agent" ? `a:${s.seq}:${s.text.length}` : `y:${s.seq}`))
    .join(",")
  const meta = t.meta ? `${t.meta.tokens ?? ""}|${t.meta.ms}|${t.meta.finishReason ?? ""}|${t.meta.budget ? 1 : 0}` : ""
  const wf = t.workflow ? `${t.workflow.roots.length}|${t.workflow.totalTokens}|${Object.keys(t.workflow.nodes).length}` : ""
  const think = t.thinking ? `${t.thinking.length}` : ""
  // reply: length + a short tail — distinguishes two replies cheaply without hashing the whole body.
  const reply = t.final === null ? "∅" : `${t.final.length}:${t.final.slice(-24)}`
  return `${t.idx}|${t.user.length}|${reply}|${steps}|${meta}|${wf}|${think}`
}

// Row keys THIS turn owns (the Tab-focus / expansion namespace): its steps toggle, each tool step,
// and — when it carries a workflow — each flattened node + that node's owned tools. Mirrors the
// focusables chat.tsx builds, scoped to one turn. `expNodes` gates which workflow rows exist
// (a collapsed node hides its subtree), so the key set tracks the live tree exactly.
export const turnRowKeys = (t: MemoTurn, _expNodes: ReadonlySet<string>): Array<string> => {
  const keys: Array<string> = [`turn:${t.idx}`]
  for (const s of t.steps) if (s.kind === "tool") keys.push(`tool:${s.id}`)
  // FLATTEN MEMO (W3.2): read the assembly-flattened Row[] (t.rows) instead of re-flattening the
  // tree here — it already reflects expNodes (toTurns flattened it with the same set), so the key
  // set tracks the live tree exactly without a third walk per render.
  if (t.rows) {
    for (const row of t.rows) {
      keys.push(`node:${row.id}`)
      for (const m of row.tools) keys.push(`tool:${m.id}`)
    }
  }
  return keys
}

// INTERACTION SIGNATURE — the focus + expansion state that affects THIS turn, as one string:
//   - expanded: is the turn-steps block open;
//   - which of this turn's tool/node keys are in expTools / expNodes (sorted, scoped);
//   - whether the Tab focus is on one of this turn's rows (the ❯ gutter), and which.
// A change to focus/expansion on an UNRELATED turn leaves this string identical ⇒ no repaint.
export const interactionSig = (
  t: MemoTurn,
  expanded: boolean,
  expTools: ReadonlySet<string>,
  expNodes: ReadonlySet<string>,
  focusedKey: string | undefined,
  detailKey: string | null,
): string => {
  const keys = turnRowKeys(t, expNodes)
  const keySet = new Set(keys)
  const openTools = keys.filter((k) => k.startsWith("tool:") && expTools.has(k.slice(5))).toSorted()
  const openNodes = keys.filter((k) => k.startsWith("node:") && expNodes.has(k.slice(5))).toSorted()
  // Focus only matters if it lands on one of THIS turn's rows; otherwise it's "" for every such turn.
  const focus = focusedKey !== undefined && keySet.has(focusedKey) ? focusedKey : ""
  // DETAIL PANE: an OPEN node detail pane belongs to THIS turn iff its node:<id> is one of this
  // turn's keys; opening/closing it then repaints this turn (and only it), so the pane appears.
  const detail = detailKey !== null && keySet.has(`node:${detailKey}`) ? detailKey : ""
  return `${expanded ? 1 : 0}|${openTools.join(",")}|${openNodes.join(",")}|${focus}|${detail}`
}

// The props the comparator inspects (a subset of TurnView's props — the callbacks are excluded
// because a settled turn's output is identical regardless of the (stable-behavior) handler identity).
export type MemoProps = {
  readonly t: MemoTurn
  readonly first: boolean
  readonly expanded: boolean
  readonly expTools: ReadonlySet<string>
  readonly expNodes: ReadonlySet<string>
  readonly detailKey: string | null
  readonly focusedKey: string | undefined
  readonly cols: number
  // TURN-AWARE ROW BUDGET (W4/F6): the viewport-derived per-turn body-line allocation an expanded
  // tool's body is bounded to. A layout input like `cols` — it changes on a viewport (height) resize,
  // so a settled turn with an EXPANDED bounded body must repaint when it changes (else the body would
  // stay capped at the stale budget after a resize).
  readonly bodyBudget: number
  // The shared SyntaxStyle identity. App rebuilds it ONLY on a theme switch (useMemo keyed on the
  // active theme name), so it is STABLE across the busy tick (no settled-turn repaint) but CHANGES
  // on a switch — forcing every settled turn to recolor its diffs/markdown in the new palette.
  readonly syntaxStyle: unknown
}

// THE COMPARATOR (React.memo areEqual): true ⇒ SKIP the re-render. Skip iff the turn is settled in
// BOTH renders and every render-relevant input is unchanged. Returning false (re-render) is always
// safe; we only return true when the output is provably identical — so a settled turn paints once
// and then stays put while the in-flight turn + composer animate.
export const turnPropsEqual = (prev: MemoProps, next: MemoProps): boolean => {
  // An in-flight turn (either render) always re-renders — never memo a growing/animating turn.
  if (!isSettled(prev.t) || !isSettled(next.t)) return false
  if (prev.first !== next.first || prev.cols !== next.cols || prev.bodyBudget !== next.bodyBudget) return false
  // A theme switch swaps the SyntaxStyle identity (stable across busy ticks) — repaint so the
  // settled turn's diffs/markdown recolor in the new palette. Same identity ⇒ no tick repaint.
  if (prev.syntaxStyle !== next.syntaxStyle) return false
  if (contentKey(prev.t) !== contentKey(next.t)) return false
  return (
    interactionSig(prev.t, prev.expanded, prev.expTools, prev.expNodes, prev.focusedKey, prev.detailKey) ===
    interactionSig(next.t, next.expanded, next.expTools, next.expNodes, next.focusedKey, next.detailKey)
  )
}
