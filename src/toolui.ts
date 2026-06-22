// Claude-Code-style tool presentation: a human label (Bash(cmd), Read(path),
// Search(pattern)) and a short result summary (6 files, 12 lines), instead of
// raw function name + JSON params / raw output.
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
// a glance. Used as the "done" status mark (running keeps the spinner, error ✗).
export const toolIcon = (name: string): string => {
  switch (name) {
    case "bash":
      return "$"
    case "read_file":
      return "→"
    case "write_file":
    case "edit_file":
      return "←"
    case "glob":
    case "grep":
      return "✱"
    case "web_fetch":
      return "%"
    default:
      return "⏺"
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

// Width-aware: clamp each line to `cols` so one 5000-char line can't blow the
// inline layout, independent of the `n` line cap.
const headLines = (s: string, n: number, cols = 200): PreviewLine[] => {
  const clamp = (l: string) => (l.length > cols ? `${l.slice(0, cols - 1)}…` : l)
  const all = s.replace(/\s+$/, "").split("\n")
  const out: PreviewLine[] = all.slice(0, n).map((l) => ({ text: clamp(l), tone: "dim" as const }))
  if (all.length > n) out.push({ text: `… +${all.length - n} more`, tone: "dim" })
  return out
}

// LCS line diff: the longest common subsequence of the two line arrays is the unchanged
// CONTEXT; everything else is a real -/+ line, IN ORDER. Replaces the old "remove the whole
// old block, add the whole new block" dump (which made a 1-line tweak look like a full
// rewrite). O(m·k) DP — bounded by the caller's line cap. Returns unified-diff body lines
// (" ctx" / "-del" / "+add"). Exported for a headless self-check (scripts/toolui-diff.test).
export const lcsDiffLines = (o: readonly string[], n: readonly string[]): string[] => {
  const m = o.length
  const k = n.length
  // dp[i][j] = LCS length of o[i:] and n[j:]; walked forward to reconstruct in order.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = k - 1; j >= 0; j--) dp[i]![j] = o[i] === n[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < m && j < k) {
    if (o[i] === n[j]) (out.push(` ${o[i]}`), i++, j++)
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) (out.push(`-${o[i]}`), i++)
    else (out.push(`+${n[j]}`), j++)
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
  const ext = (p: string) => (p.includes(".") ? p.split(".").pop()! : "txt")
  if (name === "edit_file") {
    const path = field(args, "path")
    const o = field(args, "old_string").split("\n")
    const n = field(args, "new_string").split("\n")
    if (o.length + n.length > 600) return null // too big — fall back to text preview (LCS is O(m·k))
    const body = lcsDiffLines(o, n)
    const diff = `--- a/${path}\n+++ b/${path}\n@@ -1,${o.length} +1,${n.length} @@\n${body.join("\n")}\n`
    return { diff, filetype: ext(path) }
  }
  if (name === "write_file") {
    const path = field(args, "path")
    const c = field(args, "content").split("\n")
    if (!c.length || c.length > 120) return null
    const diff = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${c.length} @@\n` + c.map((l) => `+${l}`).join("\n") + "\n"
    return { diff, filetype: ext(path) }
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

/** The explicit, per-tool detail body shown when a tool row is expanded. `cols`
 * = char budget per line (width-aware truncation). edit_file/write_file render
 * via toolDiff (native <diff>) so they fall through here only as a text fallback. */
export const toolPreview = (name: string, args: string, result: string, isError: boolean, cols = 200): PreviewLine[] => {
  if (isError || /^error:/.test(result.trim())) return [{ text: result.trim().slice(0, 200), tone: "del" }]
  const empty = /^\(no (output|matches)\)/.test(result.trim()) || result.trim() === ""
  switch (name) {
    case "bash":
      return empty ? [{ text: "(no output)", tone: "dim" }] : headLines(result, 10, cols)
    case "read_file":
      return headLines(result, 8, cols)
    case "write_file": {
      const content = field(args, "content")
      return content ? headLines(content, 8, cols) : [{ text: result, tone: "dim" }]
    }
    case "edit_file": {
      const del: PreviewLine[] = field(args, "old_string").split("\n").slice(0, 6).map((l) => ({ text: l, tone: "del" as const }))
      const add: PreviewLine[] = field(args, "new_string").split("\n").slice(0, 6).map((l) => ({ text: l, tone: "add" as const }))
      return [...del, ...add]
    }
    case "glob":
    case "grep":
      return empty ? [{ text: "(no matches)", tone: "dim" }] : headLines(result, 10, cols)
    case "web_fetch":
      return empty ? [{ text: "(empty response)", tone: "dim" }] : headLines(result, 10, cols)
    default:
      return headLines(result, 6, cols)
  }
}

export const toolSummary = (name: string, result: string, isError: boolean): string => {
  if (isError || /^error:/.test(result.trim())) return "error"
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
