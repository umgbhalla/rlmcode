// Theme tokens: the ONE place the TUI palette lives, so a color is named by ROLE
// (text/muted/error/…) not repeated as a raw hex across chat.tsx. Catppuccin-Mocha.
//
// Shape ported from termcast's ResolvedTheme (../termcast/src/themes.ts) so the token
// vocabulary matches the opencode/termcast-grade shell the rest of the TUI migrates toward
// (text/textMuted/background/backgroundPanel/backgroundElement/primary/accent/border/
// borderActive/success/warning/error/info + the markdown/diff tokens rlmcode actually renders).
// Catppuccin-Mocha is the ONE default palette — chosen to MATCH the colors already shipped,
// so this is a pure re-shape: every hex below is byte-identical to what chat.tsx rendered
// before, just named by termcast role. The legacy rlmcode role names (subtext/dim/faint/ok/busy/
// focus/white) are kept as ALIASES onto the same hexes so chat.tsx / orch-tree.ts need no
// edit beyond the existing `import { theme }`.
//
// ponytail: single hard-coded palette (no runtime theme switch / no useStore like termcast).
// Upgrade: when a theme picker lands, swap getTheme() to read a selected name from atoms and
// resolve via a DEFAULT_THEMES map (termcast getResolvedTheme shape), keeping useTheme() stable.
import { SyntaxStyle } from "@opentui/core"

// Catppuccin-Mocha source swatches (the named palette this theme is cut from).
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

// The ONE default palette. Every value MATCHES the colors rlmcode already shipped (the render is
// byte-identical); the new termcast-role names are added alongside the legacy aliases.
const catppuccinMocha: ResolvedTheme = {
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
  // Syntax — Catppuccin-Mocha's conventional code highlighting roles (the standard Mocha mapping:
  // keyword=mauve, string=green, function=blue, number=peach, type=yellow, comment=overlay).
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

// DEFAULT_THEME: the named default (the one palette today). The seam a theme picker resolves a
// SELECTED name against later (a DEFAULT_THEMES map, per the ponytail upgrade note above); for now
// resolveTheme() always returns it. Named export so callers read intent, not the raw const.
export const DEFAULT_THEME: ResolvedTheme = catppuccinMocha

// resolveTheme(name?): the theme a given name resolves to. One palette today ⇒ always DEFAULT_THEME
// (the `name` arg is the forward-compatible seam — termcast's getResolvedTheme(name) shape — so a
// picker can pass a selection without changing call sites). Pure. getTheme()/the `theme` const both
// flow through this, so it is the single resolution point a picker hooks (no dead seam).
export const resolveTheme = (_name?: string): ResolvedTheme => DEFAULT_THEME

// getTheme(): the module-const accessor (no useStore — rlmcode has one palette). Returns the
// resolved token object via resolveTheme() — the single source of truth for every color in the TUI.
export const getTheme = (): ResolvedTheme => resolveTheme()

// useTheme(): React-component accessor matching termcast's hook signature, so component code
// reads `const t = useTheme()`. With one static palette it's a thin wrapper over getTheme();
// it stays the seam a future theme picker swaps to a reactive atom read.
export const useTheme = (): ResolvedTheme => getTheme()

// `theme`: the resolved token object, exported for non-component modules (orch-tree.ts) and the
// existing chat.tsx attrs (`fg={theme.text}` / `borderColor={theme.border}`). Unchanged name so
// the sweep is a no-op diff at the call sites. Resolved through resolveTheme() (== DEFAULT_THEME).
export const theme: ResolvedTheme = resolveTheme()

// SYNTAX SCOPE → TOKEN map: the tree-sitter / markup scope names opentui's <markdown> + <code> +
// <diff> renderables emit (Markdown.ts createChunk groups: markup.heading/raw/strong/italic/link;
// Code.ts tree-sitter groups: keyword/string/function/number/type/comment/…), each mapped to a
// theme token. opentui's getStyle() falls back scope → first-segment → "default" (Markdown.ts:432-
// 446), so registering these leaf scopes + a "default" covers the whole highlight surface. The bare
// SyntaxStyle.create() rlmcode shipped registers NOTHING, so highlighted code rendered all one
// color; this is the wiring that makes a fenced ```ts block + the native <diff> read in palette.
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
// active palette — the single shared style chat.tsx feeds to <markdown syntaxStyle> and <diff
// syntaxStyle>. Uses opentui's registerStyle (syntax-style.d.ts:48) per scope. REPLACES the bare
// SyntaxStyle.create() (zero registered styles ⇒ code rendered flat); now keyword/string/comment/…
// + markdown headings/code/bold + diff +/- all resolve to theme tokens. getStyle() round-trips the
// registered fg, so theme.test asserts the wiring without a frame (a deterministic RGBA compare).
export const makeSyntaxStyle = (t: ResolvedTheme = DEFAULT_THEME): SyntaxStyle => {
  const style = SyntaxStyle.create()
  for (const [scope, def] of Object.entries(syntaxScopes(t))) style.registerStyle(scope, def)
  return style
}
