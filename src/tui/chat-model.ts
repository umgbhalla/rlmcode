// CHAT MODEL — the PURE (no-React, no-closure) transcript helpers extracted from chat.tsx so the
// App component file stays under its line budget. These are the data-shaping functions the render
// reads: the Turn projection (toTurns), the explore-group collapse (groupSteps/groupSummary), the
// token/cost formatters, the status-row text, and a couple of small pure utilities. No JSX lives
// here — chat.tsx imports these and feeds them into the components. Total functions over the
// immutable Msg/OrchTree shapes, so they're trivially testable and free of UI concerns.
import { type Msg, type OrchTree, type TurnMeta } from "./atoms.ts"
import { theme } from "./theme.ts"
import { toolLabel } from "./toolui.ts"
import { computeShowOrch } from "./workflow.tsx"

export const INDENT = 2 // single source of truth for transcript nesting
export const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

type ToolMsg = Extract<Msg, { kind: "tool" }>

// INLINE NODE-TREE (opencode-ux-blueprint Option B): a turn that produced an orchestration
// fan-out carries its OrchTree as `workflow`, so TurnView renders the node-tree right after
// that turn's reply (vs the old session-level block pinned below ALL turns). undefined on a
// plain turn ⇒ no orchestration block. toTurns attaches it (computeShowOrch-gated).
export type Turn = { idx: number; user: string; steps: Msg[]; final: string | null; meta?: TurnMeta | undefined; thinking?: string | undefined; streaming?: boolean; workflow?: OrchTree | undefined }

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
export const sessionTokens = (messages: readonly Msg[], orch: OrchTree | undefined): number => {
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

export function toTurns(messages: readonly Msg[], orch?: OrchTree): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.kind === "you") turns.push({ idx: turns.length, user: m.text, steps: [], final: null })
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
        t.final = s.text
        t.meta = s.meta
        t.streaming = s.streaming === true && s.meta === undefined
        t.thinking = s.thinking
        t.steps = [...t.steps.slice(0, i), ...t.steps.slice(i + 1)]
        break
      }
    }
  }
  return turns
}

// TOOL GROUPING (P1): a run of consecutive read/glob/grep ("explore") tool steps collapses
// into ONE "explored N" row instead of N near-identical lines (the flat-rendering fix). A lone
// explore tool, an error, or any other tool renders normally. Presentational only — Msg is
// unchanged; this groups at render time.
const EXPLORE_TOOLS = new Set(["read_file", "glob", "grep"])
export type StepItem = { readonly kind: "one"; readonly m: Msg } | { readonly kind: "group"; readonly tools: ToolMsg[] }
export const groupSteps = (steps: Msg[]): StepItem[] => {
  const out: StepItem[] = []
  for (const s of steps) {
    if (s.kind === "tool" && EXPLORE_TOOLS.has(s.name) && s.status !== "error") {
      const last = out[out.length - 1]
      if (last?.kind === "group") last.tools.push(s)
      else out.push({ kind: "group", tools: [s] })
    } else out.push({ kind: "one", m: s })
  }
  // a "group" of one isn't worth collapsing — unwrap so a single read still renders in full.
  return out.map((it) => (it.kind === "group" && it.tools.length === 1 ? { kind: "one", m: it.tools[0]! } : it))
}
// One-line summary for a collapsed explore group: "explored 5 (3 read · 2 grep)".
export const groupSummary = (tools: readonly ToolMsg[]): string => {
  const by: Record<string, number> = {}
  for (const t of tools) by[t.name] = (by[t.name] ?? 0) + 1
  const verb: Record<string, string> = { read_file: "read", glob: "glob", grep: "grep" }
  const parts = Object.entries(by).map(([n, c]) => `${c} ${verb[n] ?? n}`)
  return `explored ${tools.length} (${parts.join(" · ")})`
}

export const toolsUsed = (steps: Msg[]): string =>
  [...new Set(steps.filter((s): s is ToolMsg => s.kind === "tool").map((s) => toolLabel(s.name, s.args).split("(")[0]!))].join(", ")
