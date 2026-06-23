// Theme tokens: the ONE place the TUI palette lives, so a color is named by ROLE
// (text/muted/error/…) not repeated as a raw hex across chat.tsx. Now a REGISTRY of curated
// dark palettes (rlmcode-dark default + gruvbox/tokyonight/high-contrast), runtime-switchable.
//
// Shape ported from termcast's ResolvedTheme (../termcast/src/themes.ts) so the token
// vocabulary matches the opencode/termcast-grade shell the rest of the TUI is built on
// (text/textMuted/background/backgroundPanel/backgroundElement/primary/accent/border/
// borderActive/success/warning/error/info + the markdown/diff/syntax tokens rlmcode renders).
// The legacy rlmcode role names (subtext/dim/faint/ok/busy/focus/white) are kept as ALIASES so
// the pure helpers (toolui/orch-tree/messages) that read `theme.x` need no per-call edit.
//
// REACTIVITY (the picker): `theme` is a LIVE object — setActiveTheme(name) Object.assign's the new
// palette's keys ONTO it in place, so every `import { theme }` reader (the PURE helpers) sees the
// new palette on the next render WITHOUT importing a hook. The React seam (a re-render so components
// actually repaint, plus useTheme()) lives in theme-context.tsx; getTheme() is the non-component
// accessor onto this same live object. (opencode resolves a selected NAME → Theme; same here.)
import { SyntaxStyle } from "@opentui/core"

// ── Catppuccin-Mocha source swatches (the default palette is cut from these). ──
const mocha = {
  rosewater: "#f5e0dc",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  overlay0: "#6c7086",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  green: "#a6e3a1",
  teal: "#94e2d5",
  red: "#f38ba8",
  maroon: "#eba0ac",
  yellow: "#f9e2af",
  peach: "#fab387",
  blue: "#89b4fa",
  lavender: "#b4befe",
  mauve: "#cba6f7",
  white: "#ffffff",
} as const

export type ResolvedTheme = {
  // Text
  readonly text: string
  readonly textMuted: string
  // Background
  readonly background: string
  readonly backgroundPanel: string
  readonly backgroundElement: string
  // Primary / accent
  readonly primary: string
  readonly accent: string
  // Semantic
  readonly info: string
  readonly success: string
  readonly warning: string
  readonly error: string
  // Border
  readonly border: string
  readonly borderActive: string
  // Diff (the subset rlmcode's tool previews / native <diff> drive)
  readonly diffAdded: string
  readonly diffRemoved: string
  readonly diffContext: string
  // Markdown (the subset rlmcode's reply <markdown> drives)
  readonly markdownText: string
  readonly markdownHeading: string
  readonly markdownLink: string
  readonly markdownCode: string
  readonly markdownEmph: string
  readonly markdownStrong: string
  // Syntax (tree-sitter code-block scopes — fenced ```lang blocks in replies + native <diff>).
  // These are the tokens makeSyntaxStyle() registers onto opentui's SyntaxStyle so highlighted
  // code resolves to the palette instead of the bare (empty) SyntaxStyle.create() default.
  readonly syntaxKeyword: string
  readonly syntaxString: string
  readonly syntaxFunction: string
  readonly syntaxNumber: string
  readonly syntaxType: string
  readonly syntaxComment: string
  readonly syntaxVariable: string
  readonly syntaxConstant: string
  readonly syntaxOperator: string
  readonly syntaxPunctuation: string
  // Legacy rlmcode role aliases (kept so existing chat.tsx / orch-tree.ts attrs resolve unchanged)
  readonly subtext: string
  readonly muted: string
  readonly dim: string
  readonly faint: string
  readonly ok: string
  readonly busy: string
  readonly focus: string
  readonly white: string
}

// `Theme` = a registry entry: a display name + its resolved token object. The picker lists the
// names; setActiveTheme resolves a name → its palette (the opencode resolver pattern).
export type Theme = { readonly name: string; readonly label: string; readonly palette: ResolvedTheme }

