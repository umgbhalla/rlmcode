# ax2 — multi-session TUI coding agent

Bun + TypeScript. Effect v4 core, opentui (React) UI, real OpenTelemetry → local
`motel`. LLM = Cloudflare Workers AI (`@cf/moonshotai/kimi-k2.7-code`) via `@ax-llm/ax`.

## Files (`src/`)

    otel.ts      NodeSdk 3-signal (traces/logs/metrics) → motel; global OTel
                 context manager; re-surfaced tracer provider; appRuntime (Atom.runtime)
    agent.ts     ax + tools; turn() = Effect.fn span (chat.turn → ax gen_ai);
                 native logger → activity bus; budget-exhaustion recovery; AGENTS/CLAUDE.md load
    tools.ts     AxFunctions: bash, read_file, write_file, edit_file, glob, grep (unsandboxed)
    toolui.ts    per-tool label / summary / preview (Claude-Code style)
    activity.ts  live activity bus (ax logger → UI)
    atoms.ts     app state + session actions (appRuntime.fn); Msg = you | agent | tool
    sessions.ts  per-session AxMemory + root span (not serializable → module Map)
    chat.tsx     opentui UI: session list, collapsible transcript, per-tool views, markdown

## Run

`.env`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Opt: `AX2_MAX_STEPS` (default 50).

    bun run motel        # local motel ingest (127.0.0.1:27686) — NOT npm @kitlangton/motel (broken)
    bun run motel:tui    # motel TUI
    bun run chat         # the agent
    bun run emit         # headless trace smoke
    bun run lint         # check + analyze + debt + test (run before commit)
    bun run check        # tsc --noEmit + Effect LS (Effect anti-patterns)
    bun run analyze      # yuku semantic design analysis
    bun run debt         # ponytail debt ledger
    bun run test:tui:frame  # HEADLESS FRAME GATE — see below (needs the termctrl binary + a PTY)

## Static analysis — what & WHEN to run

| command | what it checks | run it when |
|---|---|---|
| `bun run check` | `tsc` + `@effect/language-service` — types + Effect anti-patterns (floating effects, missing service deps, error-channel bugs) | after **any** edit to `.ts`/`.tsx`, especially Effect code (`agent.ts`, `atoms.ts`, `otel.ts`, `sessions.ts`). The fast inner loop. |
| `bun run analyze` | `yuku-analyzer` — dead exports, unused imports, circular deps, per-function cyclomatic/nesting/param budgets | after adding/removing exports or modules, or when a function grows branchy. Before committing structural changes. |
| `bun run debt` | `ponytail:` marker ledger — fails on any marker with no `Upgrade:` line | after adding a `ponytail:` shortcut comment; it forces every shortcut to name its upgrade path. |
| `bun run lint` | `check` + `analyze` + `debt` (all of the above) | **before every commit**, and in CI. One gate. Must be green to ship. |

Workflow: edit → `bun run check` (tight loop) → when done → `bun run lint` → commit.
Budgets in `scripts/design-check.ts` (CC 18, nest 5, params 6) are tunable; raise only
with a reason, not to silence a real smell.

## Headless TUI frame gate (`bun run test:tui:frame`)

The TUI used to be verifiable ONLY by a human running `bun run chat` — every render/focus
bug (stranded input focus, tools under the wrong node, a flat tree, no thinking state)
slipped past `tsc` + yuku + the headless `test:tui` because none of them see a *rendered
frame*. `scripts/tui/` closes that gap by mounting the **real** `chat.tsx` in a headless
pseudo-terminal and asserting against the captured cell-grid text.

- **`scripts/tui/driver.ts`** — mounts `bun src/chat.tsx` under
  [`terminal-control`](vendor/terminal-control) (the vendored PTY driver by opentui's author)
  with `AX2_MOCK=1`, and exposes `{ frame, type, key, click, waitFor, stop }`. It drives the
  REAL app boot + input/focus path (not an in-process render tree), so the bugs above are
  catchable. Waits use the frame-stable `waitFor` poll, never `setTimeout`-then-assert.
- **`scripts/tui/*.test.ts`** — focus, node-tree, thinking-streaming, tool-grouping. Each
  asserts STABLE structure (the `❯` focus gutter, `├─ └─ │` connectors, the Σ footer, `✗`
  error cards) over captured frames — not a byte-exact golden (the spinner glyph cycles).
- **Mock layer** (`src/mock-ai.ts` + `src/mock.ts`, off in prod behind `AX2_MOCK=1`): a canned
  `AxAIService` (zero network) drives the REAL turn loop; a `mock_orch` tool replays canned
  NodeEvents + a per-node tool cluster through the REAL activity bus so the orch tree renders
  from fixed data. `runtime.ts`/`agent.ts` read the seam ONCE; unset ⇒ the unchanged CF path.
- **Streaming is NOT wired** (`streaming:false`): the thinking/streaming test pins the CURRENT
  non-streaming render and carries a `TODO` that flips to a delta-by-delta assertion once
  `stream:true` lands. It does not fake streaming.

SEPARATE from `bun run lint`: the frame gate needs the `termctrl` native binary on PATH
(`cargo install --git https://github.com/kitlangton/terminal-control terminal-control`, or set
`TERMCTRL_BINARY`) and a real PTY, which bare CI may lack — so it is its own
`test:tui:frame` gate, run locally / in a PTY-capable runner before shipping TUI changes. The
deterministic mock UNIT (`test:tui` → `scripts/tui/mock.test.ts`) stays in `lint`.

## tsconfig discipline

Strict flags are non-negotiable: `strict`, `noUnusedLocals`,
`noUnusedParameters`, `exactOptionalPropertyTypes`. Do not relax them to silence
errors; fix the underlying type or add an explicit, locally justified assertion.

## File-size budget

File-size budget is **conditioned on role**: a top-level **index/barrel** (a public
re-export surface — `index.ts`/`sdk.ts`, mostly `export … from`) stays tight at **300**
lines so the public API can't sprawl; an **internal implementation** file gets **500**.
Nesting depth budget is **8**. If a file approaches its budget, split by concern (types,
pure helpers, effects, UI) rather than growing it. Tests and auto-generated files are
exempt. `src/chat.tsx` and `build-viz.ts` are grandfathered; new files must stay under
the budget.

## Extended ponytail scan

`bun run debt` scans `src/` and `scripts/` for `ponytail:` markers. Every
marker must include an `Upgrade:` line describing the exit strategy. Markers
without one fail the lint gate.

## Architectural shortcuts and boundaries

Any shortcut, boundary, or "temporary" architectural decision must reference
either an ADR in `docs/adr/` or a named test that documents the intended
behavior. If neither exists, write the ADR or test before committing the
shortcut.

## Effect best practices

Before writing Effect code, consult `../effect-solutions/packages/website/docs`
(project-setup, tsconfig, services-and-layers, error-handling). Real impls +
types: `../effect-smol`. Don't guess Effect patterns — check the source.

## Notes

- Local source deps live in hub root (`../`): `effect-smol`, `opentui`, `motel`, `ax`.
  Read those when beta types break — not npm docs.
- One trace per session: `chat.session → chat.turn → ax gen_ai (→ Tool: …)`.
- Non-streaming inference, step-by-step UI. Tool payload is append-only multi-turn
  (distinct roles + structured `tool_calls`/`tool_call_id`), cache-friendly.
- Deliberate shortcuts marked `ponytail:` (ceiling + upgrade). `grep -rn 'ponytail:' src`.
