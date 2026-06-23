# v0.0.1 Release-Readiness Audit

_Synthesized from a multi-lens audit (orch-correctness, security/sandbox, sdk-boundary, test-coverage, docs/release) + verified against the working tree on branch `fix/otel-gaps`._

A 0.0.1 is an **honest, runnable, documented early release** — not perfection. The bar for a blocker is: crash / hang / data-loss / undocumented footgun / broken core path / a gate that can't go green / a release that lies about itself. Polish, missing unit tests for already-correct paths, and documented trade-offs are **not** blockers.

---

## 1. GO / NO-GO

**NO-GO — 3 confirmed blockers** (all small, all fixable in well under a day).

The core is solid: turn loop enforces final-reply-once, SDK barrel is sealed (no Effect/OTel/AxMemory leak), orchestration has soft/hard budget ceilings + abort + one-level recursion guard, headless core tests are green, security risk is documented. The blockers are **release hygiene**, not engine defects: the build can't go green (`lint` is RED), the version lies, and the lint gate is broken. Fix those three and it's a GO.

---

## 2. CONFIRMED BLOCKERS (ranked)

### B1 — `bun run lint` is RED: dead export `resolveTheme` fails `analyze`
- **Where:** `src/tui/theme.ts:176` (`export const resolveTheme`) — referenced only in comments, nowhere in code.
- **Why:** `bun scripts/design-check.ts` exits **1** (`delete: src/tui/theme.ts: dead export "resolveTheme"`), so `bun run lint` (which chains `analyze`) cannot pass. The commit/CI gate is broken on `main`'s contract. **Note:** the original finding mis-titled this as "syntax highlighting not wired / `makeSyntaxStyle` unused" — that part is **wrong**: `makeSyntaxStyle()` IS wired at `chat.tsx:32`. The real, verified break is the orphaned `resolveTheme` sibling export. (This is also why some lenses reported "lint green" — the `design-check.test` *structural* suite passes; the `analyze` *step* does not.)
- **Fix phase:** **now** (pre-tag). One line: delete the export (or wire it into the theme-name path it was staged for).

### B2 — Version lies: declares `0.1.0`, release target is `0.0.1`
- **Where:** `package.json:3`, `src/core/sdk.ts:72` (`RLM_VERSION`), `src/otel.ts:27` (`SERVICE_VERSION`). No git tag exists (`git tag -l` empty). (`worker/package.json` also `0.1.0` — separate CF-Worker/site, lower priority.)
- **Why:** `RLM_VERSION` is exported in the public SDK surface (`agent.info().version`) and stamped on every OTel span sent to motel. A `git tag v0.0.1` over code that self-reports `0.1.0` makes the release dishonest about itself — fails the "honest" bar. Pure string fix, no behavior change.
- **Fix phase:** **now** (pre-tag). Bump all three (4 with worker) to `0.0.1` in one commit.

### B3 — `workflow` script comment/prompt falsely claims "ONLY the prims in scope" (process.env reachable)
- **Where:** `src/core/workflow.ts` comments (lines 3, 7, 44–45) + the tool description / `RLM_WORKFLOW_OVERLAY` system prompt (`workflow.ts:71,75`; `agent.ts` overlay).
- **Why:** Model-authored JS runs via `new Function(...)`; despite the comment "an async Function whose **ONLY** parameter names are the prims" / tool desc "the ONLY names in scope", `new Function` bodies reach `process.env` (incl. `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID`), `globalThis`, and Node globals. The **authority** is fine (≤ the already-unsandboxed `bash` tool, documented in SECURITY.md/README as "trusted dir/VM only"), so this is **not** a new security hole — but the code/prompt make a **false security claim**, which fails "honest documentation." Lowest of the three because the broader unsandboxed warning already exists; the defect is the specific "ONLY prims" wording.
- **Fix phase:** **6** (docs/seal) — but cheap enough to do now. Correct the comment + add one line to SECURITY.md ("workflow/RLM scripts can read `process.env`; keep credentials out of a trusted-only env") and a caveat in the overlay ("script runs unsandboxed; do not read/log credentials").

---

## 3. NICE-TO-HAVES (non-blocking, deferrable)

