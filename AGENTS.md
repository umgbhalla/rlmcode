# ax2 — multi-session TUI coding agent

Bun + TypeScript. Effect v4 core, opentui (React) UI, real OpenTelemetry → local
`motel`. LLM = Cloudflare Workers AI (`@cf/moonshotai/kimi-k2.7-code`) via `@ax-llm/ax`.

## Files (`src/`)

The tree is split into three layers. The **only** importable module across the layer
boundary is the SDK barrel `src/core/sdk.ts` — `package.json` `"exports"` points `.` at
it, and the `crosscore` analyze rule fails any module *outside* `src/core/` and the
`src/app/` composition layer that deep-imports a non-barrel `src/core/*` module (type-only
imports count). The TUI consumes the engine ONLY through the barrel + the app handle.

### `src/core/` — the engine (Effect-backed, never imported directly except via the barrel)

    sdk.ts       PUBLIC SDK BARREL (≤300 lines, zero logic): createAgent(options) → Agent
                 (runTurn async-gen / abort / closeSession / info) + the serializable public
                 types (TurnEvent, TurnResult, TurnOptions, StopReason, TokenUsage, TurnError,
                 AgentOptions/Info, LogLine) + the AxAIService/AxFunction type re-exports.
                 Effect / Cause / AxMemory / AxSpan / ChatError / OtelTracerProvider NEVER cross it.
    run.ts       makeRunTurn(driver): drives turn() on the app runtime and yields the FLAT
                 serializable TurnEvent stream (terminal {type:'reply'} always last) +
                 normalizes the internal result into the public TurnResult.
    agent.ts     createAgent factory (pure DI: inject AxAIService + model + tools/limits);
                 turn() = Effect.fn span (chat.turn → ax gen_ai); per-turn live logger;
                 budget-exhaustion recovery; abortTurn. Internal readUsage feeds usage.* (ponytail).
    sessions.ts  per-session AxMemory + root span (not serializable → module Map); deleteSession
    activity.ts  internal Activity union + the PER-TURN live-logger factories (makeLiveLogger /
                 makeNodeLogger over a per-turn `emit` closure). No global sink.
    tools.ts     AxFunctions: bash, read_file, write_file, edit_file, glob, grep (unsandboxed).
                 BASE_TOOLS (file/shell) vs CHAT_TOOLS (+ the `workflow` self-orchestration tool)
    orch*.ts     orchestration: node tree, recipes, resilience/retry, cost-meter spans
    workflow*.ts the in-process `workflow` self-orchestration tool + its primitives
    rlm-node.ts  single-level RLM node (distiller→executor) bridged into the node-event tree
    runtime.ts   per-session turn emit/context Map; generic getUsage probe for orch budgeting
    mock-ai.ts   canned AxAIService + mock_orch tool (off in prod; `AX2_MOCK=1`)
    models.ts    model ids + limits
    otel.ts      (`src/otel.ts`) NodeSdk 3-signal → motel; global OTel context; appRuntime

### `src/app/` — composition layer (the only non-core place allowed to deep-import core)

    default-agent.ts  owns defaultAgent + the AX2_MOCK env branch + CF `llm` construction.
                      Exports the app's pre-wired surface: runTurn (= makeRunTurn(defaultAgent)),
                      abortTurn, projectDocLoaded, sessionsRT/deleteSession. This is where env
                      coupling lives — SDK consumers inject their OWN AxAIService instead.

