// AUTOCOMPLETE — the @-mention + /slash popup, ported from opencode
// component/prompt/autocomplete.tsx (Solid → React: createSignal/createMemo/createEffect →
// useState/useMemo/useEffect, Show/Index/For → {cond && …} / .map()). Two triggers:
//   - "@" → repo FILE search (a Bun.Glob fs walk over cwd, fuzzy-ranked) — the @-mention.
//   - "/" → the SLASH COMMAND list (the palette commands, passed in) — the /command menu.
// An anchor-positioned popup (drawn ABOVE the composer card the way opencode docks it over the
// prompt), fuzzy-filtered, driven by ↑↓ / ↵ / esc, that INSERTS the picked text into the composer
// textarea (replacing the live "@query" / "/query" token).
//
// SHAPE (opencode autocomplete.tsx:62-117) — a PRESENTATIONAL <Autocomplete> popup + a
// `useAutocomplete` CONTROLLER hook. The composer owns trigger DETECTION (it sees every keystroke
// via onContentChange) + the focus YIELD (the mode-stack: while the popup is visible the composer
// routes ↑↓/↵/esc to the controller instead of the textarea) — wiring the controller into the
// composer is the SEPARATE wire-autocomplete step. This file is self-contained: it never imports
// chat.tsx/composer.tsx, only theme + icons + the fs walk.
//
// ponytail: the @ file walk is a bounded Bun.Glob scan (no frecency ranking, no .gitignore
// parse beyond skipping node_modules/.git/dist). Upgrade: rank by a frecency store (opencode
// useFrecency) + honor .gitignore once a project file index exists.
import { TextAttributes } from "@opentui/core"
import { useEffect, useMemo, useState } from "react"
import type { ResolvedTheme } from "./theme.ts"
import { getIconShape } from "./icons.ts"

// ── DATA SHAPES ─────────────────────────────────────────────────────────────────────────────
// One pickable row. `value` is what gets INSERTED after the trigger ("@<value>" / "/<value>");
// `display` is what the row shows (== value when omitted); `hint` is an optional right-aligned
// note (a slash command's key shortcut). `kind` drives the leading glyph (file vs command).
export type AcItem = {
  readonly value: string
  readonly display?: string | undefined
  readonly hint?: string | undefined
  readonly kind: "file" | "command"
}

// Which trigger is live (false ⇒ the popup is closed). Mirrors opencode's
// `visible: false | "@" | "/"`.
export type AcMode = false | "@" | "/"

const display = (it: AcItem): string => it.display ?? it.value

// ── FUZZY FILTER (no fuzzysort dep) ─────────────────────────────────────────────────────────
// A subsequence matcher with a light score: every query char must appear IN ORDER in the
// candidate (case-insensitive); contiguous runs + a prefix/word-boundary hit score higher, so
// "atom" ranks "atoms.ts" above "default-agent.ts". An empty query keeps the input order
// (opencode trusts fff's order for files; we keep the walk order). Pure + unit-testable.
export const fuzzyScore = (query: string, candidate: string): number | null => {
  if (query.length === 0) return 0
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  let qi = 0
  let score = 0
  let run = 0
  let prevMatch = -2
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) {
      run = 0
      continue
    }
    run += 1
    score += run // contiguous runs compound
    if (ci === prevMatch + 1) score += 2 // adjacency bonus
    if (ci === 0 || c[ci - 1] === "/" || c[ci - 1] === "-" || c[ci - 1] === "_" || c[ci - 1] === ".") score += 3 // word boundary
    prevMatch = ci
    qi += 1
  }
  if (qi < q.length) return null // not all query chars matched, in order
  // shorter candidates that fully match rank a touch higher (closer to the query)
  return score - candidate.length * 0.01
}

