# Changelog

All notable changes to rlmcode are documented here. This project adheres to
[Semantic Versioning](https://semver.org).

## v0.0.1 — 2026-06-23

First tagged release: a self-orchestrating, fully traced TUI coding agent.

### Engine
- **`workflow` self-orchestration** — mid-turn the model authors a JS script over in-process
  prims (`phase` / `agent` / `parallel` / `pipeline` / `judge` / `rlm` / `budget`) and the engine
  runs it. Loops, conditionals, fan-out, best-of-N, verify — expressible, not a fixed strategy menu.
- **`rlm()` prim** — load a giant blob into a code runtime; the RLM actor writes JS to mine it for
  the answer. One prim among many, not a special tool.
- Resilience: per-script timeout (no hung turns), a separate background-node rate-limiter lane (a
  fan-out can't starve the chat turn), partial-on-fault contracts (`runRlm` never throws), and
  per-session Map cleanup on `deleteSession`.
- Stream stall-watchdog on the main chat drain — closes the hang on a stalled provider stream.
- Over-exploration steer: guardrail-first prompt, lower `RLM_MAX_STEPS` default (24).

### TUI (opentui React)
- Live nested **node-tree** — every fan-out, branch, and per-node tool cluster renders inline under
  the turn that spawned it, with per-node token badges and a Σ footer.
- **Selectable themes** — a palette registry (Catppuccin · Gruvbox · Tokyo Night · high-contrast)
  with a `/theme` picker that switches live and persists.
- **Sticky session header** — `rlmcode · session <id>`; the id is the motel `chat.session` span
  tag, so what's on screen is the handle you grep in the trace viewer.
- **Native syntax diffs** — `edit`/`write` tool calls render as real syntax-highlighted +/- diffs.
- `⌘K` command palette + a keybind registry + a which-key overlay + `@`-mention / slash autocomplete.
- Prompt queue (send-while-busy → drain FIFO), live 429 rate-limit backoff, live markdown,
  reasoning / tool-output collapse, and static-commit (memoized settled turns — no scrollback repaint).

### Tracing
- One OpenTelemetry trace per session — `chat.session → turn → workflow → nodes` — real 3-signal
  export to a local [`motel`](https://github.com/kitlangton/motel); the trace mirrors the live tree.

### SDK
- Importable barrel at `src/core/sdk.ts` (`createAgent → Agent`) over a flat `TurnEvent` stream —
  no Effect / OTel / ax types leak past it. Regression-gated by `examples/sdk-usage.ts`.

### Quality
- Headless TUI frame gate (`bun run test:tui`, terminal-control PTY, 31 frame tests, zero network).
- Commit gate (`bun run lint`): tsc + Effect language-service + hermetic tests + yuku design-check +
  ponytail debt ledger.
- The engine was verified by repeated adversarial passes (engine-verify, orch-engine-harden,
  turn-harden, stuck-analysis).

### Security
- The agent runs model-generated shell + JS **unsandboxed** in the working directory
  (`src/core/tools.ts`); the in-process `workflow` script eval has host authority ≤ the bash tool
  already exposes. Run only in a trusted directory, container, or VM.
