// SESSION SWITCHER + MODEL PICK — the two extra pickers the command palette opens, each a THIN
// wrapper over the SAME generic DialogSelect<T> the palette uses (opencode reuse: opencode has a
// session-list dialog + a models dialog, both built on its ui/dialog-select.tsx; we mirror that).
// Keeping them here (not inlined into chat.tsx) keeps chat.tsx under the file ceiling and puts the
// two pickers' controllers + their shared "dialog"-mode key rows in ONE place.
//
// WHY one "dialog" MODE for two dialogs: both pickers are modal overlays that scope the keyboard
// the same way (esc closes, ↑↓ moves, ↵ selects, ⌫ edits the filter, a printable char appends), so
// they share the generic "dialog" mode on the keys.ts stack. `kind` ("session" | "model" | null)
// disambiguates WHICH picker is mounted; the shared bindings route to the active one via kind. Only
// ONE is ever open (opening one closes the palette first — see chat.tsx — and they never stack).
//
// chat.tsx OWNS the open/close trigger (the palette commands call openSession/openModel) and SPREADS
// `binds` into its registry so the dialog mode's keys dispatch; this module owns the controllers, the
// kind, and the close() that pops the mode AND clears the kind (so the overlay actually unmounts).
import { useCallback, useMemo, useState } from "react"
import { DialogSelect, type DialogSelectModel, type Option, useDialogSelect } from "./dialog-select.tsx"
import type { Bind, KeyEventLike, ModeStack } from "./keys.ts"
import { MODELS, type ModelName } from "../app/default-agent.ts"
import { type ResolvedTheme, themes } from "./theme.ts"

// A session row the switcher lists — the subset of atoms.ts SessionView the picker needs (id +
// title + message count). Structural (not an atoms import) so dialogs.tsx has no atoms coupling and
// a unit/fixture can hand it a plain array.
export type SessionLike = { readonly id: string; readonly title: string; readonly messages: ReadonlyArray<unknown> }

// printableChar(e): a single visible char with no ctrl/meta — the dialog filter's keystroke source.
// Identical rule to chat.tsx's palette `printable` (a printable that isn't a control chord), exported
// so chat.tsx's dispatch tail feeds the OPEN picker's filter through the same gate (no duplicate rule).
export const printableChar = (e: KeyEventLike): string =>
  typeof e.sequence === "string" && e.sequence.length === 1 && e.sequence >= " " && !e.ctrl && !e.meta ? e.sequence : ""

// Which picker is mounted on the shared "dialog" mode. null ⇒ none (the mode isn't a dialog, or it
// was popped). Kept distinct from the mode so chat.tsx can render the RIGHT overlay component. The
// THEME picker is a third kind on the SAME primitive (DialogSelect + the "dialog" mode) — same reuse
// the session/model pickers prove, so /theme costs no new mode + no new key routing.
export type DialogKind = "session" | "model" | "theme" | null

// The controller bundle chat.tsx consumes. `kind` says which overlay to mount; `sessionModel` /
// `modelModel` / `themeModel` are the DialogSelect controllers; `binds` are the "dialog"-mode key
// rows chat.tsx spreads into its registry; `feedChar` appends a printable to the OPEN picker's
// filter; open*/close drive the mode + kind together.
export type Dialogs = {
  readonly kind: DialogKind
  readonly sessionModel: DialogSelectModel<string>
  readonly modelModel: DialogSelectModel<ModelName>
  readonly themeModel: DialogSelectModel<string>
  readonly binds: ReadonlyArray<Bind>
  readonly openSession: () => void
  readonly openModel: () => void
  readonly openTheme: () => void
  readonly close: () => void
  readonly feedChar: (ch: string) => void
}

// useDialogs — owns BOTH picker controllers + the kind + the shared "dialog"-mode key rows.
//   - sessions/activeId build the switcher's options (every session EXCEPT a "current" tag on the
//     active one; selecting one calls onSwitch with its id).
//   - selectedModel marks the currently-selected model row; selecting one calls onModel(name).
//   - mode is the keys.ts ModeStack: open* pushes "dialog", close pops it (idempotent on "dialog").
// The selection submit closes the dialog (mirrors the palette: pick a row → run → close).
// The picker ACTIONS chat.tsx wires in — bundled into one options object so useDialogs stays under
// the param budget (and the call site reads as named intent, not positional callbacks). onSwitch =
// set the active session; onModel = set the composer model; theme = the active name + ordered names
// + the live switch (useThemeSwitcher) the theme picker drives.
export type DialogActions = {
  readonly onSwitch: (id: string) => void
  readonly onModel: (name: ModelName) => void
  readonly theme: { readonly name: string; readonly names: ReadonlyArray<string>; readonly onTheme: (name: string) => void }
}

