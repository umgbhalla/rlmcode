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
    bun run lint         # check + analyze + debt (run before commit)
    bun run check        # tsc --noEmit + Effect LS (Effect anti-patterns)
    bun run analyze      # yuku semantic design analysis
    bun run debt         # ponytail debt ledger

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
