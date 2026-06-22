// Theme tokens (P2): the ONE place the TUI palette lives, so a color is named by ROLE
// (text/muted/error/…) not repeated as a raw hex across chat.tsx. Catppuccin-Mocha-ish.
// Swept into chat.tsx's fg=/borderColor= attrs; functions that return a color string
// (previewColor, orch-tree colorOf) reference these too.
export const theme = {
  text: "#cdd6f4", // primary foreground (reply, focused input)
  subtext: "#9399b2", // step narration
  muted: "#7f849c", // status / idle hints
  dim: "#6c7086", // secondary meta (thinking, group summary, σ)
  faint: "#585b70", // faint gutter / streamed-thinking body
  border: "#45475a", // turn left-border
  ok: "#a6e3a1", // success / agent reply marker
  error: "#f38ba8", // errors / failed tools
  busy: "#ffd166", // in-flight spinner / budget warning
  focus: "#f9e2af", // keyboard focus ❯ gutter
  accent: "#66aaff", // user message / composer border / cursor
  white: "#ffffff", // tool icon high-contrast
} as const
