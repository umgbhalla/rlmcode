// COMMAND PALETTE (⌘K / Ctrl+K) — the centered command dialog the composer's "Cmd+K commands"
// hint advertises. termcast actions.tsx ⌘K + dialog.tsx (centered overlay) + list.tsx item row,
// ported to opentui-React. Presentational: chat.tsx owns the open/query/selection state + the
// command registry + key routing (so the palette intercepts keys deterministically while the
// composer YIELDS focus via captureFocus); this draws the dialog from those props.
//
// An absolute, full-screen overlay (termcast DialogOverlay position:absolute) so it floats over
// the transcript without reflowing it; a single centered card holds the search line + the
// filtered command list (› active marker, bold title, right-aligned key hint) + a footer.
import { TextAttributes } from "@opentui/core"
import { type ResolvedTheme } from "./theme.ts"

// A command the palette can run. `hint` is the optional key shortcut shown right-aligned.
export type Command = { readonly title: string; readonly hint?: string | undefined; readonly run: () => void }

export function Palette({
  query,
  sel,
  commands,
  theme,
}: {
  query: string
  sel: number
  commands: readonly Command[]
  theme: ResolvedTheme
}) {
  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" justifyContent="center" alignItems="center">
      <box
        border
        borderStyle="rounded"
        borderColor={theme.accent}
        backgroundColor={theme.backgroundPanel}
        style={{ width: 64, maxWidth: "90%", paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1 }}
      >
        {/* header: title + esc hint */}
        <box flexDirection="row" justifyContent="space-between" style={{ paddingLeft: 1, paddingRight: 1 }}>
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>Commands</text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        {/* search line */}
        <box flexDirection="row" style={{ paddingLeft: 1, paddingTop: 1, paddingBottom: 1 }}>
          <text fg={theme.accent}>{"❯ "}</text>
          <text fg={query.length > 0 ? theme.text : theme.muted}>{query.length > 0 ? query : "search commands…"}</text>
        </box>
        {/* filtered list */}
        <box flexDirection="column" style={{ paddingLeft: 1 }}>
          {commands.length === 0 ? (
            <text fg={theme.muted}>  no matching command</text>
          ) : (
            commands.map((c, i) => (
              <box key={c.title} flexDirection="row" justifyContent="space-between" style={{ paddingRight: 1 }}>
                <text
                  fg={i === sel ? theme.accent : theme.text}
                  attributes={i === sel ? TextAttributes.BOLD : 0}
                >
                  {i === sel ? "› " : "  "}
                  {c.title}
                </text>
                {c.hint !== undefined ? <text fg={theme.textMuted}>{c.hint}</text> : null}
              </box>
            ))
          )}
        </box>
        {/* footer */}
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={theme.textMuted}>↵ run · ↑↓ select · esc close</text>
        </box>
      </box>
    </box>
  )
}
