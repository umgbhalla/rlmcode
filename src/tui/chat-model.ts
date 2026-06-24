// CHAT MODEL — the PURE (no-React, no-closure) transcript helpers extracted from chat.tsx so the
// App component file stays under its line budget. These are the data-shaping functions the render
// reads: the Turn projection (toTurns), the explore-group collapse (groupSteps/groupSummary), the
// token/cost formatters, the status-row text, and a couple of small pure utilities. No JSX lives
// here — chat.tsx imports these and feeds them into the components. Total functions over the
// immutable Msg/OrchTree shapes, so they're trivially testable and free of UI concerns.
import type { Msg, OrchTree, TurnMeta } from "./atoms.ts"
import type { Row as OrchRow } from "./orch-tree.ts"
import { theme } from "./theme.ts"
import { groupSteps, groupSummary, type StepItem, toolLabel } from "./toolui.ts"
import { computeShowOrch, workflowRows } from "./workflow.tsx"

export const INDENT = 2 // single source of truth for transcript nesting
export const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

type ToolMsg = Extract<Msg, { kind: "tool" }>

// TOOL GROUPING is now a single assembly-time authority in toolui.ts (W3.1) — re-exported here so
// existing importers (chat.tsx) keep their `from "./chat-model.ts"` path while the logic lives in
// the pure leaf both the transcript AND the node detail pane share.
export { groupSteps, groupSummary, type StepItem }

// INLINE NODE-TREE (opencode-ux-blueprint Option B): a turn that produced an orchestration
// fan-out carries its OrchTree as `workflow`, so TurnView renders the node-tree right after
// that turn's reply (vs the old session-level block pinned below ALL turns). undefined on a
// plain turn ⇒ no orchestration block. toTurns attaches it (computeShowOrch-gated).
// ASSEMBLY-TIME STRUCTURE (W3, fixes F2/F3/F4): a Turn carries its render-ready shape, computed
// ONCE per toTurns pass (NOT re-derived on every 12×/s busy-tick render):
//   - `items` — the grouped step stream (groupSteps applied at assembly): the explore-tool runs are
//     already collapsed into `{kind:'group'}` units, so TurnView just maps `items` (it no longer
//     re-groups per render, and the grouped shape is now a first-class, exportable assembly product).
//   - `rows` — the flattened+velocity-capped workflow Row[] (flatten() applied at assembly): the ONE
//     stable Row[] per (orch, expNodes) shared by TurnView, the focus ring, and the memo comparator,
//     replacing the old 3× flatten() per render. undefined when the turn carries no workflow.
//   - `settled` — the FIRST-CLASS settled/committed boundary (W5.2, fixes F12): computed ONCE here at
//     assembly from the three heterogeneous in-flight signals (a final reply exists + the reply is not
//     the in-flight streaming one + the workflow has no still-RUNNING node). The memo comparator reads
//     this flag instead of re-deriving it (and re-walking workflow.nodes) on every busy-tick compare —
//     settledness is now a property of the assembled turn, inferred at the single assembly site.
export type Turn = { idx: number; user: string; steps: Array<Msg>; items: Array<StepItem>; final: string | null; meta?: TurnMeta | undefined; thinking?: string | undefined; streaming?: boolean; settled: boolean; workflow?: OrchTree | undefined; rows?: ReadonlyArray<OrchRow> | undefined }

export const oneLine = (s: string, n = 90): string => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// AUTOCOMPLETE nav-key map: an opentui key event → the controller's nav action, or null for any
// other key (a printable, backspace, …) which is NOT consumed by the popup (it falls through to the
// textarea so the query keeps narrowing). Pure; tab is treated like return (accept the selection).
export type AcNav = "up" | "down" | "return" | "escape" | "tab"
export const navKeyName = (k: { readonly name?: string | undefined }): AcNav | null => {
  switch (k.name) {
    case "up":
    case "down":
    case "return":
    case "escape":
    case "tab":
      return k.name
    default:
      return null
  }
}

