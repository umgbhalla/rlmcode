// WHICH-KEY — a contextual keybind-hint overlay (opencode feature-plugins/system/which-key.tsx
// :184-529, ported Solid→React). It answers "what can I press right now?": the ACTIVE node's
// bindings, grouped by category, laid out in multiple columns when the terminal is wide, with a
// footer toggle hint. PRESENTATIONAL over the registry — chat.tsx owns the open/close state and
// feeds the active-mode `bindings`; this draws the grouped grid from those props (no key routing,
// no mode logic here). The composer YIELDS focus while it's up (captureFocus), same as the palette.
//
// opencode mechanics ported (not copied): Entry={key,label,group}; grouped() → groupBindings()
// (a Map<group,Entry[]> then per-group + group-label sort); the column math (contentWidth →
// 1..3 columns by MAX_COLUMN_WIDTH+COLUMN_GAP, fill column-major) → whichKeyColumns(). Solid's
// For/Show/createMemo map to .map()/{cond && …}/useMemo; no Solid mechanics cross over.
//
// The `bindings` are now read STRAIGHT FROM THE REGISTRY: chat.tsx passes
// activeBindings(mode, binds) (keys.ts) — the active-mode rows projected to this Binding display
// shape — so the overlay is genuinely "presentational over the registry" (the old hand-rolled
// chatBindings() table + the `?`-toggle predicate that lived here are gone; the toggle is a
// registry chord, the bindings a registry projection). The Binding row IS the registry's display row.
import { useMemo } from "react"
import { TextAttributes } from "@opentui/core"
import { type ResolvedTheme } from "./theme.ts"

// One active keybind, the row the registry's active-mode query yields (opencode Entry :70-76;
// keys.ts Bind extends this with the executable mode/chord/run bits). `keys` = the printable
// display chord ("esc", "↑↓", "ctrl+k"); `desc` = what it does; `group` = the category it buckets
// under (the which-key column header).
export type Binding = { readonly keys: string; readonly desc: string; readonly group: string }

// A group = a category label + its bindings (opencode Group :78-81).
export type BindingGroup = { readonly label: string; readonly bindings: readonly Binding[] }

// Column-layout constants (opencode :41-44). A column is at most MAX_COLUMN_WIDTH wide; COLUMN_GAP
// separates columns; up to 3 columns when the terminal can fit them.
const COLUMN_GAP = 4
const MAX_COLUMN_WIDTH = 36
const MAX_COLUMNS = 3
const OVERLAY_WIDTH_RATIO = 0.9
const OVERLAY_MAX_WIDTH = 110

// groupBindings(): bucket bindings by `group`, sort each bucket by desc then keys, then sort the
// groups by label (opencode grouped() :153-166). Pure — stable order so the frame is deterministic.
export const groupBindings = (bindings: readonly Binding[]): BindingGroup[] => {
  const map = new Map<string, Binding[]>()
  for (const b of bindings) map.set(b.group, [...(map.get(b.group) ?? []), b])
  return [...map]
    .map(([label, items]) => ({
      label,
      bindings: items.toSorted((a, b) => a.desc.localeCompare(b.desc) || a.keys.localeCompare(b.keys)),
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label))
}

// whichKeyColumns(): how many columns fit (opencode columns() :214-216). Wide terminal ⇒ up to
// MAX_COLUMNS; narrow ⇒ 1. Pure so the multi-column-if-wide behaviour is unit-assertable.
export const whichKeyColumns = (contentWidth: number): number =>
  Math.max(1, Math.min(MAX_COLUMNS, Math.floor((contentWidth + COLUMN_GAP) / (MAX_COLUMN_WIDTH + COLUMN_GAP)) || 1))

// chunkColumns(): split a flat list into `cols` near-even column-major chunks (opencode shown()
// :238-251 fills column-major down each column). Pure helper kept out of the component so the
// render stays under the nesting budget.
const chunkColumns = <T,>(items: readonly T[], cols: number): T[][] => {
  if (cols <= 1) return [[...items]]
  const perCol = Math.ceil(items.length / cols)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += perCol) out.push(items.slice(i, i + perCol))
  return out
}

// One binding row: right-aligned key chord (accent) + its description (text). The key is fixed-
// width so descriptions line up down a column (opencode entry row :470-489).
function BindingRow({ b, theme }: { b: Binding; theme: ResolvedTheme }) {
  return (
    <box flexDirection="row" style={{ paddingRight: 1 }}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>{b.keys.padStart(7)}</text>
      <text fg={theme.text}>{`  ${b.desc}`}</text>
    </box>
  )
}

// One group column: its category header (muted, bold) + each binding row under it. A column can
// hold several groups stacked (opencode group header + entries :455-489).
function GroupColumn({ groups, width, theme }: { groups: readonly BindingGroup[]; width: number; theme: ResolvedTheme }) {
  return (
    <box flexDirection="column" style={{ width, paddingRight: COLUMN_GAP }}>
      {groups.map((g) => (
        <box key={g.label} flexDirection="column" style={{ marginBottom: 1 }}>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>{g.label}</text>
          {g.bindings.map((b) => (
            <BindingRow key={`${g.label}:${b.keys}:${b.desc}`} b={b} theme={theme} />
          ))}
        </box>
      ))}
    </box>
  )
}

// WHICH-KEY OVERLAY — the centered keybind-hint card. Absolute full-screen overlay (so it floats
// over the transcript without reflowing it, same chrome as palette.tsx). Groups the active
// bindings and lays them out across columns sized to the terminal width; a footer advertises the
// toggle. Renders nothing when no bindings (an empty mode shows no overlay).
export function WhichKey({
  bindings,
  cols,
  theme,
}: {
  bindings: readonly Binding[]
  cols: number
  theme: ResolvedTheme
}) {
  const groups = useMemo(() => groupBindings(bindings), [bindings])
  // Card is up to 90% of the terminal (capped); its inner content width drives the column count.
  const cardWidth = Math.min(OVERLAY_MAX_WIDTH, Math.max(40, Math.floor(cols * OVERLAY_WIDTH_RATIO)))
  const contentWidth = Math.max(1, cardWidth - 4)
  const colCount = useMemo(() => whichKeyColumns(contentWidth), [contentWidth])
  const columns = useMemo(() => chunkColumns(groups, colCount), [groups, colCount])
  const columnWidth = Math.max(1, Math.floor(contentWidth / colCount))
  if (groups.length === 0) return null
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" justifyContent="center" alignItems="center">
      <box
        border
        borderStyle="rounded"
        borderColor={theme.accent}
        backgroundColor={theme.backgroundPanel}
        style={{ maxWidth: "90%", width: cardWidth, paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1 }}
      >
        {/* header: title + esc hint */}
        <box flexDirection="row" justifyContent="space-between" style={{ paddingLeft: 1, paddingRight: 1, marginBottom: 1 }}>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>Keybindings</text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        {/* grouped, multi-column-if-wide grid */}
        <box flexDirection="row" style={{ paddingLeft: 1 }}>
          {columns.map((groupsInCol, i) => (
            <GroupColumn key={i} groups={groupsInCol} width={columnWidth} theme={theme} />
          ))}
        </box>
        {/* footer / toggle hint */}
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={theme.textMuted}>? toggle · esc close</text>
        </box>
      </box>
    </box>
  )
}
