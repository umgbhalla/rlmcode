# rlmcode

> A self-orchestrating TUI coding agent. The model doesn't just call tools — it **authors and runs JS orchestration scripts** mid-turn, rendered live as a nested trace tree.

![rlmcode demo](assets/demo.gif)

Multi-session terminal coding agent. Bun + Effect v4 core, opentui (React) UI, real
OpenTelemetry → local [`motel`](../motel). LLM = Cloudflare Workers AI
(`@cf/moonshotai/kimi-k2.7-code` / `@cf/zai-org/glm-5.2`) via [`@ax-llm/ax`](https://github.com/ax-llm/ax).

## What makes it different

- **`workflow` tool — the agent writes the orchestration.** Mid-turn, the model authors a JS
  script using in-process prims (`phase` / `agent` / `parallel` / `pipeline` / `judge` / `rlm`
  / `budget`) and the engine runs it — like an ultracode workflow, authored by the model itself.
  Loops, conditionals, fan-out, best-of-N, verify — all expressible, not a fixed strategy menu.
- **`rlm()` node — mine a huge blob out of the prompt.** A long file / log / concatenated module
  is loaded into a code runtime; the RLM actor writes JS to mine it for the answer. Just one prim
  among many, not a special tool.
- **Live node tree.** Every fan-out, branch, and per-node tool cluster renders as a nested
  unicode tree, inline under the turn that spawned it — with live status, tokens, and a Σ footer.
- **One trace per session.** `chat.session → chat.turn → workflow → nodes`, real 3-signal
  OpenTelemetry exported to `motel` — the trace mirrors the live tree.

![rlmcode TUI](assets/tui.png)
![rlmcode trace in motel](assets/motel.png)

## Quickstart

`.env` needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

```bash
bun run motel        # local trace ingest + API (127.0.0.1:27686)
bun run motel:tui    # the motel trace viewer (optional)
bun run chat         # the agent
```

## Architecture

    src/core/   agent (turn = chat.turn span) · orch.ts (5 prims) · workflow.ts (the script tool)
                rlm-node.ts (the rlm prim) · tools.ts · runtime.ts · models.ts · sdk.ts
    src/tui/    opentui React UI — transcript, composer, the inline node tree, theme, icons
    src/otel.ts NodeSdk 3-signal (traces/logs/metrics) → motel

The core is importable as an SDK (`src/core/sdk.ts`): `createAgent → Agent` over a flat
`TurnEvent` stream, no Effect/OTel/ax types leaking past the barrel.

## Verify

```bash
bun run lint      # tsc + hermetic tests + design-check + ponytail-debt — the commit gate
bun run test:tui  # headless TUI frame gate (terminal-control PTY, mocked AI, zero network)
bun run live      # real CF-Kimi proof: the model authors + runs a workflow script
```

## Note: run `motel` from the local clone

`bun add -g @kitlangton/motel` (npm 0.1.0) is **broken** against current Effect/opentui betas.
`bun run motel` / `motel:tui` run the local `../motel`, which pins compatible deps.
