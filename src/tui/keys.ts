// KEYBIND REGISTRY + MODE STACK — the hand-rolled replacement for chat.tsx's if-chain key
// dispatch (the old onChatKey / onListKey / onPaletteKey / onWhichKeyKey ladder + the palette /
// whichKey booleans). Ported in SPIRIT from opencode keymap.tsx (KeymapProvider + a mode stack so
// dialogs/autocomplete scope their keys, binding get/gather), but @opentui/keymap is NOT a
// rlmcode dependency (only @opentui/core + @opentui/react are — see package.json), so the
// machinery is hand-rolled here: a {chord,desc,group,when,run}[] table, a chord matcher over
// opentui's ParsedKey, a MODE STACK, and one dispatch() the global useKeyboard calls.
//
// THE MODEL (opencode createOpencodeModeStack:53-100): there is ONE base mode ("base") plus
// transient overlay modes pushed onto a stack. Opening the command palette / a dialog / the
// autocomplete popup / the which-key overlay PUSHES its mode; closing POPS it. The ACTIVE mode is
// the stack top (base when empty). dispatch() only runs bindings whose `mode` is the active one,
// so a base nav key (n / tab / arrows) does NOT fire while a dialog mode is on top — the dialog's
// own bindings (esc/↵/↑↓/edit) scope the keyboard. This is the "dialogs scope keys" contract the
// frame gate proves.
//
// WHY a flat table (not @opentui/keymap's command/binding graph): rlmcode's surface is small (one
// base mode + four overlay modes, a handful of keys each), so a flat {mode, chord, run}[] the host
// builds from live state is simpler than registering commands + a config-driven binding lookup —
// and it feeds the existing which-key overlay directly (its Binding row IS our display shape).
//
// ponytail: a chord matcher over a small grammar ("ctrl+k", "shift+tab", "return", "?") rather
// than @opentui/keymap's full key-sequence engine (no leader keys, no multi-stroke sequences, no
// config-driven rebinding). Upgrade: when @opentui/keymap lands as a dep, swap the matcher +
// mode stack for KeymapProvider + createOpencodeModeStack (its mode-require layer fields), keeping
// this module's Bind/dispatch surface so chat.tsx's table is the only thing that moves.
import { useCallback, useState } from "react"
import type { Binding } from "./which-key.tsx"

// A keyboard event the matcher reads — the fields of opentui's ParsedKey (KeyEvent implements it)
// the chord grammar needs. Kept structural (not an import of ParsedKey) so the registry has no
// hard opentui type coupling and unit tests can hand it a plain object. `sequence` is the raw
// printable (used to match a literal char chord like "?"); `name` is opentui's key name
// ("return"/"tab"/"escape"/"up"/…); the modifier flags gate ctrl+/shift+/meta+ chords.
export type KeyEventLike = {
  readonly name?: string | undefined
  readonly sequence?: string | undefined
  readonly ctrl?: boolean | undefined
  readonly meta?: boolean | undefined
  readonly shift?: boolean | undefined
}

// The overlay modes. "base" is the default (composer + transcript nav). Each overlay (palette /
// dialog / autocomplete / whichkey) is pushed onto the stack while it's open and scopes the
// keyboard to its OWN bindings; "dialog" is the generic mode any DialogSelect-backed overlay
// (a session/model picker) uses. ONE-WORD where the surface allows — these are mode identifiers.
export type Mode = "base" | "palette" | "dialog" | "autocomplete" | "whichkey"

// A registry row: a which-key Binding (keys/desc/group — the DISPLAY shape the overlay reads)
// plus the EXECUTABLE bits. `mode` scopes it (only fires when it's the active mode). `chord` is
// the MACHINE-matchable key spec the matcher parses (e.g. "ctrl+k", "shift+tab", "return", "?")
// — distinct from `keys`, the pretty display glyph ("⌘K", "⇧↵") which-key shows. `when` is an
// optional extra guard (e.g. "only when the composer is empty"); a row with no `when` always
// applies in its mode. `run` performs the action.
//   - `hidden`  keeps a row OUT of the which-key list (e.g. a duplicate ↑/↓ row, or raw
//     char-append) while it still DISPATCHES.
//   - `display` is the inverse: the row is SHOWN by which-key but dispatch IGNORES it. It
//     documents a key the focused widget owns natively — the textarea's Enter→submit /
//     Shift+Enter→newline — so the overlay can advertise it for discovery without the registry
//     double-handling it (the textarea already does). (opencode registers input.* commands for
//     gather/display the same way while the managed-textarea layer actually handles them.)
export type Bind = Binding & {
  readonly mode: Mode
  readonly chord: string
  readonly when?: (() => boolean) | undefined
  readonly hidden?: boolean | undefined
  readonly display?: boolean | undefined
  readonly run: (e: KeyEventLike) => void
}

// ── CHORD MATCHER ────────────────────────────────────────────────────────────────────────────
// A chord is "mods+key": zero or more of ctrl/shift/meta/alt joined by "+", then the key token.
// The key token matches opentui's ParsedKey.name (return/tab/escape/up/down/…) OR, for a literal
// printable like "?", the event's raw `sequence`. Case-insensitive on the key name. Modifiers are
// matched EXACTLY (a chord with no shift won't fire on shift+key) so "return" and "shift+return"
// stay distinct — the submit-vs-newline split the composer relies on.