// ── THE DEFAULT PALETTE (rlmcode-dark) — every value MATCHES the colors rlmcode already shipped, so
// the default render is byte-identical to before the registry. Catppuccin-Mocha, named by role. ──
const rlmcodeDark: ResolvedTheme = {
  // Text
  text: mocha.text, // primary foreground (reply, focused input)
  textMuted: mocha.overlay1, // status / idle hints  (== legacy `muted`)
  // Background
  background: mocha.base, // app base
  backgroundPanel: mocha.mantle, // panels / sidebars
  backgroundElement: mocha.surface0, // raised element (selected row)
  // Primary / accent
  primary: mocha.blue, // brand / interactive primary
  accent: "#66aaff", // user message / composer border / cursor (legacy rlmcode accent)
  // Semantic
  info: mocha.blue,
  success: mocha.green, // success / agent reply marker  (== legacy `ok`)
  warning: mocha.yellow, // budget warning            (close to legacy `busy`)
  error: mocha.red, // errors / failed tools     (== legacy `error`)
  // Border
  border: mocha.surface1, // turn left-border
  borderActive: mocha.yellow, // active / focused border
  // Diff
  diffAdded: mocha.green, // +add lines (== legacy `ok`)
  diffRemoved: mocha.red, // -del lines (== legacy `error`)
  diffContext: mocha.overlay0, // context lines (== legacy `dim`)
  // Markdown
  markdownText: mocha.text,
  markdownHeading: mocha.blue,
  markdownLink: mocha.blue,
  markdownCode: mocha.teal,
  markdownEmph: mocha.lavender,
  markdownStrong: mocha.peach, // **bold** in replies (distinct from emph's lavender)
  // Syntax — Catppuccin-Mocha's conventional code highlighting roles.
  syntaxKeyword: mocha.mauve,
  syntaxString: mocha.green,
  syntaxFunction: mocha.blue,
  syntaxNumber: mocha.peach,
  syntaxType: mocha.yellow,
  syntaxComment: mocha.overlay0,
  syntaxVariable: mocha.text,
  syntaxConstant: mocha.peach,
  syntaxOperator: mocha.teal,
  syntaxPunctuation: mocha.overlay2,
  // Legacy rlmcode role aliases — same hexes as before, kept so no other file needs editing.
  subtext: mocha.overlay2, // step narration
  muted: mocha.overlay1, // status / idle hints
  dim: mocha.overlay0, // secondary meta (thinking, group summary, σ)
  faint: mocha.surface2, // faint gutter / streamed-thinking body
  ok: mocha.green, // success / agent reply marker
  busy: "#ffd166", // in-flight spinner / budget warning (legacy rlmcode busy)
  focus: mocha.yellow, // keyboard focus ❯ gutter
  white: mocha.white, // tool icon high-contrast
}

// ── GRUVBOX-ish (warm) — Gruvbox-dark's earthy bg + warm accents. A complete palette: every
// ResolvedTheme key set (a missing key = a runtime crash). ──
const gruvbox: ResolvedTheme = {
  text: "#ebdbb2",
  textMuted: "#a89984",
  background: "#282828",
  backgroundPanel: "#1d2021",
  backgroundElement: "#3c3836",
  primary: "#fabd2f", // warm yellow brand
  accent: "#fe8019", // orange interactive accent
  info: "#83a598",
  success: "#b8bb26",
  warning: "#fabd2f",
  error: "#fb4934",
  border: "#504945",
  borderActive: "#fabd2f",
  diffAdded: "#b8bb26",
  diffRemoved: "#fb4934",
  diffContext: "#665c54",
  markdownText: "#ebdbb2",
  markdownHeading: "#fabd2f",
  markdownLink: "#83a598",
  markdownCode: "#8ec07c",
  markdownEmph: "#d3869b",
  markdownStrong: "#fe8019",
  syntaxKeyword: "#fb4934",
  syntaxString: "#b8bb26",
  syntaxFunction: "#fabd2f",
  syntaxNumber: "#d3869b",
  syntaxType: "#fabd2f",
  syntaxComment: "#928374",
  syntaxVariable: "#ebdbb2",
  syntaxConstant: "#d3869b",
  syntaxOperator: "#8ec07c",
  syntaxPunctuation: "#a89984",
  subtext: "#bdae93",
  muted: "#a89984",
  dim: "#665c54",
  faint: "#504945",
  ok: "#b8bb26",
  busy: "#fe8019",
  focus: "#fabd2f",
  white: "#fbf1c7",
}