// COST-METER token formatter: "318k tok" / "742 tok" (shared by turn meta + orch tree).
export const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tok` : `${n} tok`)

// Session token total for the footer cost-meter: sum every settled reply's meta.tokens across
// the transcript, plus the orchestration run total. Pure — drives ActionBar's token/cost.
export const sessionTokens = (messages: ReadonlyArray<Msg>, orch: OrchTree | undefined): number => {
  let n = orch?.totalTokens ?? 0
  for (const m of messages) if (m.kind === "agent" && typeof m.meta?.tokens === "number") n += m.meta.tokens
  return n
}

export type Work = { frame: string; elapsed: number }
// Right-side status for the composer's status row (busy/armed/transient note/idle). `live` =
// "there is something to say" (mid-turn / armed / a transient note); when false the row stays
// CLEAN (only the persistent token·Cmd+K cluster shows, right-aligned). The spinner is rendered
// by the composer itself, so the busy text carries no frame glyph here. The keybind help that
// used to fill the idle bar is gone — Cmd+K (the palette) is the discovery surface now.
export const statusBar = (busy: boolean, armed: boolean, note: string | null, work: Work, retry: string | null): { right: string; tone: string; live: boolean } => {
  if (armed) return { right: "esc again to interrupt", tone: theme.error, live: true }
  if (note) return { right: note, tone: theme.ok, live: true } // transient (copied / paste collapsed) wins so it's never swallowed mid-turn
  // RATE-LIMIT VISIBILITY: a node backing off (a 429 retry) takes priority over the generic
  // "thinking…" so the throttle is visible at the turn level — "⏳ rate-limited · retry 2/3 · 4s ·
  // esc interrupt". In the warning tone (not the busy spinner tone) so it reads as throttled.
  if (retry) return { right: `${retry} · esc interrupt`, tone: theme.warning, live: true }
  if (busy) return { right: `thinking… ${work.elapsed}s · esc interrupt`, tone: theme.busy, live: true }
  return { right: "", tone: theme.muted, live: false }
}

export function toTurns(messages: ReadonlyArray<Msg>, orch?: OrchTree, expNodes: ReadonlySet<string> = EMPTY_SET): Array<Turn> {
  const turns: Array<Turn> = []
  for (const m of messages) {
    if (m.kind === "you") turns.push({ idx: turns.length, user: m.text, steps: [], items: [], final: null, settled: false })
    else if (turns.length > 0) turns[turns.length - 1]!.steps.push(m)
  }
  // INLINE NODE-TREE: the session holds ONE OrchTree (the live fan-out). Attach it to the turn
  // that owns it — the LAST turn — but ONLY when it's a real fan-out worth showing
  // (computeShowOrch). A non-workflow session/turn gets no `workflow`, so TurnView renders no
  // orchestration block. The tree then hangs under THAT turn's reply, not in a session footer.
  if (computeShowOrch(orch) && turns.length > 0) turns[turns.length - 1]!.workflow = orch
  for (const t of turns) {
    for (let i = t.steps.length - 1; i >= 0; i--) {
      const s = t.steps[i]!
      // SEQUENCE STABILITY: only the TRUE final reply (the one carrying meta, appended at
      // turn end) is promoted out of the step stream. Streaming narration chunks are also
      // kind:"agent" but carry NO meta — promoting the last of those mid-turn made the green
      // "final" slot flicker and the rows reorder on every chunk. They stay as ordered steps.
      // Promote the settled reply (carries meta) OR the in-flight STREAMING reply. The streaming
      // reply is ONE message that grows in place (atoms grow()), so promoting it is stable — no
      // per-chunk reorder flicker (the old hazard was many separate narration msgs). Carry its
      // thinking + streaming flag up so the render shows the collapsible thinking + live cursor.
      if (s.kind === "agent" && (s.meta || s.streaming === true)) {
        // LIVE/COMMITTED SPLIT (F9): while STREAMING, show the transient `liveText` buffer (the
        // in-flight stream); a SETTLED reply (carries meta, liveText cleared by finalize) shows the
        // canonical `text`. liveText ?? text coalesces — the committed message is `text`, the live
        // preview is liveText, and finalize swaps one for the other atomically (no in-place overwrite).
        t.final = s.liveText ?? s.text
        t.meta = s.meta
        t.streaming = s.streaming === true && s.meta === undefined
        t.thinking = s.thinking
        t.steps = [...t.steps.slice(0, i), ...t.steps.slice(i + 1)]
        break
      }
    }
    // ASSEMBLY-TIME GROUPING + FLATTEN (W3, F2/F3/F4): the reply has been promoted out, so `steps`
    // is the final tool/narration stream — group it ONCE here (was a render-time groupSteps in
    // TurnView, re-run every tick). And flatten the workflow ONCE into the stable Row[] the render +
    // focus ring + memo comparator all share (was 3× flatten() per render). Both are now first-class
    // products of assembly, identical no matter which surface consumes them — no out-of-order flicker.
    t.items = groupSteps(t.steps)
    if (t.workflow) t.rows = workflowRows(t.workflow, expNodes)
    // SETTLED/COMMITTED BOUNDARY (W5.2, F12): the single assembly-site inference of settledness,
    // collapsing the three heterogeneous in-flight signals into ONE first-class flag the memo
    // comparator then reads (no re-walk of workflow.nodes per compare). A turn is settled iff a final
    // reply exists, it is NOT the in-flight streaming reply, AND its workflow (if any) has no
    // still-RUNNING node (a node glyph animates off `frame`, so a live node ⇒ not settled — else its
    // spinner would freeze under the memo). turnSettled is the shared predicate (turn-memo.ts).
    t.settled = turnSettled(t)
  }
  return turns
}

// THE settled predicate (W5.2, F12) — the SINGLE authority for "this turn is done and nothing in it
// still animates". Called ONCE per turn at assembly (toTurns) to stamp Turn.settled; the memo
// comparator reads the stamped flag rather than re-deriving here on every busy-tick compare. Pure
// over the minimal shape (final/streaming/workflow), so turn-memo.ts's MemoTurn satisfies it too.
export const turnSettled = (t: { readonly final: string | null; readonly streaming?: boolean | undefined; readonly workflow?: OrchTree | undefined }): boolean =>
  t.final !== null &&
  t.streaming !== true &&
  !(t.workflow !== undefined && Object.values(t.workflow.nodes).some((n) => n.status === "running"))

const EMPTY_SET: ReadonlySet<string> = new Set()

export const toolsUsed = (steps: Array<Msg>): string =>
  [...new Set(steps.filter((s): s is ToolMsg => s.kind === "tool").map((s) => toolLabel(s.name, s.args).split("(")[0]!))].join(", ")
