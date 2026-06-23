// THEME CONTEXT — the React reactivity seam over the live palette (theme.ts). The picker switches
// the theme LIVE in two coordinated moves:
//   1. setActiveTheme(name) mutates the module-level `theme` object IN PLACE (theme.ts), so the PURE
//      helpers (toolui/orch-tree/messages/header/workflow) that `import { theme }` see the new
//      palette on the next render WITHOUT a hook.
//   2. this context bumps React state (the active name), so every component UNDER <ThemeProvider>
//      actually RE-RENDERS (and re-reads the now-mutated palette via useTheme() or the live `theme`).
// Both must fire together: (1) alone wouldn't repaint (no re-render); (2) alone wouldn't update the
// hookless pure helpers. The switch also PERSISTS the choice (theme-config.ts) so it survives a restart.
//
// Ported from termcast's theme store (useStore + a provider) Solid→React: a createContext + a
// useState-backed provider, useTheme() reads the active palette, useThemeSwitcher() returns the
// switch fn + the current name + the ordered name list for the picker. opencode's theme is global +
// reactive the same way (its ThemeProvider over a signal); this is that, React-flavored.
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"
import { getActiveThemeName, getTheme, type ResolvedTheme, setActiveTheme, theme, type Theme, THEME_NAMES } from "./theme.ts"
import { initialThemeName, persistThemeName } from "./theme-config.ts"

// The context value: the active palette (what useTheme returns), the active NAME (the picker's
// "current" mark + the syntax-style rebuild key), and switch() — the single action that does all
// three moves (live mutate + state bump + persist). The ordered name list rides along so the picker
// reads it from the hook (no separate import at the call site).
export type ThemeContextValue = {
  readonly palette: ResolvedTheme
  readonly name: string
  readonly names: ReadonlyArray<string>
  readonly switch: (name: string) => void
}

// A defined default so a component that reads the context OUTSIDE a provider (shouldn't happen — the
// app root wraps everything) still gets the live palette via getTheme() (the non-component accessor)
// + a switch that at least mutates the module state. Keeps useTheme()'s return non-undefined without
// a runtime guard at every call site.
const fallback: ThemeContextValue = {
  palette: getTheme(),
  name: getActiveThemeName(),
  names: THEME_NAMES,
  switch: (name) => void setActiveTheme(name),
}

const ThemeContext = createContext<ThemeContextValue>(fallback)

// THEME PROVIDER — owns the active-name state, seeds it from initialThemeName() (env RLM_THEME ??
// persisted ?? default), and applies that initial choice to the LIVE palette at construction so the
// first paint already uses the right theme (the module default is rlmcode-dark; a persisted gruvbox
// must take effect before the first render, not after a state tick). switch() bumps the name (→
// re-render), mutates the live palette, and persists. Wrap the app root in this.
export function ThemeProvider({ children }: { children: ReactNode }) {
  // useState initializer runs ONCE: resolve the boot theme + apply it to the live palette so the
  // very first render reads the correct colors (setActiveTheme is idempotent on the default).
  const [name, setName] = useState<string>(() => {
    const initial = initialThemeName()
    setActiveTheme(initial)
    return getActiveThemeName() // the resolved/validated name (an unknown initial fell back to default)
  })

  const switchTheme = useCallback((next: string) => {
    const applied = setActiveTheme(next) // 1. mutate the live palette in place (pure helpers repaint)
    setName(applied.name) // 2. bump state so every component under the provider re-renders
    persistThemeName(applied.name) // 3. persist the durable choice (best-effort)
  }, [])

  // The value re-derives when `name` changes (a switch) — `palette` is the live `theme` object (its
  // keys were just mutated), read fresh each render so useTheme() consumers get the new colors.
  const value = useMemo<ThemeContextValue>(
    () => ({ palette: theme, name, names: THEME_NAMES, switch: switchTheme }),
    [name, switchTheme],
  )
  return <ThemeContext value={value}>{children}</ThemeContext>
}

// useTheme(): the active palette — the React-component accessor (components read `const t =
// useTheme()`). Re-renders when the theme switches (the provider bumps its value). Pure helpers
// outside React read getTheme()/the live `theme` instead.
export const useTheme = (): ResolvedTheme => useContext(ThemeContext).palette

// useThemeSwitcher(): the picker's hook — the switch action + the current name + the ordered name
// list (with each theme's display label for the picker rows). One call gives the picker everything.
export const useThemeSwitcher = (): {
  readonly name: string
  readonly names: ReadonlyArray<string>
  readonly switch: (name: string) => void
} => {
  const { name, names, switch: sw } = useContext(ThemeContext)
  return { name, names, switch: sw }
}

// re-export Theme so a picker/dialog can type its rows without reaching into theme.ts directly.
export type { Theme }
