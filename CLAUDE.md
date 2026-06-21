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
    bun run check        # tsc --noEmit

## Notes

- Local source deps live in hub root (`../`): `effect-smol`, `opentui`, `motel`, `ax`.
  Read those when beta types break — not npm docs.
- One trace per session: `chat.session → chat.turn → ax gen_ai (→ Tool: …)`.
- Non-streaming inference, step-by-step UI. Tool payload is append-only multi-turn
  (distinct roles + structured `tool_calls`/`tool_call_id`), cache-friendly.
- Deliberate shortcuts marked `ponytail:` (ceiling + upgrade). `grep -rn 'ponytail:' src`.