const KEY_ALIASES: Record<string, string> = {
  // accept friendly aliases in the table; normalize to opentui's ParsedKey.name vocabulary.
  enter: "return",
  esc: "escape",
  pgup: "pageup",
  pgdn: "pagedown",
}

type ParsedChord = { readonly ctrl: boolean; readonly shift: boolean; readonly meta: boolean; readonly key: string }

// parseChord("ctrl+k") → {ctrl, key:"k"}. Pure; the matcher caches nothing (chords are few).
const parseChord = (chord: string): ParsedChord => {
  const parts = chord.split("+")
  const rawKey = parts[parts.length - 1]!.toLowerCase()
  const key = KEY_ALIASES[rawKey] ?? rawKey
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()))
  // "alt" is opentui's `meta`/`option`; fold it into meta so an alt chord matches meta-flagged events.
  return { ctrl: mods.has("ctrl"), shift: mods.has("shift"), meta: mods.has("meta") || mods.has("alt"), key }
}

// matchesChord(event, chord): does this key event satisfy the chord? Modifiers must match exactly;
// the key token matches the event's `name` OR (for a 1-char printable chord like "?") its
// `sequence`. A literal-char chord ignores shift (the printable already encodes it — "?" arrives
// as sequence "?" possibly with shift set on some layouts), so "?" matches regardless of shift.
export const matchesChord = (event: KeyEventLike, chord: string): boolean => {
  const c = parseChord(chord)
  const isLiteral = c.key.length === 1 && !/^[a-z0-9]$/.test(c.key) // e.g. "?" — punctuation literal
  if (c.ctrl !== Boolean(event.ctrl)) return false
  if (c.meta !== Boolean(event.meta)) return false
  if (!isLiteral && c.shift !== Boolean(event.shift)) return false
  if (isLiteral) return event.sequence === c.key
  // single alpha/digit chord: match the printed name; also accept the raw sequence (some keys
  // arrive named, some only as a sequence). Named keys (return/tab/…) match by name only.
  return (event.name ?? "").toLowerCase() === c.key || (event.sequence ?? "").toLowerCase() === c.key
}

// ── MODE STACK ───────────────────────────────────────────────────────────────────────────────
// The active mode is the stack top, "base" when empty (opencode stackApi.current:70-72). push()
// returns its matching pop() so a caller can pair them; openMode/closeMode are the chat.tsx-facing
// helpers (open an overlay → push its mode; close → pop it, idempotent on the specific mode).

export type ModeStack = {
  readonly stack: ReadonlyArray<Mode>
  readonly active: Mode
  readonly push: (mode: Mode) => void
  // pop the TOP if it equals `mode` (idempotent — closing an already-closed overlay is a no-op);
  // pop the top unconditionally when no mode is given.
  readonly pop: (mode?: Mode) => void
  readonly is: (mode: Mode) => boolean
}

// useModeStack(): React hook owning the overlay-mode stack. Base is implicit (empty stack ⇒
// active "base"). Opening an overlay pushes; closing pops its own mode. Functional updaters keep
// rapid open/close stable (no stale-closure clobber, same discipline as the dialog controller).
export const useModeStack = (): ModeStack => {
  const [stack, setStack] = useState<Array<Mode>>([])
  const push = useCallback((mode: Mode) => setStack((s) => [...s, mode]), [])
  const pop = useCallback(
    (mode?: Mode) =>
      setStack((s) => {
        if (s.length === 0) return s
        if (mode !== undefined && s[s.length - 1] !== mode) return s // only pop if our mode is on top
        return s.slice(0, -1)
      }),
    [],
  )
  const active: Mode = stack.length > 0 ? stack[stack.length - 1]! : "base"
  const is = useCallback((mode: Mode) => active === mode, [active])
  return { stack, active, push, pop, is }
}

// ── DISPATCH + PROJECTION ──────────────────────────────────────────────────────────────────────

// dispatch(event, active, binds): run the FIRST binding that (a) is scoped to the active mode,
// (b) matches the event's chord, and (c) passes its `when` guard — then return true (handled). No
// match ⇒ false (the host lets the event fall through to the focused widget, e.g. the textarea
// inserting a char). First-match-wins mirrors the old if-chain's top-to-bottom order, so table
// order is the precedence (put the specific guarded rows — empty-composer Enter — before general
// ones). Only active-mode rows are even considered, so a base nav key can't fire under a dialog.
export const dispatch = (event: KeyEventLike, active: Mode, binds: ReadonlyArray<Bind>): boolean => {
  for (const b of binds) {
    if (b.mode !== active) continue
    if (b.display) continue // display-only doc row (textarea-native key) — never dispatched
    if (!matchesChord(event, b.chord)) continue
    if (b.when && !b.when()) continue
    b.run(event)
    return true
  }
  return false
}

// activeBindings(active, binds): the visible bindings for the active mode, projected to the
// which-key Binding display shape (keys/desc/group). Drops `hidden` rows (raw char-append etc.)
// and rows whose `when` guard currently fails, so the overlay shows exactly what will fire RIGHT
// NOW. This is the seam the which-key overlay reads instead of chat.tsx's old hand-rolled
// chatBindings() table (opencode useBindings / gather, projected to the display row).
export const activeBindings = (active: Mode, binds: ReadonlyArray<Bind>): Array<Binding> =>
  binds
    .filter((b) => b.mode === active && !b.hidden && (!b.when || b.when()))
    .map(({ keys, desc, group }) => ({ keys, desc, group }))
