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

const headLines = (s: string, n: number): PreviewLine[] => {
  const all = s.replace(/\s+$/, "").split("\n")
  const out: PreviewLine[] = all.slice(0, n).map((l) => ({ text: l, tone: "dim" as const }))
  if (all.length > n) out.push({ text: `… +${all.length - n} more`, tone: "dim" })
  return out
}

/** The explicit, per-tool detail body shown when a tool row is expanded. */
export const toolPreview = (name: string, args: string, result: string, isError: boolean): PreviewLine[] => {
  if (isError || /^error:/.test(result.trim())) return [{ text: result.trim().slice(0, 200), tone: "del" }]
  const empty = /^\(no (output|matches)\)/.test(result.trim()) || result.trim() === ""
  switch (name) {
    case "bash":
      return empty ? [{ text: "(no output)", tone: "dim" }] : headLines(result, 10)
    case "read_file":
      return headLines(result, 8)
    case "write_file": {
      const content = field(args, "content")
      return content ? headLines(content, 8) : [{ text: result, tone: "dim" }]
    }
    case "edit_file": {
      const del: PreviewLine[] = field(args, "old_string").split("\n").slice(0, 6).map((l) => ({ text: l, tone: "del" as const }))
      const add: PreviewLine[] = field(args, "new_string").split("\n").slice(0, 6).map((l) => ({ text: l, tone: "add" as const }))
      return [...del, ...add]
    }
    case "glob":
    case "grep":
      return empty ? [{ text: "(no matches)", tone: "dim" }] : headLines(result, 10)
    case "web_fetch":
      return empty ? [{ text: "(empty response)", tone: "dim" }] : headLines(result, 10)
    default:
      return headLines(result, 6)
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
