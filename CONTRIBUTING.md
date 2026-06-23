# Contributing

Thanks for your interest. The full engineering contract lives in [AGENTS.md](AGENTS.md)
(also used by AI coding agents). The short version:

## Setup

```bash
bun install
cp .env.example .env   # fill in CF creds, or use AX2_MOCK=1 to skip them
```

## The loop

```bash
bun run check   # tsc + Effect language-service — the tight inner loop, run after any .ts edit
bun run lint    # check + tests + analyze + debt — the commit gate, must be green to ship
```

`bun run test:tui` is a separate gate (needs the `termctrl` binary + a real PTY) — run it
locally before shipping TUI changes. See AGENTS.md → "Headless TUI gate".

## Rules of the road

- **Module boundaries:** the TUI consumes the engine ONLY through the SDK barrel
  `src/core/sdk.ts`. `bun run analyze` enforces this (`crosscore` rule).
- **File-size budget:** 300 lines for barrels, 500 for impl files. Split by concern, don't grow.
- **Shortcuts:** mark deliberate simplifications with a `ponytail:` comment naming the ceiling
  + upgrade path. Any architectural shortcut needs an ADR in `docs/adr/` or a named test.
- **tsconfig is strict** and non-negotiable — fix the type, don't relax the flag.

## Commits / PRs

Conventional-commit style (`feat(tui): …`, `chore: …`). Keep `bun run lint` green.