export const useDialogs = (
  sessions: ReadonlyArray<SessionLike>,
  activeId: string | null,
  selectedModel: string,
  mode: ModeStack,
  actions: DialogActions,
): Dialogs => {
  const { onSwitch, onModel, theme } = actions
  const [kind, setKind] = useState<DialogKind>(null)

  // close() pops the "dialog" mode (idempotent — only pops if "dialog" is on top) AND clears the
  // kind so the overlay unmounts. Both must happen together: popping the mode alone would leave the
  // overlay rendered (chat.tsx mounts on kind), clearing kind alone would strand the mode on the stack.
  const close = useCallback(() => {
    mode.pop("dialog")
    setKind(null)
  }, [mode])

  // SESSION SWITCHER options — every session, the active one tagged "current" (a dimmed description)
  // so the list shows context without a separate header. value = the session id; submit switches +
  // closes. Rebuilt when the session set or the active id changes so titles/the tag stay live.
  const sessionItems: Array<Option<string>> = useMemo(
    () =>
      sessions.map((s) => ({
        title: s.title,
        value: s.id,
        description: s.id === activeId ? "current" : undefined,
        hint: `${s.messages.length} msg`,
      })),
    [sessions, activeId],
  )
  const sessionModel = useDialogSelect(sessionItems, (id) => {
    onSwitch(id)
    close()
  })

  // MODEL PICK options — the fixed two-model pool (kimi default + glm alternate). value = the short
  // ModelName; the currently-selected model is tagged "selected"; the hint shows the CF id so the
  // pick is unambiguous. submit sets the model + closes.
  const modelItems: Array<Option<ModelName>> = useMemo(
    () =>
      (Object.keys(MODELS) as Array<ModelName>).map((name) => {
        const m = MODELS[name]
        return {
          title: m.label,
          value: name,
          description: m.id === selectedModel || name === selectedModel ? "selected" : undefined,
          hint: m.id,
        }
      }),
    [selectedModel],
  )
  const modelModel = useDialogSelect(modelItems, (name) => {
    onModel(name)
    close()
  })

  // THEME PICK options — every registry theme in its ordered list. value = the theme NAME; the
  // currently-active theme is tagged "current"; the hint shows the theme's display label so the row
  // reads clearly. submit switches LIVE + persists (onTheme) + closes. Rebuilt when the active name
  // changes so the "current" mark follows the live switch.
  const themeItems: Array<Option<string>> = useMemo(
    () =>
      theme.names.map((name) => ({
        title: themes[name]?.label ?? name,
        value: name,
        ...(name === theme.name ? { description: "current" } : {}),
        hint: name,
      })),
    [theme.names, theme.name],
  )
  const themeModel = useDialogSelect(themeItems, (name) => {
    theme.onTheme(name)
    close()
  })

  // openSession/openModel/openTheme set the kind, reset that controller's filter to a clean slate
  // (clears the query AND resets the highlight to the first row — the same contract the palette's
  // setQuery("") gives), then push the shared "dialog" mode so its keys scope + the composer yields.
  const openSession = useCallback(() => {
    setKind("session")
    sessionModel.setQuery("")
    mode.push("dialog")
  }, [mode, sessionModel])
  const openModel = useCallback(() => {
    setKind("model")
    modelModel.setQuery("")
    mode.push("dialog")
  }, [mode, modelModel])
  const openTheme = useCallback(() => {
    setKind("theme")
    themeModel.setQuery("")
    mode.push("dialog")
  }, [mode, themeModel])

  // The ACTIVE controller (by kind) — the target of the shared dialog-mode key rows + feedChar. A
  // closed dialog (kind null) has no active controller, so the rows no-op (they only fire under the
  // "dialog" mode anyway, which is only on the stack while a picker is open).
  const active = kind === "session" ? sessionModel : kind === "model" ? modelModel : kind === "theme" ? themeModel : undefined
  const feedChar = (ch: string) => {
    if (ch !== "") active?.appendQuery(ch)
  }

  // The shared "dialog"-mode key rows chat.tsx SPREADS into its registry (so dispatch routes them
  // while a picker is open). Same key set as the palette's rows, but routed to the ACTIVE picker by
  // kind. esc closes (pops the mode + clears kind); ↵ submits the highlighted row (switch / pick);
  // ↑↓ move; home/end jump; ⌫ edits the filter. The duplicate ↓ row is hidden from which-key. They
  // run ONLY in the "dialog" mode, so a base nav key can't fire while a picker is open.
  const binds: Array<Bind> = useMemo(
    () => [
      { mode: "dialog", chord: "escape", keys: "esc", desc: "close", group: "Dialog", run: close },
      { mode: "dialog", chord: "return", keys: "↵", desc: "select", group: "Dialog", run: () => active?.submit() },
      { mode: "dialog", chord: "up", keys: "↑↓", desc: "move", group: "Dialog", run: () => active?.move(-1) },
      { mode: "dialog", chord: "down", keys: "↑↓", desc: "move", group: "Dialog", hidden: true, run: () => active?.move(1) },
      { mode: "dialog", chord: "home", keys: "home", desc: "first", group: "Dialog", run: () => active?.home() },
      { mode: "dialog", chord: "end", keys: "end", desc: "last", group: "Dialog", run: () => active?.end() },
      { mode: "dialog", chord: "backspace", keys: "⌫", desc: "edit filter", group: "Dialog", run: () => active?.backspaceQuery() },
    ],
    [active, close],
  )

  return { kind, sessionModel, modelModel, themeModel, binds, openSession, openModel, openTheme, close, feedChar }
}

