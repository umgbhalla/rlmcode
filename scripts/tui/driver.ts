// HEADLESS TUI DRIVER — the real-frame test gate for chat.tsx.
//
// WHY a subprocess PTY (not opentui's in-process TestRenderer): the bugs this gate exists to
// catch (stranded input focus, tools rendering under the wrong node, a flat tree, missing
// thinking state) are bugs of the REAL app — its createCliRenderer + createRoot mount, its
// useKeyboard/useFocus wiring, the atoms orchestration loop. TestRenderer renders a tree you
// hand it; it would NOT exercise `bun run chat`'s actual boot + input path. terminal-control
// (vendor/terminal-control — same author as opentui + motel) drives the REAL app through a
// real pseudo-terminal, captures the rendered cell grid as text, and injects typed text /
// named keys / raw bytes (mouse) — exactly the surface this gate needs. The `--host opentui`
// launch flag is built for this. We confirmed a trivial render+capture boots before building
// on it (AX2_MOCK=1 + the lazy-llm seam let chat.tsx mount with NO Cloudflare env).
//
// DETERMINISM: every test mounts with AX2_MOCK=1 — the canned mock AI (mock-ai.ts, zero
// network) drives the REAL turn loop; the mock orch tool (mock.ts) replays canned NodeEvents
// through the REAL activity bus. No timers, no network. Waits use terminal-control's
// frame-stable predicate poll (waitFor over captured text), never setTimeout-then-assert.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TerminalControl, type Session, type Key } from "../../vendor/terminal-control/packages/test/src/index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..")
const CHAT = join(REPO, "src", "chat.tsx")

// The cargo-installed termctrl binary (the native npm packages aren't vendored). Honor an
// explicit override; otherwise the standard `cargo install` location.
const BINARY = process.env.TERMCTRL_BINARY ?? join(process.env.HOME ?? "", ".cargo", "bin", "termctrl")

export type Mods = { readonly shift?: boolean }

export type Driver = {
  /** Current rendered terminal frame as text (the visible cell grid, rows joined by \n). */
  frame(): Promise<string>
  /** Type literal text into the focused widget (no trailing Enter). */
  type(text: string): Promise<void>
  /** Press a named key: "Enter" | "Tab" | "Escape" | "ArrowUp" | … (+ optional shift). */
  key(name: NamedKey, mods?: Mods): Promise<void>
  /** Left-click at cell (x, y) — 0-based — via a raw SGR mouse down+up byte sequence. */
  click(x: number, y: number): Promise<void>
  /** Poll the frame until `predicate(frame)` holds (frame-stable wait, no fixed sleeps). */
  waitFor(predicate: (frame: string) => boolean, opts?: { timeoutMs?: number; label?: string }): Promise<string>
  /** Tear the session + driver down. */
  stop(): Promise<void>
}

export type NamedKey = "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Backspace"

const named = (name: NamedKey, mods?: Mods): Key => {
  if (name === "Tab" && mods?.shift) return "Shift+Tab"
  return name as Key
}

// SGR mouse byte sequence (opentui reads 1006 SGR mouse mode, which chat.tsx enables).
// down = ESC[<0;X;YM, up = ESC[<0;X;Ym, coords 1-based (so x+1/y+1 from 0-based cells).
const sgr = (x: number, y: number, press: boolean): Uint8Array =>
  new TextEncoder().encode(`\x1b[<0;${x + 1};${y + 1}${press ? "M" : "m"}`)

export type LaunchDriverOptions = {
  readonly cols?: number
  readonly rows?: number
  /** Extra env for the launched chat.tsx (AX2_MOCK=1 is always set). */
  readonly env?: Readonly<Record<string, string>>
}

// Mount chat.tsx headlessly under terminal-control with the mock AI wired in, and return the
// reusable driver. `inheritEnv: false` keeps the app env hermetic (only AX2_MOCK + our extras
// + a minimal PATH/HOME for bun), so a developer's real CLOUDFLARE_* never leaks into a test.
export const launchDriver = async (opts: LaunchDriverOptions = {}): Promise<Driver> => {
  const cols = opts.cols ?? 100
  const rows = opts.rows ?? 30
  const tc = await TerminalControl.make({ binaryPath: BINARY })
  const session: Session = await tc.launch({
    command: ["bun", CHAT],
    host: "opentui",
    viewport: { cols, rows },
    inheritEnv: false,
    env: {
      AX2_MOCK: "1",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "xterm-256color",
      ...opts.env,
    },
  })

  const frame = (): Promise<string> => session.screen.text({ settleMs: 0, deadlineMs: 0 } as never).catch(() => session.screen.capture({ allowIncomplete: true, settleMs: 0, deadlineMs: 0 }).then((c) => c.text))

  const waitFor: Driver["waitFor"] = async (predicate, o = {}) => {
    const snap = await session.screen.waitUntil((s) => predicate(s.text), { timeoutMs: o.timeoutMs ?? 8000 }).catch((e) => {
      throw new Error(`waitFor(${o.label ?? "predicate"}) timed out`, { cause: e })
    })
    return snap.text
  }

  return {
    frame,
    type: (text) => session.keyboard.type(text),
    key: (name, mods) => session.keyboard.press(named(name, mods)),
    click: async (x, y) => {
      await session.keyboard.write(sgr(x, y, true))
      await session.keyboard.write(sgr(x, y, false))
    },
    waitFor,
    stop: async () => {
      await session.stop().catch(() => {})
      await tc.close().catch(() => {})
    },
  }
}
