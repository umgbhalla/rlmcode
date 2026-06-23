// ICONS — the terminal-safe glyph subset ax2 renders, LIFTED from termcast's
// components/icon.tsx (ICON_MAP + getIconShape fallback ●). termcast is React+@opentui
// (ax2's exact stack), so the map ports VERBATIM in shape: a name→glyph Record plus a
// getIconShape(name) with a ● fallback. We carry only the subset ax2 actually paints —
// the per-tool marks (bash/read/write/search/fetch), the node/turn status glyphs
// (running/done/error), the reply + node markers, the velocity-cap connector, and the
// focus gutter — so the one place a glyph is named by ROLE (not a raw literal scattered
// across chat.tsx/orch-tree.ts/toolui.ts) lives here.
//
// Same rules as termcast: ONLY emoji-safe unicode ranges (Arrows U+2190, Math Operators
// U+2200, Geometric Shapes U+25A0, Box Drawing U+2500, Braille U+2800, General
// Punctuation, ASCII) — never an emoji codepoint — so a cell renders one column wide and
// the tree connectors stay aligned across terminals.

// name → terminal-safe glyph. Names are ax2's render ROLES (tool kind / node status /
// transcript marker), not Raycast icon ids — this is the ax2 subset, not the 400-entry map.
const ICON_MAP: Record<string, string> = {
  // ── per-tool marks (the "done" status glyph; see toolui.toolIcon) ──────────────────
  bash: "$", // a shell prompt
  read: "→", // read_file — pull in
  write: "←", // write_file / edit_file — push out
  search: "✱", // glob / grep — a scan asterisk
  fetch: "%", // web_fetch
  tool: "⏺", // generic tool (toolui default)
  // ── node / turn status glyphs (orch-tree glyphOf; ToolView mark) ───────────────────
  running: "◌", // in-flight node (animates to the spinner frame at render)
  done: "✓", // settled ok
  check: "✓", // alias — a passing check
  error: "✗", // failed node / tool
  // ── transcript markers ─────────────────────────────────────────────────────────────
  reply: "⏺", // the agent reply row marker
  node: "▣", // a node / box badge (orchestration node, opencode "▣ mode" footer)
  more: "┄", // velocity-cap "+N earlier" collapsed-sibling marker
  focus: "❯", // keyboard-focus gutter (FocusGutter)
  // ── expander chevrons (turn / tool drill-down) ─────────────────────────────────────
  expanded: "▾",
  collapsed: "▸",
  // ── spinner pulse (first braille frame; the live "thinking" pulse) ─────────────────
  spinner: "⠋",
}

// The single fallback, exactly as termcast: an unknown name renders a filled circle, never
// a blank cell or a tofu box. Keeps the layout stable when a new role isn't yet mapped.
const FALLBACK_ICON = "●"

/** name → terminal-safe glyph for the ax2 render roles, with the termcast ● fallback. */
export const getIconShape = (name: string): string => ICON_MAP[name] ?? FALLBACK_ICON
