// Theme tokens: the ONE place the TUI palette lives, so a color is named by ROLE
// (text/muted/error/…) not repeated as a raw hex across chat.tsx. Catppuccin-Mocha.
//
// Shape ported from termcast's ResolvedTheme (../termcast/src/themes.ts) so the token
// vocabulary matches the opencode/termcast-grade shell the rest of the TUI migrates toward
// (text/textMuted/background/backgroundPanel/backgroundElement/primary/accent/border/
// borderActive/success/warning/error/info + the markdown/diff tokens ax2 actually renders).
// Catppuccin-Mocha is the ONE default palette — chosen to MATCH the colors already shipped,
// so this is a pure re-shape: every hex below is byte-identical to what chat.tsx rendered
// before, just named by termcast role. The legacy ax2 role names (subtext/dim/faint/ok/busy/
// focus/white) are kept as ALIASES onto the same hexes so chat.tsx / orch-tree.ts need no
// edit beyond the existing `import { theme }`.
//
// ponytail: single hard-coded palette (no runtime theme switch / no useStore like termcast).
// Upgrade: when a theme picker lands, swap getTheme() to read a selected name from atoms and
// resolve via a DEFAULT_THEMES map (termcast getResolvedTheme shape), keeping useTheme() stable.

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
  // Diff (the subset ax2's tool previews / native <diff> drive)
  readonly diffAdded: string
  readonly diffRemoved: string
  readonly diffContext: string
  // Markdown (the subset ax2's reply <markdown> drives)
  readonly markdownText: string
  readonly markdownHeading: string
  readonly markdownLink: string
  readonly markdownCode: string
  readonly markdownEmph: string
  // Legacy ax2 role aliases (kept so existing chat.tsx / orch-tree.ts attrs resolve unchanged)
  readonly subtext: string
  readonly muted: string
  readonly dim: string
  readonly faint: string
  readonly ok: string
  readonly busy: string
  readonly focus: string
  readonly white: string
}

// The ONE default palette. Every value MATCHES the colors ax2 already shipped (the render is
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
  accent: "#66aaff", // user message / composer border / cursor (legacy ax2 accent)
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
  // Legacy ax2 role aliases — same hexes as before, kept so no other file needs editing.
  subtext: mocha.overlay2, // step narration
  muted: mocha.overlay1, // status / idle hints
  dim: mocha.overlay0, // secondary meta (thinking, group summary, σ)
  faint: mocha.surface2, // faint gutter / streamed-thinking body
  ok: mocha.green, // success / agent reply marker
  busy: "#ffd166", // in-flight spinner / budget warning (legacy ax2 busy)
  focus: mocha.yellow, // keyboard focus ❯ gutter
  white: mocha.white, // tool icon high-contrast
}

// getTheme(): the module-const accessor (no useStore — ax2 has one palette). Returns the
// resolved token object; the single source of truth for every color in the TUI.
export const getTheme = (): ResolvedTheme => catppuccinMocha

// useTheme(): React-component accessor matching termcast's hook signature, so component code
// reads `const t = useTheme()`. With one static palette it's a thin wrapper over getTheme();
// it stays the seam a future theme picker swaps to a reactive atom read.
export const useTheme = (): ResolvedTheme => getTheme()

// `theme`: the resolved token object, exported for non-component modules (orch-tree.ts) and the
// existing chat.tsx attrs (`fg={theme.text}` / `borderColor={theme.border}`). Unchanged name so
// the sweep is a no-op diff at the call sites.
export const theme: ResolvedTheme = catppuccinMocha