// DialogOverlays — mounts the ACTIVE picker overlay (session switcher / model pick / theme pick) by
// kind, or nothing. chat.tsx renders this in BOTH the list and chat views; folding the kind-ternaries
// into one component keeps App's branch count (cyclomatic budget) down and the two call sites
// identical. The palette + which-key overlays stay in chat.tsx (they read chat-only state).
export function DialogOverlays({ dialogs, theme }: { dialogs: Dialogs; theme: ResolvedTheme }) {
  if (dialogs.kind === "session") return <SessionSwitcher model={dialogs.sessionModel} theme={theme} />
  if (dialogs.kind === "model") return <ModelPick model={dialogs.modelModel} theme={theme} />
  if (dialogs.kind === "theme") return <ThemePick model={dialogs.themeModel} theme={theme} />
  return null
}

// SESSION SWITCHER overlay — DialogSelect titled "Switch session" with a switch/nav/close footer.
// A DISTINCT dialog from the palette (different title + footer), on the SAME primitive — the proof
// the picker is reusable, not a one-off. chat.tsx mounts it when dialogs.kind === "session".
export function SessionSwitcher({ model, theme }: { model: DialogSelectModel<string>; theme: ResolvedTheme }) {
  return (
    <DialogSelect
      title="Switch session"
      model={model}
      placeholder="search sessions…"
      footer="↵ switch · ↑↓ select · esc close"
      theme={theme}
    />
  )
}

// MODEL PICK overlay — DialogSelect titled "Pick model" with a pick/nav/close footer. The other
// dialog on the shared primitive; chat.tsx mounts it when dialogs.kind === "model".
export function ModelPick({ model, theme }: { model: DialogSelectModel<ModelName>; theme: ResolvedTheme }) {
  return (
    <DialogSelect
      title="Pick model"
      model={model}
      placeholder="search models…"
      footer="↵ pick · ↑↓ select · esc close"
      theme={theme}
    />
  )
}

// THEME PICK overlay — DialogSelect titled "Pick theme" listing the registry palettes (the current
// one tagged). The third dialog on the shared primitive; chat.tsx mounts it when kind === "theme".
// Selecting a row switches the palette LIVE + persists (the controller's onSelect = themeModel's).
export function ThemePick({ model, theme }: { model: DialogSelectModel<string>; theme: ResolvedTheme }) {
  return (
    <DialogSelect
      title="Pick theme"
      model={model}
      placeholder="search themes…"
      footer="↵ apply · ↑↓ select · esc close"
      theme={theme}
    />
  )
}
