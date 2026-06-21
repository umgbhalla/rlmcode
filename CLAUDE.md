# CLAUDE.md — ax2 (`ax2-loop-agent`)

Multi-turn TUI chat agent. **Bun + TypeScript + React 19**, Effect v4 core,
opentui inline UI, real OpenTelemetry spans exported to local `motel`.
LLM = Cloudflare Workers AI (`@cf/moonshotai/kimi-k2.7-code`) via `@ax-llm/ax`.

## What this is

`turn(message): Effect<string>` loop agent. Each turn = a traced
`chat.turn → ax.forward` span (`gen_ai.*` attributes, service `ax2-chat`).
UI bound to Effect through `@effect/atom-react` atoms. No direct
Anthropic/OpenAI SDK — all LLM calls go through `@ax-llm/ax`.

## Local source deps — checked out in hub root (`../`)

This repo references **local clones**, not just npm. They live as sibling
dirs in the hub root (`/Users/umang/hub`, i.e. `./` parent). Read THESE for
source-of-truth when debugging betas:

| Dep            | Local path        | What / why local                                                  |
|----------------|-------------------|-------------------------------------------------------------------|
| `effect`       | `../effect-smol`  | Effect v4 (`4.0.0-beta.85`) source — `Effect.withSpan`, `Atom.runtime`. Pre-release, API churns. |
| `@opentui/*`   | `../opentui`      | Terminal UI core + React renderer (`0.4.1`). Native FFI per-platform. |
| `motel`        | `../motel`        | Local OTLP/HTTP ingest + SQLite + TUI viewer. **Run from here**, NOT npm. |
| `@ax-llm/ax`   | `../ax`           | Ax = DSPy for TS. Signatures/forward. LLM brain (`22.x`).         |

`bun run motel` / `motel:tui` invoke `../motel` via `--cwd`. Do NOT
`bun add -g @kitlangton/motel` (npm 0.1.0 broken vs current betas:
duplicate React → `resolveDispatcher().useState` null, stale
`Service.asEffect()` → 500 on `/v1/traces`). Local `../motel` pins
compatible `effect@4.0.0-beta.49`.

## Full dependency surface (`package.json`)

**Core / runtime**
- `@ax-llm/ax` ^22.0.5 — LLM framework → CF Workers AI
- `effect` 4.0.0-beta.85 — runtime
- `@effect/atom-react` 4.0.0-beta.85 — atoms = the UI's Effect interface
- `@effect/opentelemetry` 4.0.0-beta.85 — `NodeSdk` tracing bridge

**TUI / UI**
- `@opentui/core` ^0.4.1, `@opentui/react` ^0.4.1 — terminal UI (`screenMode: main-screen`, inline)
- `react` ^19.2.7

**OpenTelemetry** (OTLP/HTTP → motel)
- `@opentelemetry/api` ^1.9.1
- sdk: `sdk-trace-base`, `sdk-trace-node`, `sdk-metrics` ^2.8.0, `sdk-logs` ^0.219.0
- exporters: `exporter-trace-otlp-http`, `exporter-metrics-otlp-http`, `exporter-logs-otlp-http` ^0.219.0
- `resources` ^2.8.0, `context-async-hooks` ^2.8.0

**Tooling (dev)**
- Bun (runner, `--env-file=.env`), `typescript` ^6, `tsx` ^4
- `@types/bun`, `@types/node` ^26, `@types/react` ^19

## Source files (`src/`)

    otel.ts      TracingLive (NodeSdk → OTLP → motel) + appRuntime (Atom.runtime)
    agent.ts     ax/CF Kimi setup + turn(message): Effect<string>; spans chat.turn → ax.forward
    atoms.ts     messagesAtom, busyAtom, sendAtom (appRuntime.fn, traced)
    chat.tsx     opentui App + RegistryProvider, inline render
    tools.ts     tool defs
    toolui.ts    tool render in TUI
    activity.ts  activity log
    sessions.ts  session state
    smoke-emit.ts  headless: emit 2 traced turns (no UI)

## Run

`.env` needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

```bash
bun run motel        # start LOCAL motel (ingest+API @ 127.0.0.1:27686)
bun run motel:tui    # ... or visual TUI
bun run chat         # chat: Enter sends, Esc quits
bun run emit         # headless trace smoke (no UI)
bun run check        # tsc --noEmit
```

## Conventions

- Effect v4 betas + opentui betas churn — when types break, read the local
  source (`../effect-smol`, `../opentui`), not npm docs.
- Keep one React copy. Duplicate React = `useState` null crash.
- Every turn must stay traced (`Effect.withSpan`) — motel is the debug surface.
