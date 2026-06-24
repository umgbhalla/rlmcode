# Changelog

All notable changes to rlmcode are documented here. This project adheres to
[Semantic Versioning](https://semver.org).

## v0.0.3 — 2026-06-24

Deep design-failure fixes — a waved, gated build closing the 12 architectural failures found by the
adversarial audit (`.research/design-failures.md`), each grounded in a mature reference stack
(codex-rs / opencode / motel / claude_code) and verified by a NEW captured-frame or unit assertion.

### Live multi-phase render (was: tool-output splatter)
- **Three-tier render (F1, CRITICAL).** The expanded `ToolBody` no longer dumps the full output
  inline (`Number.MAX_SAFE_INTEGER`) — it stays bounded to a turn-aware budget with a `… +N more`
  affordance, and a dedicated node DETAIL pane (`node-detail.tsx`) renders the focused node's status,
  collapsed prompt, and last-N tool CALL one-liners (never the output). The node tree is now a compact
  one-liner per node (status dot + label + model + right-aligned `tok · tools`) — structure + status,
  detail strictly on demand (the motel `SpanDetailPane` tree-vs-detail split).
- **Assembly-time tool grouping (F2/F3).** `groupSteps` runs ONCE at transcript assembly (`toTurns`),
  not per render, and the grouped shape is a first-class product reused by both the main transcript
  and a node's owned tools — the main-turn/node asymmetry is gone.
- **Single flatten per render (F4).** The workflow tree is flattened ONCE into a stable `Row[]`
  carried on the assembled turn, shared by the render, the focus ring, and the memo comparator
  (was 3× `flatten()` per busy tick).
- **Node error bubbling (F5) + turn-aware row budget (F6).** A node bubbles a `✗ N failed` badge +
  warning color from its failed child tools; an expanded tool body is bounded to a viewport-derived
  per-turn allocation, so one big `bash` can no longer blow the whole screen.

### Streaming, watchdog & finalization
- **Watchdog split (F7, KNOWN).** The single 60s stall threshold is split into a generous first-token
  budget (`RLM_FIRST_TOKEN_MS`, default 300s) vs a tight inter-chunk stall (`RLM_STREAM_STALL_MS`,
  default 60s), both backstopped by the wall-clock cap — no more false-positive aborts on slow
  reasoning models.
- **Per-node streaming seam (F8, latent-critical).** `replyDelta`/`thinkingDelta` now carry an
  optional `nodeId`; `drainWithWatchdog` threads it so a node forwarding with `stream:true` grows its
  OWN transient text instead of corrupting the main transcript. (`TurnEvent` widens by two optional
  serializable fields — the SDK barrel + round-trip stay intact.)
- **Live/committed split (F9).** The in-flight stream grows a transient `liveText` buffer; finalize
  builds the committed message FRESH from the authoritative reply and clears `liveText` — a coarse
  live stream is shown only transiently, never snapped over a stale committed message.

### Structural cleanups
- **Narrowed emit recovery (F10).** Every in-fiber producer (the main reply stream, the per-turn step
  logger, the node path) threads `emit` EXPLICITLY; the synchronous session-index recovery
  (`getTurnEmit`) is now documented + scoped to the SOLE out-of-fiber TOOL-HANDLER seam (ax calls a
  tool func outside the turn fiber with only a fixed `extra`). The cell still owns `ctx`/`aborter`,
  which genuinely need out-of-fiber recovery.
- **First-class settled boundary (F12).** Settledness is inferred ONCE at assembly (`turnSettled` →
  `Turn.settled`) and the memo comparator READS the stamp instead of re-deriving it (re-walking
  `workflow.nodes`) on every compare — one authority for the in-flight/committed phase boundary.

## v0.0.2 — 2026-06-24

Lint/quality-gate rework — the gate now "thinks like the Rust compiler": every rule lands at a
tier (ERROR blocks the gate, WARN is surfaced + counted but non-blocking, OFF). Four complementary
layers — tsc strict, `@effect/language-service`, oxlint, and yuku design-check — with no overlap.

### Quality gate
- **Effect language-service enforcement.** The already-loaded `@effect/language-service` plugin
  now sets a `diagnosticSeverity` tier split (it previously enforced NOTHING — editor hints only),
  run headlessly in `bun run check` so it gates. Correctness + anti-pattern diagnostics
  (`floatingEffect`, `missingEffectContext`, `leakingRequirements`, …) are ERROR; the Effect-native
  side-effect detectors (`globalDate`/`globalRandom`/`globalConsoleInEffect`/`globalFetchInEffect`/
  `processEnvInEffect`/`newPromise`/… — the full mutable/imperative ban as type diagnostics) are
  ERROR inside `src/core/` (via a `tsconfig.core.json`
  override) and OFF at the composition edge (`src/app/`, `src/tui/`, `src/otel.ts`), which
  legitimately touches `process.env`/`console`/node builtins. `Ref`/`SubscriptionRef` are sanctioned
  — never banned. Style/opportunity diagnostics ride at WARN.
- **tsconfig strict flags added:** `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`,
  `erasableSyntaxOnly`, `isolatedModules`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `moduleDetection: "force"` — well past plain `strict`. Strict flags are non-negotiable: fallout is
  fixed in code, never silenced by relaxing a flag.
- **oxlint (NEW gate step).** A Rust per-statement linter (`bun run oxlint`) complementing yuku's
  cross-file analysis: `no-var` + `no-param-reassign` (the mutable-state ban), inline type-imports,
  `import/no-duplicates`/`no-cycle`, generic array types. Correctness/suspicious/perf at ERROR;
  `no-console`/`unicorn` idioms at WARN. yuku is retained (reachability dead-code, the `crosscore`
  SDK-barrel boundary, write-flow) — the layers are complementary, not duplicative.
- **design-check budgets (still FIXED).** `scripts/design-check.ts` keeps the FIXED named-const
  ceilings — `CC_BUDGET` 20, `NEST_BUDGET` 8, `INDEX_LINE_BUDGET` 300 / `LINE_BUDGET` 500,
  `PARAM_BUDGET` 6 (tunable only with a reason) — every finding ERROR-tier (blocking, staged-blocking
  under `--staged`). The DYNAMIC budget rubric (role × export-fan × 90d-churn × complexity-density,
  with a WARN "approaching budget" / hotspot tier) is DEFERRED to a follow-up `design-check.ts`
  rework — it is NOT shipped in v0.0.2 (it would tighten core CC to 12 and squeeze hot files,
  requiring real refactors of `agent.ts`/`orch.ts`/`run.ts`/`atoms.ts` first).
- **`bun run debt:audit` (advisory).** A non-blocking semantic over-engineering pass alongside the
  deterministic, blocking `ponytail-debt.ts` ledger, churn-ranked so debt in hot files surfaces first.
- **AGENTS.md policies.** Documented the rustc tier model, the Effect-driven design mandate
  (state = immutable data + Effect DI), the test-rewrite-on-version-bump rule, and the hermetic
  mock-first gate (zero network / zero live AI; `RLM_LIVE` is a separate on-demand gate).

### TUI gate fixes (test:tui now fully green)
- Fixed a transcript-drop bug in `sendAtom` (`src/tui/atoms.ts`): for a session with no orch tree
  (the common plain-chat case) the `patch` returned the OLD message list instead of the updated one,
  so user cards and replies never rendered. Non-orch turns now render their full transcript.
- Hardened the headless TUI driver (`scripts/tui/driver.ts`): `type()` self-heals the composer's
  mount/focus-flap race (the textarea gains focus a tick after its placeholder paints, so an
  early keystroke was silently dropped) by frame-stably re-sending into the empty composer only —
  scoped away from overlays (palette/dialog/autocomplete) and list-nav. De-flaked `autocomplete.test`
  with frame-stable buffer-clear gates. No fixed-sleep waits introduced.

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
