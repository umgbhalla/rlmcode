# ax2 — Quick Reference Card

## What it is

Multi-session TUI coding agent: Bun + TypeScript, Effect v4 core, opentui React UI, OpenTelemetry traces → local `motel`. LLM is Cloudflare Workers AI `@cf/moonshotai/kimi-k2.7-code` via `@ax-llm/ax`.

## Key files

| File | Purpose |
|------|---------|
| `src/otel.ts` | NodeSdk → OTLP → motel; `appRuntime` (Atom.runtime) |
| `src/agent.ts` | ax LLM + tools; `turn()` Effect span; budget recovery |
| `src/tools.ts` | AxFunctions: bash, read_file, write_file, edit_file, glob, grep |
| `src/toolui.ts` | Per-tool label / summary / preview |
| `src/activity.ts` | Live activity bus (ax logger → UI) |
| `src/atoms.ts` | App state + session actions (`appRuntime.fn`) |
| `src/sessions.ts` | Per-session AxMemory + root span |
| `src/chat.tsx` | opentui UI: sessions, transcript, tool views |

## Run

Needs `.env`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Optional: `AX2_MAX_STEPS` (default 50).

```bash
bun run motel        # local motel ingest on 127.0.0.1:27686
bun run motel:tui    # motel TUI
bun run chat         # the agent
bun run emit         # headless trace smoke
bun run lint         # check + analyze + debt (run before commit)
```

> Do **not** use npm/global `@kitlangton/motel` — it is broken against current Effect/opentui betas. Use the local `../motel` clone via the scripts above.

## Lint gates

| Command | What | When |
|---|---|---|
| `bun run check` | `tsc --noEmit` + `@effect/language-service` | after any `.ts`/`.tsx` edit |
| `bun run analyze` | `yuku-analyzer` — dead exports, unused imports, circular deps, budgets | after structural changes |
| `bun run debt` | `ponytail:` marker ledger — fails without `Upgrade:` line | after adding shortcuts |
| `bun run lint` | all of the above | **before every commit** |

## Discipline

- `tsconfig`: strict, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes` — do not relax.
- Source files stay under 500 lines (`src/chat.tsx` and `build-viz.ts` are grandfathered).
- Every `ponytail:` shortcut must include an `Upgrade:` line.
- Architectural shortcuts need an ADR in `docs/adr/` or a named test.
- Check `../effect-solutions/packages/website/docs` and `../effect-smol` before guessing Effect patterns.

## Trace shape

One trace per session: `chat.session → chat.turn → ax gen_ai (→ Tool: …)`.