// ── TOKYONIGHT-ish (cool) — Tokyo Night's deep blue bg + cyan/blue accents. Complete. ──
const tokyonight: ResolvedTheme = {
  text: "#c0caf5",
  textMuted: "#565f89",
  background: "#1a1b26",
  backgroundPanel: "#16161e",
  backgroundElement: "#24283b",
  primary: "#7aa2f7",
  accent: "#7dcfff",
  info: "#7aa2f7",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
  border: "#3b4261",
  borderActive: "#7aa2f7",
  diffAdded: "#9ece6a",
  diffRemoved: "#f7768e",
  diffContext: "#414868",
  markdownText: "#c0caf5",
  markdownHeading: "#7aa2f7",
  markdownLink: "#7dcfff",
  markdownCode: "#73daca",
  markdownEmph: "#bb9af7",
  markdownStrong: "#ff9e64",
  syntaxKeyword: "#bb9af7",
  syntaxString: "#9ece6a",
  syntaxFunction: "#7aa2f7",
  syntaxNumber: "#ff9e64",
  syntaxType: "#2ac3de",
  syntaxComment: "#565f89",
  syntaxVariable: "#c0caf5",
  syntaxConstant: "#ff9e64",
  syntaxOperator: "#89ddff",
  syntaxPunctuation: "#9aa5ce",
  subtext: "#9aa5ce",
  muted: "#565f89",
  dim: "#414868",
  faint: "#3b4261",
  ok: "#9ece6a",
  busy: "#e0af68",
  focus: "#7aa2f7",
  white: "#ffffff",
}

// ── HIGH-CONTRAST — a near-pure-black bg + bright, saturated accents for maximum legibility.
// Complete; tuned so every role stays readable on #000. ──
const highContrast: ResolvedTheme = {
  text: "#ffffff",
  textMuted: "#a0a0a0",
  background: "#000000",
  backgroundPanel: "#0a0a0a",
  backgroundElement: "#1c1c1c",
  primary: "#00d7ff",
  accent: "#00ffd7",
  info: "#5fafff",
  success: "#5fff5f",
  warning: "#ffd700",
  error: "#ff5f5f",
  border: "#5f5f5f",
  borderActive: "#ffd700",
  diffAdded: "#5fff5f",
  diffRemoved: "#ff5f5f",
  diffContext: "#767676",
  markdownText: "#ffffff",
  markdownHeading: "#00d7ff",
  markdownLink: "#5fafff",
  markdownCode: "#5fffd7",
  markdownEmph: "#ff87ff",
  markdownStrong: "#ffd700",
  syntaxKeyword: "#ff87ff",
  syntaxString: "#5fff5f",
  syntaxFunction: "#00d7ff",
  syntaxNumber: "#ffd700",
  syntaxType: "#5fd7ff",
  syntaxComment: "#8a8a8a",
  syntaxVariable: "#ffffff",
  syntaxConstant: "#ffd700",
  syntaxOperator: "#5fffd7",
  syntaxPunctuation: "#bcbcbc",
  subtext: "#c6c6c6",
  muted: "#a0a0a0",
  dim: "#767676",
  faint: "#5f5f5f",
  ok: "#5fff5f",
  busy: "#ffd700",
  focus: "#ffd700",
  white: "#ffffff",
}

// THE REGISTRY: every theme keyed by its name, plus the ordered name list (the picker's row order).
// rlmcode-dark FIRST (the default). Each palette is COMPLETE — same keys + syntax scopes — so a
// switch can never read an undefined token (a missing key = a runtime crash).
export const themes: Record<string, Theme> = {
  "rlmcode-dark": { name: "rlmcode-dark", label: "rlmcode dark (catppuccin)", palette: rlmcodeDark },
  gruvbox: { name: "gruvbox", label: "gruvbox (warm)", palette: gruvbox },
  tokyonight: { name: "tokyonight", label: "tokyo night (cool)", palette: tokyonight },
  "high-contrast": { name: "high-contrast", label: "high contrast", palette: highContrast },
}
export const THEME_NAMES: ReadonlyArray<string> = ["rlmcode-dark", "gruvbox", "tokyonight", "high-contrast"]

// DEFAULT_THEME: the registry NAME of the default (a string, NOT the palette object — opencode's
// resolver shape, and the contract the registry needs). resolveTheme(name) maps it back to a Theme.
export const DEFAULT_THEME = "rlmcode-dark"

// resolveTheme(name?): the Theme a given NAME resolves to. An unknown / undefined name falls back
// to the default (so a stale persisted name or a typo can never crash). Pure.
export const resolveTheme = (name?: string): Theme => themes[name ?? ""] ?? themes[DEFAULT_THEME]!

