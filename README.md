# rlmcode

> A self-orchestrating TUI coding agent. The model doesn't just call tools — it **authors and runs JS orchestration scripts** mid-turn, rendered live as a nested trace tree.

<!-- Screenshots/demo GIF go here once captured (see assets/demo.tape for the vhs script). -->

Multi-session terminal coding agent. Bun + Effect v4 core, opentui (React) UI, real
OpenTelemetry → local [`motel`](https://github.com/kitlangton/motel). LLM = Cloudflare Workers AI
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

## Prerequisites

- [Bun](https://bun.sh) (≥ 1.3) — runtime + package manager.
- A [Cloudflare](https://dash.cloudflare.com) account with Workers AI, and an API token
  (Workers AI permission) — for the real model. **Skip this** with `AX2_MOCK=1` (canned AI).
- Optional: the `termctrl` binary for the headless TUI test gate —
  `cargo install --git https://github.com/kitlangton/terminal-control terminal-control`.

## Install

```bash
bun install
cp .env.example .env   # then fill in CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

## Quickstart

```bash
bun run chat                 # the agent (needs CF creds in .env)
AX2_MOCK=1 bun run chat      # no credentials — canned AI, real turn loop + TUI
```

> ⚠️ **Safety:** the agent executes model-generated shell commands and JS **unsandboxed** in
> the working directory (`src/core/tools.ts`), and `bun run live` lets the model author + run
> code. Run only in a trusted directory, container, or VM.

### Tracing (optional)

```bash
bun run motel        # local trace ingest + API (127.0.0.1:27686)
bun run motel:tui    # the motel trace viewer
```

The `motel`/`motel:tui` scripts run a local clone at `../motel`
(`git clone https://github.com/kitlangton/motel ../motel`) — see the note at the bottom.

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

## License

MIT — see [LICENSE](LICENSE). Ported/reused third-party code is credited in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

## Note: run `motel` from the local clone

`bun add -g @kitlangton/motel` (npm 0.1.0) is **broken** against current Effect/opentui betas.
`bun run motel` / `motel:tui` run a local clone at `../motel`
(`git clone https://github.com/kitlangton/motel ../motel`), which pins compatible deps.
