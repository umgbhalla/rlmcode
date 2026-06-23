// COMMAND PALETTE (⌘K / Ctrl+K) — now a THIN WRAPPER over the generic DialogSelect<T> primitive
// (dialog-select.tsx). It used to be its own centered card (search line + hand-rolled filtered
// list + footer); that chrome is gone — the palette is just DialogSelect specialised to the command
// registry (title "Commands", a run/nav/close footer). Every dialog in the TUI (this palette, plus
// the session/model pickers to come) now shares ONE primitive, so they read identically and the
// filter/scroll/keyboard-nav logic lives in exactly one place (the useDialogSelect controller).
//
// chat.tsx still owns the open/close boolean + DRIVES the useDialogSelect controller (the live
// command registry + key routing) so the palette intercepts keys deterministically while the
// composer YIELDS focus via captureFocus; this component only supplies the command-specific chrome
// (title/footer/placeholder) and hands the model straight to DialogSelect. A command's `value` in
// the controller is its `run` thunk, so the controller's submit() = invoke the command.
import { DialogSelect, type DialogSelectModel } from "./dialog-select.tsx"
import { type ResolvedTheme } from "./theme.ts"

// A command the palette can run. `hint` is the optional key shortcut shown right-aligned (it maps
// to DialogSelect's Option.hint). `run` is the action chat.tsx wraps as the option's value, so the
// controller's submit() invokes it. Kept here (not in dialog-select.tsx) because it's the
// command-palette's DOMAIN shape — DialogSelect itself is value-generic.
export type Command = { readonly title: string; readonly hint?: string | undefined; readonly run: () => void }

// The palette = DialogSelect titled "Commands" with the command run/nav/close footer. The model is
// built by chat.tsx via useDialogSelect over the command registry (each option's value = a command
// run thunk); selecting a row runs that command + closes the palette (chat.tsx wires onSelect).
export function Palette({ model, theme }: { model: DialogSelectModel<() => void>; theme: ResolvedTheme }) {
  return (
    <DialogSelect
      title="Commands"
      model={model}
      placeholder="search commands…"
      footer="↵ run · ↑↓ select · esc close"
      theme={theme}
    />
  )
}
