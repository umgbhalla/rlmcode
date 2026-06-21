// Toolset for the agent (ax ReAct functions). Mirrors Claude Code's core:
// bash, read, write, edit, glob, grep. ax executes these in a loop during
// forward() and emits a `Tool: <name>` span per call -> nested in motel.
// Each call also emits a ToolEvent so the TUI can render tool activity live.
//
// NOTE: unsandboxed — runs real shell/fs in the process cwd. Local-dev only.
import { AxFunctionError, type AxFunction } from "@ax-llm/ax"
import { $ } from "bun"

const cap = (s: string, n = 20000) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s)

// Throw AxFunctionError so ax records a `function.error` span event, marks the
// tool result isError (-> red row in the TUI), and feeds the message back to the
// model as fixing instructions. Returning an "error:" string instead would make
// ax mark the Tool span green -> the failure is invisible in motel and the UI.
const fail = (field: string, message: string): never => {
  throw new AxFunctionError([{ field, message }])
}

const readText = async (path: string) => {
  try {
    return await Bun.file(path).text()
  } catch (e: any) {
    return fail("path", `cannot read ${path}: ${e.message}`)
  }
}

export const tools: AxFunction[] = [
  {
    name: "bash",
    description:
      "Run a shell command and return combined stdout+stderr. Use for running code, git, builds, tests, installing deps, listing files, anything a terminal can do.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "shell command to run" } },
      required: ["command"],
    },
    func: async ({ command }: { command: string }) => {
      try {
        const out = await $`bash -c ${command}`.text()
        return cap(out) || "(no output)"
      } catch (e: any) {
        return cap(`exit ${e.exitCode ?? "?"}\n${e.stdout?.toString?.() ?? ""}\n${e.stderr?.toString?.() ?? e.message ?? e}`)
      }
    },
  },
  {
    name: "read_file",
    description:
      "Read a file's contents. Optionally read a specific line range with offset and limit. Useful for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        offset: { type: "number", description: "1-indexed line number to start reading from" },
        limit: { type: "number", description: "maximum number of lines to read" },
      },
      required: ["path"],
    },
    func: async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
      const raw = await readText(path)
      const lines = raw.split("\n")
      const total = lines.length
      const start = offset && offset > 0 ? offset - 1 : 0
      const end = limit && limit > 0 ? start + limit : total
      const selected = lines.slice(start, end)
      const prefix = offset || limit ? `[lines ${start + 1}-${Math.min(end, total)} of ${total}]\n` : ""
      return cap(prefix + selected.join("\n"), 40000)
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "file path" }, content: { type: "string", description: "file content" } },
      required: ["path", "content"],
    },
    func: async ({ path, content }: { path: string; content: string }) => {
      try {
        await Bun.write(path, content)
        return `wrote ${content.length} bytes to ${path}`
      } catch (e: any) {
        return fail("path", `cannot write ${path}: ${e.message}`)
      }
    },
  },
  {
    name: "edit_file",
    description:
      "Replace old_string with new_string in a file. old_string must match exactly. Set replace_all to true to replace every occurrence.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        old_string: { type: "string", description: "exact text to replace" },
        new_string: { type: "string", description: "replacement text" },
        replace_all: { type: "boolean", description: "replace all occurrences" },
      },
      required: ["path", "old_string", "new_string"],
    },
    func: async ({ path, old_string, new_string, replace_all }: { path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
      try {
        const cur = await Bun.file(path).text()
        if (!cur.includes(old_string)) return fail("old_string", `old_string not found in ${path}`)
        const next = replace_all ? cur.split(old_string).join(new_string) : cur.replace(old_string, new_string)
        await Bun.write(path, next)
        return `edited ${path}`
      } catch (e: any) {
        if (e instanceof AxFunctionError) throw e
        return fail("path", `cannot edit ${path}: ${e.message}`)
      }
    },
  },
  {
    name: "glob",
    description: "Find files by glob pattern (e.g. 'src/**/*.ts').",
    parameters: { type: "object", properties: { pattern: { type: "string", description: "glob pattern" } }, required: ["pattern"] },
    func: async ({ pattern }: { pattern: string }) => {
      try {
        const hits = await Array.fromAsync(new Bun.Glob(pattern).scan({ dot: false }))
        return cap(hits.slice(0, 200).join("\n"), 8000) || "(no matches)"
      } catch (e: any) {
        return fail("pattern", `bad glob '${pattern}': ${e.message}`)
      }
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with ripgrep. Supports output_mode: 'files_with_matches' (default), 'content', or 'count'. Use context, head_limit, and offset to control results.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regex pattern" },
        path: { type: "string", description: "dir or file to search (default cwd)" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "output mode" },
        glob: { type: "string", description: "glob filter (e.g. '*.ts')" },
        context: { type: "number", description: "lines of context around each match" },
        head_limit: { type: "number", description: "limit output lines/entries" },
        offset: { type: "number", description: "skip first N lines/entries" },
      },
      required: ["pattern"],
    },
    func: async ({
      pattern,
      path,
      output_mode = "files_with_matches",
      glob,
      context,
      head_limit,
      offset,
    }: {
      pattern: string
      path?: string
      output_mode?: "content" | "files_with_matches" | "count"
      glob?: string
      context?: number
      head_limit?: number
      offset?: number
    }) => {
      const where = path ?? "."
      const args = ["--hidden", "--max-columns", "500"]
      if (output_mode === "files_with_matches") args.push("-l")
      if (output_mode === "count") args.push("-c")
      if (output_mode === "content") {
        args.push("-n")
        if (context && context > 0) args.push("-C", String(context))
      }
      if (glob) args.push("--glob", glob)
      if (pattern.startsWith("-")) args.push("-e", pattern)
      else args.push(pattern)
      args.push(where)

      try {
        const out = await $`rg ${args}`.text()
        const lines = out.split("\n").filter((l) => l.length > 0)
        const start = offset && offset > 0 ? offset : 0
        const limit = head_limit && head_limit > 0 ? head_limit : output_mode === "files_with_matches" ? 250 : 250
        const sliced = lines.slice(start, start + limit)
        const suffix = lines.length - start > limit ? `\n…[truncated ${lines.length - start - limit} more]` : ""
        return cap(sliced.join("\n") + suffix, 12000) || "(no matches)"
      } catch (e: any) {
        // rg exit 1 = no matches (not an error). exit >=2 = real failure
        // (bad regex, unreadable path) -> surface as a tool error, not a silent
        // "(no matches)" that hides the bug from the model and the trace.
        if (e?.exitCode === 1) return "(no matches)"
        return fail("pattern", `ripgrep error: ${String(e?.stderr ?? e?.message ?? e).slice(0, 500)}`)
      }
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return the response body as text. Useful for reading docs, issues, or raw files.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    },
    func: async ({ url }: { url: string }) => {
      try {
        const res = await fetch(url, { redirect: "follow" })
        if (!res.ok) return fail("url", `HTTP ${res.status} ${res.statusText}`)
        const text = await res.text()
        return cap(text, 20000) || "(empty response)"
      } catch (e: any) {
        if (e instanceof AxFunctionError) throw e
        return fail("url", `fetch failed: ${e.message}`)
      }
    },
  },
]