### `src/tui/` — the opentui app (consumes the engine via the barrel + the app handle)

    atoms.ts     app state + session actions; reduces the runTurn TurnEvent stream into appState
                 (incl. node events → OrchTree). Imports the agent surface from src/app and the
                 public types from src/core/sdk.ts — the ONLY ../core/* import is the barrel.
    chat.tsx     opentui UI: session list, collapsible transcript, per-tool views, markdown
    toolui.ts    per-tool label / summary / preview (Claude-Code style) — pure presentation
    orch-tree.ts OrchTree render model; history.ts / clipboard.ts / theme.ts UI helpers

### `examples/` — the SDK regression gate

    sdk-usage.ts  barrel-ONLY headless consumer (imports only ../src/core/sdk.ts + @ax-llm/ax):
                  createAgent over a mock AxAIService, for-await runTurn, assert reply/usage/
                  stopReason. Run via `bun run sdk:smoke` — zero network, the SDK seam regression gate.

## Run

`.env`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Opt: `AX2_MAX_STEPS` (default 50).

    bun run motel        # local motel ingest (127.0.0.1:27686) — NOT npm @kitlangton/motel (broken)
    bun run motel:tui    # motel TUI
    bun run chat         # the agent (src/tui/chat.tsx)
    bun run emit         # headless trace smoke
    bun run sdk:smoke    # barrel-only SDK consumer (examples/sdk-usage.ts) — the SDK seam gate
    bun run lint         # check + test + analyze + debt (run before commit)
    bun run check        # tsc --noEmit + Effect LS (Effect anti-patterns)
    bun run analyze      # yuku semantic design analysis (incl. the crosscore boundary rule)
    bun run debt         # ponytail debt ledger
    bun run test:tui     # HEADLESS TUI GATE — see below (needs the termctrl binary + a PTY)

## Static analysis — what & WHEN to run

| command | what it checks | run it when |
|---|---|---|
| `bun run check` | `tsc` + `@effect/language-service` — types + Effect anti-patterns (floating effects, missing service deps, error-channel bugs) | after **any** edit to `.ts`/`.tsx`, especially Effect code (`core/agent.ts`, `core/run.ts`, `tui/atoms.ts`, `otel.ts`, `core/sessions.ts`). The fast inner loop. |
| `bun run analyze` | `yuku-analyzer` — dead exports, unused imports, circular deps, per-function cyclomatic/nesting/param budgets | after adding/removing exports or modules, or when a function grows branchy. Before committing structural changes. |
| `bun run debt` | `ponytail:` marker ledger — fails on any marker with no `Upgrade:` line | after adding a `ponytail:` shortcut comment; it forces every shortcut to name its upgrade path. |
| `bun run lint` | `check` + `analyze` + `debt` (all of the above) | **before every commit**, and in CI. One gate. Must be green to ship. |

Workflow: edit → `bun run check` (tight loop) → when done → `bun run lint` → commit.
Budgets in `scripts/design-check.ts` (CC 18, nest 5, params 6) are tunable; raise only
with a reason, not to silence a real smell.

## Headless TUI gate (`bun run test:tui`) — the TUI is now headless-testable

The TUI used to be verifiable ONLY by a human running `bun run chat` — every render/focus
bug (stranded input focus, tools under the wrong node, a flat tree, no thinking state)
slipped past `tsc` + yuku because none of them see a *rendered frame*. `bun run test:tui`
closes that gap: it runs `scripts/tui/*.test.ts`, mounting the **real** `chat.tsx` in a
headless pseudo-terminal and asserting against the captured cell-grid text. De-flake standard:
the gate is deterministic (no real timers/network; frame-stable waits) and runs 10/10 green.

- **`scripts/tui/driver.ts`** — mounts `bun src/tui/chat.tsx` under
  [`terminal-control`](https://github.com/kitlangton/terminal-control) (the PTY driver by
  opentui's author; install the `termctrl` binary via `cargo install`, see below)
  with `AX2_MOCK=1`, and exposes `{ frame, type, key, click, waitFor, waitForFrame, stop }`. It
  drives the REAL app boot + input/focus path (not an in-process render tree), so the bugs above
  are catchable. Waits use the frame-stable `waitFor` poll, never `setTimeout`-then-assert.
- **`scripts/tui/*.test.ts`** — `mock` (the deterministic mock unit, no PTY), then `smoke`,
  `focus`, `ime`, `layout`, `node-tree`, `thinking-streaming`, `tool-grouping`,
  `tool-grouping-steps`. Each asserts STABLE structure (the `❯` focus gutter, `├─ └─ │`
  connectors, the Σ footer, `✗` error cards) over captured frames — not a byte-exact golden
  (the spinner glyph cycles). They run SEQUENTIALLY (`&&`) so PTY mounts never overlap.
- **Mock layer** (`src/core/mock-ai.ts` + `src/core/mock.ts`, off in prod behind `AX2_MOCK=1`):
  a canned `AxAIService` (zero network) drives the REAL turn loop; a `mock_orch` tool replays
  canned NodeEvents + a per-node tool cluster through the REAL per-turn activity bus so the orch
  tree renders from fixed data. `agent.ts` reads the seam ONCE; unset ⇒ the unchanged CF path.
  The activity bus is PER-TURN (`run.ts` threads each turn's `emit` into `turn()`); under
  `AX2_MOCK` `setMockEmit(emit)` points the mock's group-variant tool-CALL feed at that sink.

### How to add a TUI test

1. Add `scripts/tui/<name>.test.ts`. Import `launchDriver` from `./driver.ts` and `report`
   from `./assert.ts`; wrap the body in `await report("<name>.test", async (a) => { … })`.
2. `const d = await launchDriver()` (optionally `{ cols, rows, env }`); always `await d.stop()`
   in a `finally`. Drive the app with `d.type(text)`, `d.key("Enter"|"Tab"|"Escape"|"Arrow…",
   { shift })`, `d.click(x, y)`.
3. Gate every assertion on a FRAME-STABLE wait — `const f = await d.waitFor(pred, { label })`
   (or `d.waitForFrame(pred, deadlineMs)`) — NEVER `setTimeout`-then-assert. Assert with
   `a.has(f, needle, msg)` / `a.hasNot(...)` over the captured text. Match STABLE structure
   (connectors, labels, the Σ footer), not a byte-exact grid (the spinner cycles).
4. To exercise an orchestration tree or a tool cluster, send a message the mock routes on:
   `"orchestrate …"` (→ `mock_orch` replays the canned node feed) or `"explore …"` (→ the
   read/glob/grep group). Keep new fixtures in `src/core/mock.ts` / `mock-ai.ts`, SMALL.
5. Register the new file in the single `test:tui` `&&` chain in `package.json` (sequential,
   the mock unit first) — that is the only place to wire it.

SEPARATE from `bun run lint`: the frame portion of `test:tui` needs the `termctrl` native
binary on PATH (`cargo install --git https://github.com/kitlangton/terminal-control
terminal-control`, or set `TERMCTRL_BINARY`) and a real PTY, which bare CI may lack — so the
full `test:tui` is its own gate, run locally / in a PTY-capable runner before shipping TUI
changes. The deterministic mock UNIT (`scripts/tui/mock.test.ts`, zero PTY) is the part `lint`
keeps in its `test` target, so `bun run lint` stays green on a bare CI box.

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
exempt. `src/chat.tsx` is grandfathered; new files must stay under
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
