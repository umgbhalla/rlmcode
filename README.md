# ax2 — Effect loop agent, opentui UI, OTel → motel

Multi-turn chat agent. Cloudflare Workers AI (Kimi K2.7 Code) via ax-llm,
agent core in Effect v4, opentui (React) inline UI bound to Effect through
`@effect/atom-react`, real OpenTelemetry spans exported to local `motel`.

## Stack

| Piece        | What                                                        |
|--------------|-------------------------------------------------------------|
| LLM          | `@ax-llm/ax` 22 → CF Workers AI `@cf/moonshotai/kimi-k2.7-code` |
| Core         | `effect` 4.0.0-beta.85 (`Effect.withSpan`, `Atom.runtime`)  |
| UI bridge    | `@effect/atom-react` (atoms = the UI's "Effect interface")  |
| UI           | `@opentui/core` + `@opentui/react`, `screenMode: main-screen` (inline) |
| Tracing      | `@effect/opentelemetry/NodeSdk` + OTLP/HTTP exporter        |
| Viewer       | `motel` (local OTLP ingest + TUI), `../motel`               |

## Files

    src/otel.ts    TracingLive (NodeSdk → OTLP → motel) + appRuntime (Atom.runtime)
    src/agent.ts   ax/CF Kimi + turn(message): Effect<string>, spans chat.turn → ax.forward
    src/atoms.ts   messagesAtom, busyAtom, sendAtom (appRuntime.fn, traced)
    src/chat.tsx   opentui App + RegistryProvider, inline render
    smoke-emit.ts  headless: emit 2 traced turns (no UI)

## Run

`.env` must hold `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

```bash
# 1. start motel from the LOCAL clone (NOT npm — see note)
bun run motel           # headless ingest+API on 127.0.0.1:27686
# or, for the visual TUI:
bun run motel:tui

# 2. chat (another terminal)
bun run chat            # type, Enter sends, Esc quits

# headless trace smoke (no UI):
bun run emit
```

Each turn appears in motel as a `chat.turn → ax.forward` trace
(`gen_ai.request.model`, `gen_ai.prompt` attributes), service `ax2-chat`.

## Note: don't use the npm/global motel

`bun add -g @kitlangton/motel` (npm 0.1.0) is **broken** against current
Effect/opentui betas — duplicate React copies (`resolveDispatcher().useState`
null) and stale `Service.asEffect()` calls (500 on `/v1/traces` and queries).
Run `motel` from the local `../motel` clone, which pins compatible deps
(`effect@4.0.0-beta.49`). `bun run motel` / `motel:tui` do this.