// Rank `items` by fuzzyScore against `query`, dropping non-matches, capped at `limit`. An empty
// query passes everything through in input order (no re-sort) — matches opencode's "no search ⇒
// trust the upstream order" branch. Pure.
export const filterItems = (items: ReadonlyArray<AcItem>, query: string, limit = 10): Array<AcItem> => {
  if (query.trim() === "") return items.slice(0, limit)
  const scored: Array<{ it: AcItem; s: number }> = []
  for (const it of items) {
    const s = fuzzyScore(query, display(it))
    if (s !== null) scored.push({ it, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.it)
}

// ── @ FILE WALK ─────────────────────────────────────────────────────────────────────────────
// A bounded recursive scan of the repo for the @-mention file list. Bun.Glob (the SAME engine the
// `glob` tool uses, tools.ts) walks "**/*"; we skip the heavy/noise dirs and cap the count so a
// huge tree can't stall the popup. Relative POSIX paths (the value inserted after "@"). The cap +
// dir-skip is the ponytail above; a real frecency index is the upgrade. Async — the controller
// loads once per open and the popup filters the loaded set in-memory as the query grows.
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|vendor|out)(\/|$)/
const FILE_CAP = 2000
export const walkRepoFiles = async (cwd: string, cap = FILE_CAP): Promise<Array<string>> => {
  try {
    const out: Array<string> = []
    // `as any` — Bun's global typings aren't always present under tsc's lib; the runtime has it.
    // ponytail: Bun.Glob cast. Upgrade: drop once @types/bun's Glob surfaces in this tsconfig.
    const glob = new (globalThis as any).Bun.Glob("**/*")
    for await (const rel of glob.scan({ cwd, dot: false, onlyFiles: true }) as AsyncIterable<string>) {
      if (SKIP.test(rel)) continue
      out.push(rel)
      if (out.length >= cap) break
    }
    out.sort((a, b) => a.localeCompare(b))
    return out
  } catch {
    return []
  }
}

// ── TRIGGER DETECTION (pure, composer-owned) ────────────────────────────────────────────────
// Given the textarea text + cursor offset, decide whether a popup should be OPEN and on which
// trigger, plus the query text after the trigger. Ported from opencode's onInput + show/hide
// logic (autocomplete.tsx:642-700): "/" opens ONLY at offset 0 with no whitespace before the
// cursor; "@" opens at the nearest "@" before the cursor with no whitespace between it and the
// cursor. Returns the trigger index (where the "@"/"/" sits) so the caller knows the token span
// to replace on select. `null` ⇒ no popup. Pure — the composer calls this on every keystroke.
export type AcTrigger = { readonly mode: "@" | "/"; readonly index: number; readonly query: string }
export const detectTrigger = (text: string, cursor: number): AcTrigger | null => {
  if (cursor <= 0) return null
  const before = text.slice(0, cursor)
  // "/" — slash commands only when "/" is the first char and there's no space yet (a lone command token).
  if (before[0] === "/" && !/\s/.test(before)) return { mode: "/", index: 0, query: before.slice(1) }
  // "@" — nearest "@" before the cursor with NO whitespace between it and the cursor.
  const at = before.lastIndexOf("@")
  if (at === -1) return null
  const between = before.slice(at + 1)
  if (/\s/.test(between)) return null
  // an "@" mid-word (e.g. an email "a@b") shouldn't trigger: require the char before "@" to be a
  // boundary (start, space, or newline) — matches opencode mentionTriggerIndex's word-start rule.
  const prev = at > 0 ? before[at - 1] ?? "" : ""
  if (prev !== "" && !/\s/.test(prev)) return null
  return { mode: "@", index: at, query: between }
}

// Compute the replacement text after picking `item`: splice "<trigger><value> " in for the live
// "<trigger><query>" token at [index, cursor). Returns the new full text + the new cursor offset
// (just after the inserted token + trailing space). Pure — the composer applies it to the textarea
// (setText + cursorOffset). Mirrors opencode insertPart's deleteRange+insertText, minus extmarks.
export const applyInsert = (
  text: string,
  cursor: number,
  trigger: AcTrigger,
  item: AcItem,
): { text: string; cursor: number } => {
  const inserted = `${trigger.mode}${item.value} `
  const next = text.slice(0, trigger.index) + inserted + text.slice(cursor)
  return { text: next, cursor: trigger.index + inserted.length }
}

// ── CONTROLLER HOOK ─────────────────────────────────────────────────────────────────────────
// useAutocomplete — the popup's state machine + key handling, kept OUT of the presentational
// component (opencode's createStore + the useBindings block). The composer owns trigger DETECTION
// (it calls `sync(text, cursor)` on every keystroke) and the focus YIELD (while `mode` is open it
// routes keys to `onKey` instead of the textarea); this hook owns the open/selection/file-load
// state + turns a key into an action, and calls back with the spliced text when an item is picked.
//
// `commands` = the /slash list (passed by the composer from the palette registry). `loadFiles` =
// the @-file source (defaults to walkRepoFiles over cwd; injectable so a fixture/test can feed a
// canned set deterministically). `onInsert` = apply the spliced text to the textarea.
export type AutocompleteController = {
  readonly mode: AcMode
  readonly items: ReadonlyArray<AcItem>
  readonly selected: number
  /** Composer calls this on every keystroke (text + cursor) to open/track/close the popup. */
  readonly sync: (text: string, cursor: number) => void
  /** While open, the composer routes ↑↓/↵/esc here; returns true if the key was consumed. */
  readonly onKey: (name: "up" | "down" | "return" | "escape" | "tab") => boolean
  readonly close: () => void
}

export const useAutocomplete = (opts: {
  commands: ReadonlyArray<AcItem>
  onInsert: (next: { text: string; cursor: number }) => void
  loadFiles?: (() => Promise<Array<string>>) | undefined
}): AutocompleteController => {
  const [trigger, setTrigger] = useState<AcTrigger | null>(null)
  const [selected, setSelected] = useState(0)
  const [files, setFiles] = useState<ReadonlyArray<AcItem>>([])
  // The (text, cursor) at the last sync — applyInsert needs them to splice the picked value in.
  const [pos, setPos] = useState<{ text: string; cursor: number }>({ text: "", cursor: 0 })

  // Load the @ file set ONCE per open of the "@" trigger (not per keystroke): the popup then
  // filters that loaded set in-memory as the query narrows. opencode reloads via a resource keyed
  // on the query (fff ranks server-side); our walk is local + cheap, so load-once + local fuzzy.
  const mode: AcMode = trigger?.mode ?? false
  useEffect(() => {
    if (mode !== "@") return
    let live = true
    const load = opts.loadFiles ?? (() => walkRepoFiles(process.cwd()))
    void load().then((paths) => {
      if (live) setFiles(paths.map((p) => ({ value: p, kind: "file" as const })))
      return undefined
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps — load once when the @ popup opens
  }, [mode])

  // The candidate pool for the live trigger: files for "@", the passed commands for "/".
  const pool = useMemo(
    () => (mode === "@" ? files : mode === "/" ? opts.commands : []),
    [mode, files, opts.commands],
  )
  const items = useMemo(() => filterItems(pool, trigger?.query ?? ""), [pool, trigger?.query])

  // Keep the selection in range as the filtered list shrinks/grows.
  useEffect(() => setSelected((s) => (items.length === 0 ? 0 : Math.min(s, items.length - 1))), [items.length])

  const close = () => {
    setTrigger(null)
    setFiles([])
    setSelected(0)
  }

  const sync = (text: string, cursor: number) => {
    setPos({ text, cursor })
    const t = detectTrigger(text, cursor)
    if (t === null) {
      if (trigger !== null) close()
      return
    }
    // reset the selection when the trigger first opens or the query changes (opencode resets
    // selected on filter()); a same-query re-sync keeps the current selection.
    setTrigger((prev) => {
      if (prev === null || prev.mode !== t.mode || prev.query !== t.query) setSelected(0)
      return t
    })
  }

  const pick = (i: number) => {
    const it = items[i]
    if (!it || !trigger) return
    opts.onInsert(applyInsert(pos.text, pos.cursor, trigger, it))
    close()
  }

  const onKey = (name: "up" | "down" | "return" | "escape" | "tab"): boolean => {
    if (mode === false) return false
    if (name === "escape") return void close(), true
    if (items.length === 0) return true // swallow nav/return keys while the (empty) popup is open
    if (name === "up") return setSelected((s) => (s - 1 + items.length) % items.length), true
    if (name === "down") return setSelected((s) => (s + 1) % items.length), true
    if (name === "return" || name === "tab") return pick(selected), true
    return false
  }

  return { mode, items, selected, sync, onKey, close }
}

// ── PRESENTATIONAL POPUP ─────────────────────────────────────────────────────────────────────
// <Autocomplete> draws the popup card the composer docks ABOVE the textarea (opencode positions it
// `top = anchorY - height` over the prompt). We render it as an absolutely-positioned card the
// composer places via `left`/`bottom` (bottom-anchored so it floats just above the input regardless
// of transcript height). Presentational only: all state comes from the controller via props.
//   - a header: "@ files" / "/ commands" + an esc hint
//   - the filtered rows: a "›" active marker, the kind glyph, the display text, an optional hint
//   - an empty-state line + a footer with the nav hints
export function Autocomplete({
  mode,
  items,
  selected,
  query,
  theme,
  left,
  bottom,
  width,
}: {
  mode: AcMode
  items: ReadonlyArray<AcItem>
  selected: number
  query: string
  theme: ResolvedTheme
  left?: number | undefined
  bottom?: number | undefined
  width?: number | undefined
}) {
  if (mode === false) return null
  const title = mode === "@" ? "@ files" : "/ commands"
  const fileGlyph = getIconShape("read")
  const cmdGlyph = getIconShape("node")
  return (
    <box
      position="absolute"
      left={left ?? 1}
      bottom={bottom ?? 6}
      width={width ?? 56}
      border
      borderStyle="rounded"
      borderColor={theme.accent}
      backgroundColor={theme.backgroundPanel}
      zIndex={100}
      style={{ paddingTop: 0, paddingBottom: 0, paddingLeft: 1, paddingRight: 1 }}
    >
      {/* header: the active trigger + the live query + an esc hint */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>{title}</text>
        <text fg={theme.textMuted}>{query.length > 0 ? query : "esc"}</text>
      </box>
      {/* filtered rows (or an empty-state line) */}
      <box flexDirection="column">
        {items.length === 0 ? (
          <text fg={theme.muted}>  no matches</text>
        ) : (
          items.map((it, i) => (
            <box key={`${it.kind}:${it.value}`} flexDirection="row" justifyContent="space-between" style={{ paddingRight: 1 }}>
              <text fg={i === selected ? theme.accent : theme.text} attributes={i === selected ? TextAttributes.BOLD : 0}>
                {i === selected ? "› " : "  "}
                <span fg={i === selected ? theme.accent : theme.faint}>{`${it.kind === "file" ? fileGlyph : cmdGlyph} `}</span>
                {display(it)}
              </text>
              {it.hint !== undefined ? <text fg={theme.textMuted}>{it.hint}</text> : null}
            </box>
          ))
        )}
      </box>
      {/* footer: nav hints */}
      <box>
        <text fg={theme.textMuted}>↑↓ select · ↵ insert · esc close</text>
      </box>
    </box>
  )
}
