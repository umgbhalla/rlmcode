// Claude-Code-style tool presentation: a human label (Bash(cmd), Read(path),
// Search(pattern)) and a short result summary (6 files, 12 lines), instead of
// raw function name + JSON params / raw output.
import type { Msg } from "./atoms.ts"
import { getIconShape } from "./icons.ts"

type ToolMsg = Extract<Msg, { kind: "tool" }>

// TOOL GROUPING — THE ONE assembly-time authority (W3.1, fixes F2/F3). A run of consecutive
// read/glob/grep ("explore") tool steps collapses into ONE "explored N" unit instead of N
// near-identical lines. This used to be a render-time pass duplicated per-surface (chat.tsx ran it
// over a turn's steps; the node detail pane didn't group at all — the F2/F3 asymmetry). It now
// lives HERE, a pure leaf both surfaces import, and is applied at ASSEMBLY (toTurns / the node
// detail pane) ONCE, so the SAME sequence renders ONE way whether it's a main turn or a node's
// Activity — no out-of-order flicker, no per-tick recompute. A lone explore tool, an error, or any
// other tool stays its own row. The Msg type-only import is a pure type (atoms never imports here).
const EXPLORE_TOOLS = new Set(["read_file", "glob", "grep"])
export type StepItem = { readonly kind: "one"; readonly m: Msg } | { readonly kind: "group"; readonly tools: Array<ToolMsg> }
export const groupSteps = (steps: ReadonlyArray<Msg>): Array<StepItem> => {
  const out: Array<StepItem> = []
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
export const groupSummary = (tools: ReadonlyArray<ToolMsg>): string => {
  const by: Record<string, number> = {}
  for (const t of tools) by[t.name] = (by[t.name] ?? 0) + 1
  const verb: Record<string, string> = { read_file: "read", glob: "glob", grep: "grep" }
  const parts = Object.entries(by).map(([n, c]) => `${c} ${verb[n] ?? n}`)
  return `explored ${tools.length} (${parts.join(" · ")})`
}

const field = (args: string, k: string): string => {
  try {
    const o = JSON.parse(args)
    return o?.[k] != null ? String(o[k]) : ""
  } catch {
    return ""
  }
}

const short = (s: string, n = 52) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const lines = (s: string) => {
  const t = s.trim()
  return t.length === 0 ? 0 : t.split("\n").length
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// One glyph per tool TYPE so a transcript that's mostly tool rows is scannable at
// a glance. Used as the "done" status mark (running keeps the spinner, error ✗). The
// glyphs come from the shared icon map (src/tui/icons.ts) keyed by render ROLE, so the
// $/→/←/✱/% marks live in ONE place, not duplicated as literals across the TUI.
export const toolIcon = (name: string): string => {
  switch (name) {
    case "bash":
      return getIconShape("bash")
    case "read_file":
      return getIconShape("read")
    case "write_file":
    case "edit_file":
      return getIconShape("write")
    case "glob":
    case "grep":
      return getIconShape("search")
    case "web_fetch":
      return getIconShape("fetch")
    default:
      return getIconShape("tool")
  }
}

export const toolLabel = (name: string, args: string): string => {
  switch (name) {
    case "bash":
      return `Bash(${short(field(args, "command"))})`
    case "read_file":
      return `Read(${field(args, "path")})`
    case "write_file":
      return `Write(${field(args, "path")})`
    case "edit_file":
      return `Update(${field(args, "path")})`
    case "glob":
      return `Search(${field(args, "pattern")})`
    case "grep":
      return `Search(${field(args, "pattern")})`
    case "web_fetch":
      return `Fetch(${short(field(args, "url"))})`
    default:
      return `${name}(${short(args)})`
  }
}

export type PreviewLine = { readonly text: string; readonly tone: "add" | "del" | "dim" }

// ── TOOL RENDER MODE (PART_MAPPING-style dispatch) ──────────────────────────────────────
// opencode renders a tool one of three ways (session/index.tsx:1714-2202): some tools are an
// INLINE dim one-liner whose summary says everything (Glob/Grep/Read/WebFetch — "N matches",
// "N lines"); the heavier tools are a BLOCK with a collapsed body (Shell shows its stdout;
// Write/Edit show a diff); an errored tool is a RED card. This pure function is that dispatch —
// one place names the mode so the React ToolView just switches on it (no status/name if-ladder in
// the component). `inline` = the one-line header only (no body); `block` = header + an
// expandable, collapsed body; `error` = the red card.
//   A RUNNING tool is always inline (a dim live line, no body yet). A settled BLOCK tool with no
// real output (an empty bash) downgrades to inline — there's nothing to collapse.
export type ToolMode = "inline" | "block" | "error"
const BLOCK_TOOLS = new Set(["bash", "write_file", "edit_file"]) // Shell stdout + Write/Edit diff
export const toolRenderMode = (name: string, status: "running" | "ok" | "error", result: string): ToolMode => {
  if (status === "error") return "error"
  if (status === "running") return "inline" // in-flight → a dim live line, never a body yet
  if (!BLOCK_TOOLS.has(name)) return "inline" // read/glob/grep/web_fetch — the summary says it all
  return toolHasBody(name, result, false) ? "block" : "inline" // an empty bash has no body → inline
}

// ── PER-TOOL OUTPUT COLLAPSE (opencode collapseToolOutput, util/collapse-tool-output.ts) ──
// A settled tool's body shows only the first `collapseMax(name)` preview lines; the rest collapse
// behind a "+N more" affordance (expandable — the row's existing expTools toggle reveals the full
// body). Shell keeps MORE context (10 lines) than a read/search/generic (3), matching opencode's
// per-tool maxLines (session/index.tsx:1805 / :2055). Pure — tool-view.tsx slices the PreviewLine[]
// at this cap so the collapse layers cleanly over the existing per-tool toolPreview output.
export const collapseMax = (name: string): number => (name === "bash" ? 10 : 3)

// ── TURN-AWARE EXPANDED CAP (W4/F6, motel SpanDetailPane bodyLines) ────────────────────────────
// When a tool row is EXPANDED, its body USED to cap at Number.MAX_SAFE_INTEGER — a single expanded
// 500-line bash dumped all 500 lines inline and blew the viewport off-screen (the F6 splatter at
// the expanded tier). The cap is now BUDGET-AWARE: `bodyBudget` is the per-turn row allocation
// (chat.tsx derives it from the viewport height, then divides it among the turn's expanded tools),
// so the expanded body is bounded to a finite, viewport-fitting cap + keeps its "… +N more" footer
// (headLines appends it). Floored so the expand still reveals MEANINGFULLY more than the collapsed
// cap (else expanding a huge body under a tiny viewport would show no extra lines). A 0/undefined
// budget (no viewport info) falls back to a generous static ceiling so non-budget callers are sane.
const EXPANDED_FALLBACK = 200 // generous static ceiling when no viewport budget is threaded
export const expandedMax = (name: string, bodyBudget?: number): number => {
  const floor = collapseMax(name) * 2 // expanding always reveals at least ~2× the collapsed cap
  if (bodyBudget === undefined || bodyBudget <= 0) return Math.max(floor, EXPANDED_FALLBACK)
  return Math.max(floor, Math.floor(bodyBudget))
}

// ── PER-TOOL HEADER DETAIL (opencode Shell workdir/exit) ──────────────────────────────────
// A short, Shell-specific suffix appended to a settled bash header — the high-signal fact
// opencode's Shell renderer surfaces (the workdir it ran in + a non-zero exit). Empty string ⇒
// no suffix (the row stays clean). The Read line-count requirement is already met by toolSummary
// (read_file → "N lines"), so it isn't duplicated here. Pure over args+result so the frame gate
// reads it identically.
const EXIT_RE = /\bexit (\d+)\b/i
export const toolDetail = (name: string, args: string, result: string, isError: boolean): string => {
  if (name !== "bash") return ""
  const wd = field(args, "workdir") || field(args, "cwd")
  const exit = result.match(EXIT_RE)
  const bits: Array<string> = []
  if (wd && wd !== ".") bits.push(`in ${wd}`)
  // surface a NON-zero exit (a clean run is exit 0 / no marker); an errored row already reads ✗,
  // but its exit code is still useful, so show it whenever it's present + non-zero (or on error).
  if (exit && (exit[1] !== "0" || isError)) bits.push(`exit ${exit[1]}`)
  return bits.join(" · ")
}

// Width-aware: clamp each line to `cols` so one 5000-char line can't blow the
// inline layout, independent of the `n` line cap.
const headLines = (s: string, n: number, cols = 200): Array<PreviewLine> => {
  const clamp = (l: string) => (l.length > cols ? `${l.slice(0, cols - 1)}…` : l)
  const all = s.replace(/\s+$/, "").split("\n")
  const out: Array<PreviewLine> = all.slice(0, n).map((l) => ({ text: clamp(l), tone: "dim" as const }))
  if (all.length > n) out.push({ text: `… +${all.length - n} more`, tone: "dim" })
  return out
}

// LCS line diff: the longest common subsequence of the two line arrays is the unchanged
// CONTEXT; everything else is a real -/+ line, IN ORDER. Replaces the old "remove the whole
// old block, add the whole new block" dump (which made a 1-line tweak look like a full
// rewrite). O(m·k) DP — bounded by the caller's line cap. Returns unified-diff body lines
// (" ctx" / "-del" / "+add"). Exported for a headless self-check (scripts/toolui-diff.test).
const fileExt = (p: string): string => (p.includes(".") ? p.split(".").pop()! : "txt")

export const lcsDiffLines = (o: ReadonlyArray<string>, n: ReadonlyArray<string>): Array<string> => {
  const m = o.length
  const k = n.length
  // dp[i][j] = LCS length of o[i:] and n[j:]; walked forward to reconstruct in order.
  const dp: Array<Array<number>> = Array.from({ length: m + 1 }, () => Array.from({ length: k + 1 }, () => 0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = k - 1; j >= 0; j--) dp[i]![j] = o[i] === n[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: Array<string> = []
  let i = 0
  let j = 0
  while (i < m && j < k) {
    if (o[i] === n[j]) {
      out.push(` ${o[i]}`)
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`-${o[i]}`)
      i++
    } else {
      out.push(`+${n[j]}`)
      j++
    }
  }
  while (i < m) out.push(`-${o[i++]}`)
  while (j < k) out.push(`+${n[j++]}`)
  return out
}

// A synthesized unified diff for edits/writes, fed to opentui's native <diff>. Uses a real
// LCS line diff so an edit shows only what changed (context + the -/+ lines). Returns null
// for tools that aren't a file mutation.
export const toolDiff = (
  name: string,
  args: string,
  isError: boolean,
): { diff: string; filetype: string } | null => {
  if (isError) return null
  if (name === "edit_file") {
    const path = field(args, "path")
    const o = field(args, "old_string").split("\n")
    const n = field(args, "new_string").split("\n")
    if (o.length + n.length > 600) return null // too big — fall back to text preview (LCS is O(m·k))
    const body = lcsDiffLines(o, n)
    const diff = `--- a/${path}\n+++ b/${path}\n@@ -1,${o.length} +1,${n.length} @@\n${body.join("\n")}\n`
    return { diff, filetype: fileExt(path) }
  }
  if (name === "write_file") {
    const path = field(args, "path")
    const c = field(args, "content").split("\n")
    if (!c.length || c.length > 120) return null
    const diff = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${c.length} @@\n` + c.map((l) => `+${l}`).join("\n") + "\n"
    return { diff, filetype: fileExt(path) }
  }
  return null
}

// Whether an expanded body is even worth offering. Cheap reads/searches whose
// one-line summary already says everything get NO expander (keeps scrollback
// compact); bash-with-output, file mutations, and errors keep the drill-down.
export const toolHasBody = (name: string, result: string, isError: boolean): boolean => {
  if (isError) return true
  const empty = /^\(no (output|matches)\)/.test(result.trim()) || result.trim() === ""
  switch (name) {
    case "read_file":
    case "glob":
    case "grep":
      return !empty
    case "bash":
      return !empty
    case "write_file":
    case "edit_file":
      return true
    default:
      return !empty
  }
}

// A unified-diff body line ("-del"/"+add"/" ctx") → a toned PreviewLine: the leading sign maps to
// the tone (del/add/dim) and is STRIPPED from the text (the renderer re-adds it via previewSign), so
// the fallback reads as a real -/+ diff, not a sign-glued dump. Shared by the edit_file fallback.
const diffLineToPreview = (l: string): PreviewLine => {
  const sign = l[0]
  const text = l.slice(1)
  return sign === "+" ? { text, tone: "add" } : sign === "-" ? { text, tone: "del" } : { text, tone: "dim" }
}

/** The explicit, per-tool detail body shown when a tool row is expanded. `cols` = char budget
 * per line (width-aware truncation). `max` = the LINE cap: when set (tool-view.tsx passes
 * collapseMax(name) collapsed, or a large number expanded) it OVERRIDES the per-tool default, so
 * the collapse "first N + … +M more" is a SINGLE authority (headLines appends the "… +M more"
 * line itself). edit_file/write_file render via toolDiff (native <diff>) — this is the TINY FALLBACK
 * they hit ONLY when the diff is too big for the native renderer (toolDiff returns null): a minimal
 * LCS -/+ diff (edit) / a head of the added content (write), NOT the old whole-block del+add dump. */
export const toolPreview = (name: string, args: string, result: string, isError: boolean, cols = 200, max?: number): Array<PreviewLine> => {
  if (isError || result.trim().startsWith("error:")) return [{ text: result.trim().slice(0, 200), tone: "del" }]
  const empty = /^\(no (output|matches)\)/.test(result.trim()) || result.trim() === ""
  const cap = (dflt: number) => max ?? dflt
  switch (name) {
    case "bash":
      return empty ? [{ text: "(no output)", tone: "dim" }] : headLines(result, cap(10), cols)
    case "read_file":
      return headLines(result, cap(8), cols)
    case "write_file": {
      const content = field(args, "content")
      return content ? headLines(content, cap(8), cols) : [{ text: result, tone: "dim" }]
    }
    case "edit_file": {
      // TINY FALLBACK (native <diff> is the primary render): a real minimal LCS diff (context +
      // the -/+ lines) so even the text fallback shows ONLY what changed, not a full-rewrite dump.
      const diff = lcsDiffLines(field(args, "old_string").split("\n"), field(args, "new_string").split("\n"))
      const clamp = (t: string) => (t.length > cols ? `${t.slice(0, cols - 1)}…` : t)
      const previewLines: Array<PreviewLine> = []
      for (const l of diff.slice(0, cap(6))) {
        const p = diffLineToPreview(l)
        previewLines.push({ text: clamp(p.text), tone: p.tone })
      }
      if (diff.length > cap(6)) previewLines.push({ text: `… +${diff.length - cap(6)} more`, tone: "dim" })
      return previewLines
    }
    case "glob":
    case "grep":
      return empty ? [{ text: "(no matches)", tone: "dim" }] : headLines(result, cap(10), cols)
    case "web_fetch":
      return empty ? [{ text: "(empty response)", tone: "dim" }] : headLines(result, cap(10), cols)
    default:
      return headLines(result, cap(6), cols)
  }
}

export const toolSummary = (name: string, result: string, isError: boolean): string => {
  if (isError || result.trim().startsWith("error:")) return "error"
  const empty = /^\(no (output|matches)\)/.test(result.trim())
  switch (name) {
    case "bash":
      return empty || result.trim() === "" ? "no output" : plural(lines(result), "line")
    case "read_file":
      return plural(lines(result), "line")
    case "write_file":
      return "written"
    case "edit_file":
      return result.startsWith("error") ? "no match" : "updated"
    case "glob":
      return plural(empty ? 0 : lines(result), "file")
    case "grep":
      return plural(empty ? 0 : lines(result), "match", "matches")
    case "web_fetch":
      return result.startsWith("error:") ? "error" : plural(lines(result), "line")
    default:
      return "done"
  }
}
