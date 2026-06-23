// GENERIC SEARCHABLE DIALOG — DialogSelect<T>. Ported from opencode ui/dialog-select.tsx:79-657
// (Solid + @opentui/keymap + fuzzysort) to opentui REACT. The reusable picker primitive behind
// the command palette / session switcher / model pick: a centered overlay holding a search line +
// a filtered, optionally-CATEGORISED, SCROLLABLE node list with ↑↓/page/home/end nav.
//
// Solid→React port notes (no createSignal/Show/For/createStore):
//   - opencode's reactive store (selected/filter/input) → a single useDialogSelect() controller
//     hook (useState + useMemo). It is PRESENTATIONAL-agnostic: chat.tsx owns the OPEN + KEY
//     state and drives the hook's move/submit/append/backspace (exactly like palette.tsx today),
//     so the dialog intercepts keys deterministically while the composer YIELDS focus (captureFocus).
//   - <Show when=…> → {cond && …}; <For each=…> → arr.map(); createMemo → useMemo.
//   - fuzzysort is NOT a dep here (rlmcode ships neither fuzzysort nor remeda — see package.json),
//     so the filter is a case-insensitive SUBSTRING over title (+ category), matching opencode's
//     "prioritise title over category" intent without the dep. Upgrade path noted below.
//   - mouse + actions/footerHints/leader-key from opencode are trimmed to the SPEC surface
//     (items/onSelect/placeholder/footer + categories/grouping + current); the shape is left
//     open to grow back toward the full opencode API.
//
// CHROME: reuses palette.tsx's centered-overlay dialog shape (absolute full-screen wrapper →
// one rounded, accent-bordered, panel-bg card) so every dialog in the TUI reads identically.
// Every color is a theme token (theme.test forbids inline hex outside theme.ts).
//
// ponytail: SUBSTRING filter (no fuzzy ranking), and a fixed-height scroll window (no
// center-on-select scroll math like opencode's moveTo). Upgrade: add fuzzysort (rank title*2 +
// category) + a ScrollBoxRenderable ref that scrolls the active row into view (opencode
// dialog-select.tsx:236-271) once a long picker (model list) needs centering.
import { TextAttributes } from "@opentui/core"
import { useMemo, useState } from "react"
import { type ResolvedTheme } from "./theme.ts"
import { Panel, Separator } from "./ui/panel.tsx"

// One selectable node. `value` is the payload handed to onSelect; `title` is the visible label;
// `hint` is an optional right-aligned key/meta; `description` trails the title dimmed; `category`
// groups it under a header (omit for a flat list).
export type Option<T> = {
  readonly title: string
  readonly value: T
  readonly hint?: string | undefined
  readonly description?: string | undefined
  readonly category?: string | undefined
}

// A category header + its options, in first-seen order. The render unit for grouped lists.
export type Group<T> = { readonly category: string; readonly options: readonly Option<T>[] }

// Case-insensitive substring match over title (+ category). The dep-free stand-in for opencode's
// fuzzysort (keys: title, category; title weighted 2×). Empty needle ⇒ everything (no filter).
const matches = <T,>(opt: Option<T>, needle: string): boolean => {
  if (needle === "") return true
  const n = needle.toLowerCase()
  return opt.title.toLowerCase().includes(n) || (opt.category ?? "").toLowerCase().includes(n)
}

// Group filtered options by category in first-seen order (uncategorised → one leading "" group).
// Pure; the basis for both the flat selection ring and the grouped render.
const group = <T,>(options: readonly Option<T>[]): Group<T>[] => {
  const order: string[] = []
  const by = new Map<string, Option<T>[]>()
  for (const o of options) {
    const c = o.category ?? ""
    if (!by.has(c)) {
      by.set(c, [])
      order.push(c)
    }
    by.get(c)!.push(o)
  }
  return order.map((c) => ({ category: c, options: by.get(c)! }))
}

// The controller model chat.tsx drives. `flat` is the selection ring (grouped order, headers
// excluded) so ↑↓ + Enter index it; `groups` is the render shape. Nav clamps + wraps over `flat`.
export type DialogSelectModel<T> = {
  readonly query: string
  // setQuery(value): set the whole filter (for an <input onInput> consumer — opencode's path).
  readonly setQuery: (q: string) => void
  // appendQuery(ch) / backspaceQuery(): keystroke-driven edits (chat.tsx routes raw keys). They
  // use functional updaters so RAPID typing (driver.type("ber")) can't clobber via a stale closure
  // — the exact hazard the palette's `setPq((q)=>q+ch)` avoids; value-based setQuery would drop chars.
  readonly appendQuery: (ch: string) => void
  readonly backspaceQuery: () => void
  readonly groups: readonly Group<T>[]
  readonly flat: readonly Option<T>[]
  readonly selected: number
  readonly active: Option<T> | undefined
  readonly move: (delta: number) => void
  readonly moveTo: (index: number) => void
  readonly home: () => void
  readonly end: () => void
  readonly submit: () => void
}

