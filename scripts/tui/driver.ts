// HEADLESS TUI DRIVER — the real-frame test gate for chat.tsx.
//
// WHY a subprocess PTY (not opentui's in-process TestRenderer): the bugs this gate exists to
// catch (stranded input focus, tools rendering under the wrong node, a flat tree, missing
// thinking state) are bugs of the REAL app — its createCliRenderer + createRoot mount, its
// useKeyboard/useFocus wiring, the atoms orchestration loop. TestRenderer renders a tree you
// hand it; it would NOT exercise `bun run chat`'s actual boot + input path. terminal-control
// (@kitlangton/terminal-control — same author as opentui + motel) drives the REAL app through
// a real pseudo-terminal, captures the rendered cell grid as text, and injects typed text /
// named keys / raw bytes (mouse) — exactly the surface this gate needs. The `--host opentui`
// launch flag is built for this. We confirmed a trivial render+capture boots before building
// on it (RLM_MOCK=1 + the lazy-llm seam let chat.tsx mount with NO Cloudflare env).
//
// DETERMINISM: every test mounts with RLM_MOCK=1 — the canned mock AI (mock-ai.ts, zero
// network) drives the REAL turn loop; the mock orch tool (mock.ts) replays canned NodeEvents
// through the REAL activity bus. No timers, no network. Waits use terminal-control's
// frame-stable predicate poll (waitFor over captured text), never setTimeout-then-assert.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TerminalControl, type Session, type Key } from "@kitlangton/terminal-control"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..")
const CHAT = join(REPO, "src", "tui", "chat.tsx")

// The cargo-installed termctrl binary (the native npm packages aren't vendored). Honor an
// explicit override; otherwise the standard `cargo install` location.
const BINARY = process.env.TERMCTRL_BINARY ?? join(process.env.HOME ?? "", ".cargo", "bin", "termctrl")

export type Mods = { readonly shift?: boolean }

export type Driver = {
  /** Current rendered terminal frame as text (the visible cell grid, rows joined by \n). */
  frame(): Promise<string>
  /**
   * Type literal text into the focused widget (no trailing Enter). Into an empty composer
   * (placeholder showing) this self-heals the mount/focus-flap race by re-sending until the
   * keystrokes land — frame-stable, no fixed sleep; see the implementation note. Elsewhere
   * (overlays, list-nav) it sends exactly once.
   */
  type(text: string): Promise<void>
  /** Press a named key: "Enter" | "Tab" | "Escape" | "ArrowUp" | … (+ optional shift). */
  key(name: NamedKey, mods?: Mods): Promise<void>
  /** Press Ctrl+<letter> (the raw control byte) — e.g. ctrl("k") opens the command palette. */
  ctrl(letter: string): Promise<void>
  /** Left-click at cell (x, y) — 0-based — via a raw SGR mouse down+up byte sequence. */
  click(x: number, y: number): Promise<void>
  /** Poll the frame until `predicate(frame)` holds (frame-stable wait, no fixed sleeps). */
  waitFor(predicate: (frame: string) => boolean, opts?: { timeoutMs?: number; label?: string }): Promise<string>
  /**
   * SPEC alias of `waitFor` with the (predicate, deadlineMs) positional signature — a
   * frame-stable wait that resolves the first captured frame for which `predicate` holds
   * (NOT setTimeout-then-assert). `deadlineMs` is the max wall-clock to wait before throwing.
   */
  waitForFrame(predicate: (frame: string) => boolean, deadlineMs?: number): Promise<string>
  /** Tear the session + driver down. */
  stop(): Promise<void>
}

export type NamedKey = "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Backspace"

const named = (name: NamedKey, mods?: Mods): Key => {
  if (name === "Tab" && mods?.shift) return "Shift+Tab"
  return name as Key
}

// The COMPOSER is the live, empty input target only when its placeholder shows AND no overlay
// (palette / dialog / autocomplete) floats over it capturing keystrokes. An overlay does NOT
// clear the placeholder beneath it, so the placeholder alone is not enough — these markers
// distinguish the cases. Used by `type` to scope its first-type-race self-heal to the composer.
const composerIsLiveEmptyInput = (f: string): boolean =>
  /message kimi/.test(f) && !/Commands|Pick |Switch model|@ files|Pick theme/.test(f)

// SGR mouse byte sequence (opentui reads 1006 SGR mouse mode, which chat.tsx enables).
// down = ESC[<0;X;YM, up = ESC[<0;X;Ym, coords 1-based (so x+1/y+1 from 0-based cells).
const sgr = (x: number, y: number, press: boolean): Uint8Array =>
  new TextEncoder().encode(`\x1b[<0;${x + 1};${y + 1}${press ? "M" : "m"}`)