- **`turnCtx` / `turnEmits` Maps never cleared** (`orch-spans.ts:58`, `runtime.ts:114`). Real, confirmed leak — comment promises "cleared on turn end" but no cleanup exists; grows O(unique sessionIds), survives `deleteSession()`. ~1–2 KB/day for TUI usage; no crash/hang. **Would be a blocker for a long-running server build.** → phase 8. (Cheap real fix: clear both in `run.ts` runTurn `finally` / `turn` finalizer.)
- **Cross-session turn-context overwrite** (`agent.ts:258`, `orch-spans.ts:59`, `runtime.ts:115`). Module Maps keyed by `sessionId`; safe today (single modal session, serialized turns) but two concurrent sessions would cross-nest spans. → phase 8 / server-readiness.
- **No CHANGELOG** (repo root). First release; git history is the trail. → phase 8.
- **No real ADRs** (`docs/adr/` has only `0000-template.md`) though 6–9 `ponytail:` markers carry upgrade paths. AGENTS.md asks shortcuts reference an ADR or a named test — the markers + tests partly satisfy this. → phase 8.
- **`package.json` missing `description`/`repository`/`homepage`/`bugs`** (all absent); `private:true` (intentional — document the choice). → phase 8.
- **Headless test gaps for already-correct paths:** RLM node (only the flaky live probe, `workflow-live.test.ts:133`), `workflow` script error mapping (SyntaxError/runtime — caught & returned as strings, but untested), turn-loop abort/error mapping (partially covered by `messages.test.ts` + orch tests). All are graceful-degradation paths that **work**; missing tests are regression-risk debt, not defects. → phase 7.
- **TUI suite PTY flakiness** (`palette.test.ts`, `composer.test.ts`): tests run sequentially (`&&`), cleanup is present (`driver.ts` `stop()`); intermittent failures are timing/settle races, retryable, documented. Annoying, not a logic bug. → phase 7 (harness hardening).
- **Budget soft-ceiling overspend not reflected in `TurnResult.budget`** (`orch.ts:251`, `agent.ts:437`); span/log show it, result flag doesn't distinguish max-steps vs token-blowout. → polish.
- **Structural-only one-level recursion guard** (`workflow-prims.ts:44,150` hardcode `BASE_TOOLS`); correct but not runtime-asserted. Add an invariant assertion. → polish.
- **`any`-cast on ax `getUsage()`** (`agent.ts:143`, ponytail #6); guarded by shape-check, waits on ax public API. → upstream-gated.

---

## 4. v0.0.1 GATE STATUS

| Gate | Status | Notes |
|---|---|---|
| `bun run check` (tsc) | ✅ MET | Zero errors, strict flags on. |
| `bun run test` (headless core) | ✅ MET | All 10 suites green, deterministic, no skips. |
| `bun run analyze` | ❌ **PENDING (B1)** | Exits 1 — dead export `resolveTheme`. |
| `bun run debt` | ✅ MET | All `ponytail:` markers carry `Upgrade:`; 0 orphan / 0 no-trigger. |
| **`bun run lint` (the gate)** | ❌ **PENDING (B1)** | RED solely because `analyze` fails; fixes with B1. |
| `bun run sdk:smoke` | ✅ MET | 11 assertions; barrel sealed, no CF creds needed. |
| `bun run test:tui` (frame gate) | ⚠️ MOSTLY | Green per-test & by design (sequential); intermittent PTY settle races. Acceptable-with-known-flake. |
| `bun run live` (RLM_LIVE) | ⚠️ GATED | Off by default; RLM probe flaky ~1-in-4 (ax distiller nondeterminism), bounded to 5 retries. Not in `lint`. |
| Docs (README/SECURITY/LICENSE/CONTRIBUTING/THIRD-PARTY/BRANDING) | ✅ MET | All present; unsandboxed risk warned. **One inaccuracy → B3.** |
| Version = `0.0.1` | ❌ **PENDING (B2)** | Currently `0.1.0` in 3 places. |
| `git tag v0.0.1` | ⏳ PENDING | None yet (expected — tag after B1–B3 land). Pre-commit hook present & wired (`core.hooksPath`). |

**Already met:** check, test, debt, sdk:smoke, license/docs baseline. **Pending:** lint (B1), version (B2), doc accuracy (B3), then tag.

---

## 5. PER-PHASE MUST-FIX (this audit's findings, phases 3–8)

- **Phase 3 (orchestration correctness):** none blocking. Defer: span-registry session-scoped cleanup nit (`orch-spans.ts:32`), RLM tail-usage reconcile guard/comment (`rlm-node.ts:230`).
- **Phase 4 (resilience/budget):** none blocking — timeout→null, max-steps graceful-finalize, transient retry/backoff, hard-ceiling-only throw all verified. Defer: surface token-overspend in `TurnResult.budget`; runtime-assert the recursion guard.
- **Phase 5 (SDK boundary):** **clean — nothing to fix.** Barrel sealed, `TurnEvent`/`TurnResult` fully serializable, no reverse imports, consumer example imports only the barrel. (Wire `AgentOptions.onLog`, ponytail #8, is a phase-5/6 nicety, not required.)
- **Phase 6 (docs / seal):** **B3** — fix the false "ONLY prims in scope" claim in `workflow.ts` + overlay, add the `process.env` note to SECURITY.md. (B2 version bump is "now" but lands the doc/seal story.)
- **Phase 7 (test coverage):** non-blocking debt — add headless tests for: RLM node contract (budget/timeout/error in isolation, not the flaky live probe); `workflow` script SyntaxError/runtime/budget error mapping; turn-loop abort + `ChatError`→warning. Harden the PTY harness (`driver.ts`) against settle-race flakes.
- **Phase 8 (release polish):** clear `turnCtx`/`turnEmits` Maps (real leak); add `CHANGELOG.md`; add `package.json` `description`/`repository`/`homepage`/`bugs`; write ADRs for the standing ponytail shortcuts (or point each at its named test); address cross-session span-nesting before any server build.

---

### Bottom line
Three small blockers stand between this tree and an honest `v0.0.1`: **B1** (delete `resolveTheme` → `lint` goes green), **B2** (bump `0.1.0`→`0.0.1` in 3 files), **B3** (fix the "ONLY prims" claim + one SECURITY.md line). Land those, run `bun run lint` green, tag `v0.0.1`. Everything else is honest, documented debt appropriate for a 0.0.1.