// ── THE LIVE PALETTE (the reactivity seam) ──────────────────────────────────────────────────────
// `theme` is a LIVE object every non-component module imports + reads (`theme.text`). setActiveTheme
// Object.assign's a new palette's keys ONTO it in place, so those readers see the new colors on the
// next render with NO hook — the cheap way to make the PURE helpers (toolui/orch-tree/messages/
// header/workflow) reactive without threading a context through every signature. `active.name`
// tracks which theme is live (the picker marks the current row). getTheme() returns this same object.
// A mutable view of the SAME object for in-place writes — `theme` is exported readonly (so consumers
// can't mutate the palette), but setActiveTheme reassigns its keys through this widened alias.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
export const theme: ResolvedTheme = { ...resolveTheme(DEFAULT_THEME).palette }
const liveTheme = theme as Mutable<ResolvedTheme>
// The active theme NAME lives on a single-element HOLDER object (a property mutation, like
// Object.assign on `theme`), NOT a reassigned `let` — so the switch updates module-level live state
// without a closure writing a top-level binding (the design-check "capture" smell). One holder.
const active = { name: DEFAULT_THEME }

// setActiveTheme(name): switch the LIVE palette in place + record the active name. Mutates `theme`
// (so module-const readers repaint on the next render) and returns the resolved Theme (so the React
// seam can also bump component state). An unknown name resolves to the default (never crashes).
export const setActiveTheme = (name: string): Theme => {
  const next = resolveTheme(name)
  active.name = next.name
  Object.assign(liveTheme, next.palette) // in-place: every `import { theme }` reader sees the new palette
  return next
}

// getActiveThemeName(): the name of the live theme (the picker's "current" mark + the persist write).
export const getActiveThemeName = (): string => active.name

// getTheme(): the module accessor onto the LIVE palette — the single source of truth for every color
// in the TUI. Pure non-component helpers call this (or read `theme` directly, same object); the
// React useTheme() hook (theme-context.tsx) wraps it so components re-render on a switch.
export const getTheme = (): ResolvedTheme => theme

// SYNTAX SCOPE → TOKEN map: the tree-sitter / markup scope names opentui's <markdown> + <code> +
// <diff> renderables emit (Markdown.ts createChunk groups: markup.heading/raw/strong/italic/link;
// Code.ts tree-sitter groups: keyword/string/function/number/type/comment/…), each mapped to a
// theme token. opentui's getStyle() falls back scope → first-segment → "default" (Markdown.ts:432-
// 446), so registering these leaf scopes + a "default" covers the whole highlight surface.
const syntaxScopes = (t: ResolvedTheme): Record<string, { fg: string; bold?: boolean; italic?: boolean }> => ({
  // fallback for any unmapped scope (Markdown.ts createChunk uses getStyle("default") as the floor).
  default: { fg: t.markdownText },
  // ── markdown (inline markup the reply <markdown> emits) ──
  "markup.heading": { fg: t.markdownHeading, bold: true },
  "markup.raw": { fg: t.markdownCode }, // inline `code` (+ markup.raw.inline via segment fallback)
  "markup.strong": { fg: t.markdownStrong, bold: true },
  "markup.italic": { fg: t.markdownEmph, italic: true },
  "markup.link": { fg: t.markdownLink },
  "markup.link.label": { fg: t.markdownLink },
  "markup.link.url": { fg: t.markdownLink, italic: true },
  "markup.list": { fg: t.markdownText },
  "markup.quote": { fg: t.textMuted, italic: true },
  // ── code (tree-sitter scopes for fenced ```lang blocks + native <diff>) ──
  keyword: { fg: t.syntaxKeyword },
  string: { fg: t.syntaxString },
  function: { fg: t.syntaxFunction },
  number: { fg: t.syntaxNumber },
  type: { fg: t.syntaxType },
  comment: { fg: t.syntaxComment, italic: true },
  variable: { fg: t.syntaxVariable },
  constant: { fg: t.syntaxConstant },
  operator: { fg: t.syntaxOperator },
  punctuation: { fg: t.syntaxPunctuation },
  // ── diff (native <diff> renderable line scopes) ──
  "diff.plus": { fg: t.diffAdded },
  "diff.minus": { fg: t.diffRemoved },
})

// makeSyntaxStyle(theme?): a REAL opentui SyntaxStyle with every scope above registered onto the
// given palette — the single shared style chat.tsx feeds to <markdown syntaxStyle> and <diff
// syntaxStyle>. Defaults to the LIVE `theme`, so a fresh call after a switch picks up the new palette
// (chat.tsx rebuilds it on the active-theme change). getStyle() round-trips the registered fg, so
// theme.test asserts the wiring without a frame (a deterministic RGBA compare).
export const makeSyntaxStyle = (t: ResolvedTheme = theme): SyntaxStyle => {
  const style = SyntaxStyle.create()
  for (const [scope, def] of Object.entries(syntaxScopes(t))) style.registerStyle(scope, def)
  return style
}