// useDialogSelect — the small controller hook (opencode's createStore + move/moveTo/submit,
// Solid→React). Owns query + selected index; derives filtered/grouped/flat via useMemo. Typing
// resets selection to the top (opencode resets on filter change). submit() invokes onSelect with
// the active option. PRESENTATIONAL state (open / key routing) stays in chat.tsx.
export const useDialogSelect = <T,>(
  items: readonly Option<T>[],
  onSelect: (value: T) => void,
): DialogSelectModel<T> => {
  const [query, setQueryRaw] = useState("")
  const [selected, setSelected] = useState(0)

  const flat = useMemo(() => items.filter((o) => matches(o, query)), [items, query])
  const groups = useMemo(() => group(flat), [flat])

  // Clamp the selection into the (possibly shrunk) filtered ring so the highlight never points
  // past the list — typing narrows results, so the index must follow.
  const sel = flat.length === 0 ? 0 : Math.min(selected, flat.length - 1)

  const setQuery = (q: string) => {
    setQueryRaw(q)
    setSelected(0) // a new filter resets to the first match (opencode :212-225)
  }
  // Functional-updater edits: stale-closure-proof under rapid keystrokes (each reads the LIVE
  // query, not the one captured at the handler's last render). Both reset the selection to the top.
  const appendQuery = (ch: string) => {
    setQueryRaw((q) => q + ch)
    setSelected(0)
  }
  const backspaceQuery = () => {
    setQueryRaw((q) => q.slice(0, -1))
    setSelected(0)
  }
  const moveTo = (index: number) => {
    if (flat.length === 0) return
    setSelected(((index % flat.length) + flat.length) % flat.length) // wrap both ways
  }
  const move = (delta: number) => moveTo(sel + delta)
  const home = () => moveTo(0)
  const end = () => moveTo(flat.length - 1)
  const submit = () => {
    const opt = flat[sel]
    if (opt) onSelect(opt.value)
  }

  return { query, setQuery, appendQuery, backspaceQuery, groups, flat, selected: sel, active: flat[sel], move, moveTo, home, end, submit }
}

// One option row: focus marker (›) + title + optional dimmed description + right-aligned hint.
// Active row is bold + accent (matches palette.tsx's selected row).
function OptionRow<T>({ option, active, theme }: { option: Option<T>; active: boolean; theme: ResolvedTheme }) {
  return (
    <box flexDirection="row" justifyContent="space-between" style={{ paddingRight: 1 }}>
      <text fg={active ? theme.accent : theme.text} attributes={active ? TextAttributes.BOLD : 0}>
        {active ? "› " : "  "}
        {option.title}
        {option.description ? <span fg={active ? theme.accent : theme.textMuted}>{`  ${option.description}`}</span> : null}
      </text>
      {option.hint !== undefined ? <text fg={theme.textMuted}>{option.hint}</text> : null}
    </box>
  )
}

// DialogSelect<T> — the presentational overlay. Reads the controller model to know which row is
// active. Renders the palette-style centered card: header (title + esc) → search line →
// grouped/flat scrollable list → footer. chat.tsx routes keys to the model + toggles the mount.
export function DialogSelect<T>({
  title,
  model,
  placeholder,
  footer,
  theme,
  maxRows = 10,
}: {
  title: string
  model: DialogSelectModel<T>
  placeholder?: string | undefined
  footer?: string | undefined
  theme: ResolvedTheme
  // Max visible option rows before the list scrolls (the scrollbox window). Long pickers
  // (sessions/models) clip to this and scroll; short ones render shorter than it.
  maxRows?: number
}) {
  const { query, groups, flat, active } = model
  // The active option's value identity, to mark the highlighted row across group boundaries.
  const activeValue = active?.value
  const empty = flat.length === 0
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" justifyContent="center" alignItems="center">
      <Panel variant="card" borderColor={theme.accent} backgroundColor={theme.backgroundPanel} width={64}>
        {/* header: title + esc hint */}
        <box flexDirection="row" justifyContent="space-between" style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>{title}</text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        {/* search line — the live filter query (the controller owns it; chat.tsx feeds keystrokes) */}
        <box flexDirection="row" style={{ paddingLeft: 1, paddingTop: 1, paddingBottom: 1 }}>
          <text fg={theme.accent}>{"❯ "}</text>
          <text fg={query.length > 0 ? theme.text : theme.muted}>{query.length > 0 ? query : (placeholder ?? "search…")}</text>
        </box>
        {/* divider between the search line and the results (shared Separator). 58 = the 64-wide
            card minus the Panel border (2) + its padding (2) + this box's L/R padding (2). */}
        <box style={{ paddingLeft: 1, paddingRight: 1, paddingBottom: 1 }}>
          <Separator color={theme.border} width={58} />
        </box>
        {/* filtered, grouped, scrollable list. maxHeight makes a long list scroll instead of
            blowing past the card; a short list renders shorter. */}
        {empty ? (
          <box style={{ paddingLeft: 1 }}>
            <text fg={theme.muted}>  no matches</text>
          </box>
        ) : (
          <scrollbox style={{ paddingLeft: 1, maxHeight: maxRows }} scrollY scrollbarOptions={{ visible: false }}>
            {groups.map((g, gi) => (
              <box key={g.category || `__${gi}`} flexDirection="column" paddingTop={gi > 0 ? 1 : 0}>
                {/* category header (omitted for the uncategorised "" group) */}
                {g.category ? (
                  <text fg={theme.primary} attributes={TextAttributes.BOLD}>{g.category}</text>
                ) : null}
                {g.options.map((o, oi) => (
                  <OptionRow key={`${g.category}:${oi}:${o.title}`} option={o} active={o.value === activeValue} theme={theme} />
                ))}
              </box>
            ))}
          </scrollbox>
        )}
        {/* footer: caller-supplied hint, else the default nav line */}
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={theme.textMuted}>{footer ?? "↵ select · ↑↓ move · esc close"}</text>
        </box>
      </Panel>
    </box>
  )
}
