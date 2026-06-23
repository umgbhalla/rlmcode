// THEME PERSIST — a tiny, lazy config read/write for the selected theme name. Mirrors history.ts:
// a plain JSON file in the cwd (per-project), sync fs so chat.tsx can read the initial theme at
// module init with no await, a single best-effort write on a pick. ONE key today (`theme`), shaped
// open so a future setting can join without a schema migration.
//
// RESOLUTION ORDER (the picker's default): env RLM_THEME ?? persisted config ?? DEFAULT_THEME. env
// wins so a one-off `RLM_THEME=gruvbox bun run chat` overrides the saved pick without rewriting it;
// the persisted name is the durable choice; the registry default is the floor.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { DEFAULT_THEME, themes } from "./theme.ts"

const FILE = ".rlmcode.json"

// A known theme name, or undefined — never returns an UNKNOWN string (a stale name in the file or
// a typo'd env can't leak past here; resolveTheme would fall back anyway, but this keeps the picker's
// "current" mark honest). Pure validation against the live registry.
const known = (name: string | undefined): string | undefined =>
  name !== undefined && Object.prototype.hasOwnProperty.call(themes, name) ? name : undefined

// readConfig(): parse the lazy config file's `theme` key (best-effort — a missing/corrupt file ⇒
// undefined). Sync; called once at module init by the resolver below.
const readConfig = (): { theme?: string } => {
  try {
    if (!existsSync(FILE)) return {}
    const o = JSON.parse(readFileSync(FILE, "utf8"))
    return o && typeof o === "object" ? (o as { theme?: string }) : {}
  } catch {
    return {}
  }
}

// initialThemeName(): the theme to boot with — env RLM_THEME, else the persisted name, else the
// registry default. Each candidate is validated against the registry so only a real theme is
// returned. Pure-ish (reads env + the file once); chat.tsx calls it at module init.
export const initialThemeName = (): string =>
  known(process.env.RLM_THEME) ?? known(readConfig().theme) ?? DEFAULT_THEME

// persistThemeName(name): write the chosen theme back to the config file's `theme` key, preserving
// any other keys already there. Best-effort (a write failure is swallowed — the live switch already
// happened; persistence is a nicety, not a hard requirement). Only persists a KNOWN name.
export const persistThemeName = (name: string): void => {
  if (known(name) === undefined) return
  try {
    const cur = readConfig()
    writeFileSync(FILE, `${JSON.stringify({ ...cur, theme: name }, null, 2)}\n`)
  } catch {
    /* best-effort persistence — the live switch already took effect */
  }
}