export type LaunchDriverOptions = {
  readonly cols?: number
  readonly rows?: number
  /** Extra env for the launched chat.tsx (RLM_MOCK=1 is always set). */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Alternate entry to mount instead of chat.tsx — an absolute path to a `bun`-runnable file
   * that boots its own createRoot/render. Used by the ui-atoms frame gate to mount a tiny
   * fixture (a Row + Spinner) through the REAL renderer without launching the full app.
   */
  readonly entry?: string
}

// Mount chat.tsx headlessly under terminal-control with the mock AI wired in, and return the
// reusable driver. `inheritEnv: false` keeps the app env hermetic (only RLM_MOCK + our extras
// + a minimal PATH/HOME for bun), so a developer's real CLOUDFLARE_* never leaks into a test.
export const launchDriver = async (opts: LaunchDriverOptions = {}): Promise<Driver> => {
  const cols = opts.cols ?? 100
  const rows = opts.rows ?? 30
  const tc = await TerminalControl.make({ binaryPath: BINARY })
  const session: Session = await tc.launch({
    command: ["bun", opts.entry ?? CHAT],
    host: "opentui",
    viewport: { cols, rows },
    inheritEnv: false,
    env: {
      RLM_MOCK: "1",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "xterm-256color",
      ...opts.env,
    },
  })

  // Capture the current frame WITHOUT throwing on an unsettled grid (allowIncomplete) — a
  // probe read, not a stability wait; callers gate on content via waitFor.
  const frame = (): Promise<string> =>
    session.screen.capture({ allowIncomplete: true, settleMs: 0, deadlineMs: 0 }).then((c) => c.text)

  const waitFor: Driver["waitFor"] = async (predicate, o = {}) => {
    const snap = await session.screen.waitUntil((s) => predicate(s.text), { timeoutMs: o.timeoutMs ?? 8000 }).catch((e) => {
      throw new Error(`waitFor(${o.label ?? "predicate"}) timed out`, { cause: e })
    })
    return snap.text
  }

  // The composer gains focus in a useEffect that runs (and re-runs, via its blur→reclaim loop)
  // a tick or more AFTER its placeholder first paints — so a `type()` fired the instant the
  // placeholder is visible can land while the textarea is momentarily un-focused and be silently
  // dropped, ALL-OR-NOTHING (a real mount/focus-flap race — composer.tsx useComposerFocus). The
  // fix is frame-stable, NOT a fixed sleep: while the COMPOSER is the live empty input (its
  // placeholder showing AND no overlay is capturing input), re-send the keystrokes and frame-wait
  // for the placeholder to disappear (= the text landed). The drop is all-or-nothing, so a clean
  // retry never double-types. The overlay guard is critical: an open palette/dialog/autocomplete
  // FLOATS OVER the composer so its placeholder is still on the grid, but keystrokes route to the
  // overlay (which never clears the placeholder) — so without it the retry would spam the overlay
  // up to the cap. Excluding the overlay markers (and list-nav, where no placeholder shows) means
  // this fires ONLY for the racy first composer type; settled composer ⇒ exactly one send.
  const typeText: Driver["type"] = async (text) => {
    if (!composerIsLiveEmptyInput(await frame())) {
      await session.keyboard.type(text)
      return
    }
    for (let i = 0; i < 15 && composerIsLiveEmptyInput(await frame()); i++) {
      await session.keyboard.type(text)
      await session.screen.waitUntil((s) => !composerIsLiveEmptyInput(s.text), { timeoutMs: 400 }).catch(() => {})
    }
  }

  return {
    frame,
    type: typeText,
    key: (name, mods) => session.keyboard.press(named(name, mods)),
    // Ctrl+<letter> as the raw control byte the terminal sends (Ctrl+A=1 … Ctrl+K=0x0B …),
    // i.e. (uppercase code) & 0x1f. opentui's input parser decodes it back to {ctrl, name}.
    // Lets the frame gate drive ⌘K (the command palette) which `key`/`named` can't express.
    ctrl: (letter: string) => session.keyboard.write(new Uint8Array([letter.toUpperCase().charCodeAt(0) & 0x1f])),
    click: async (x, y) => {
      await session.keyboard.write(sgr(x, y, true))
      await session.keyboard.write(sgr(x, y, false))
    },
    waitFor,
    waitForFrame: (predicate, deadlineMs) => waitFor(predicate, { timeoutMs: deadlineMs, label: "frame" }),
    stop: async () => {
      await session.stop().catch(() => {})
      await tc.close().catch(() => {})
    },
  }
}
