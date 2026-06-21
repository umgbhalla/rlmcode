// Prompt history: persisted, deduped, capped. Plain JSONL in the cwd so it's
// per-project. Sync fs (readFileSync/appendFileSync) so chat.tsx can load at
// module init without an await; appends are tiny. Not traced shared state — no
// atom, just a module-local list the input handler walks with up/down.
import { appendFileSync, existsSync, readFileSync } from "node:fs"

const FILE = ".ax2_history.jsonl"
const CAP = 50

const load = (): string[] => {
  try {
    if (!existsSync(FILE)) return []
    const lines = readFileSync(FILE, "utf8").split("\n").filter((l) => l.trim().length > 0)
    const out: string[] = []
    for (const l of lines) {
      try {
        const v = JSON.parse(l)
        if (typeof v === "string" && v.length > 0) out.push(v)
      } catch {
        /* skip malformed line */
      }
    }
    return out.slice(-CAP)
  } catch {
    return []
  }
}

// Oldest -> newest. Up walks toward index 0 (oldest), down toward the live draft.
const items: string[] = load()

export const history = {
  all: (): readonly string[] => items,
  /** Append a submitted prompt (skips blanks + consecutive dupes), persist. */
  push(entry: string): void {
    const e = entry.trim()
    if (e.length === 0 || items[items.length - 1] === e) return
    items.push(e)
    while (items.length > CAP) items.shift()
    try {
      appendFileSync(FILE, `${JSON.stringify(e)}\n`)
    } catch {
      /* best-effort persistence */
    }
  },
}
