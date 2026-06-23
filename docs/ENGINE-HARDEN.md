# ENGINE-HARDEN — adversarial verification of the orchestration engine

Scope: `workflow.ts`, `workflow-prims.ts`, `rlm-node.ts`, `orch.ts`, `orch-recipes.ts`,
`orch-resilience.ts`, `orch-spans.ts`, `runtime.ts`, `sessions.ts`, `agent.ts`.
Method: static read of the real source + bounded real probes (eval-escape, infinite-loop,
parallel-cap, soft/hard budget) + reasoned-only review for the network/trace paths that need
a live CF call. Every claim below was re-checked against the files, not taken on faith.

---

## 1. Headline

**6 CONFIRMED real defects** (crash / hang / leak / escape / data-loss class) vs **~13
graceful-degradation or documented shortcuts that are NOT defects.**

The engine core is sound: the one-level guard holds, the soft/hard budget split is correct,
`parallelLimit` truly caps concurrency, and the abort signal threads end-to-end into every
*node*. The real defects cluster in three places: (a) the in-process script eval has no
sandbox and no wall-clock ceiling, (b) per-session module Maps leak forever, (c) `runRlm`
throws past its own "answer always returned" contract for direct callers.

Confirmed defects ranked:

| # | Severity | Defect | Class |
|---|---|---|---|
| 1 | HIGH | In-process eval reaches `process`/`globalThis` — scripts read credentials | escape / data-loss |
| 2 | HIGH | Infinite pure-JS loop hangs the turn — no wall-clock cap on the script body | hang |
| 3 | HIGH | `turnEmits` / `turnCtx` / `turnAborters` Maps never cleared on `deleteSession` | leak |
| 4 | MED | `runRlm` throws on timeout/HARD-breach, violating "answer always returned" | crash (direct callers) |
| 5 | MED | Token budget never charged for pure-JS CPU — HARD ceiling ineffective for loops | unbounded-cost |
| 6 | LOW | 10x soft→hard RLM budget gap lets a loopy run burn 18M extra tokens | cost |

Defects 1, 2, 5 are the same root cause (the script body runs raw and uncapped); the fix for
2 (a `withTimeout`) plus the fix for 1 (an isolate) closes all three.

---

## 2. CONFIRMED DEFECTS — ranked (these feed orch-engine-harden)

### D1 · In-process eval reaches host globals — scripts can read credentials · HIGH

**Where:** `src/core/workflow.ts:48-66` (`runScript`).

**Repro (RAN real):** `runScript` builds `new Function("phase","log",…,"return (async () => {
${script} })()")`. JS's `Function` constructor does not sandbox the body — it sees every
global. A script body of `return process.env.CLOUDFLARE_API_TOKEN` returns the token; probes
confirmed `typeof process === "object"`, `process.argv` readable, and exfiltration of multiple
`*_API_KEY` env vars. The prims are the *only intended* names in scope (workflow.ts:7) but
nothing *enforces* that.

**Why it is a real defect, not the documented ponytail:** workflow.ts:10-12 rationalizes this
as "<= the bash tool already exposed … in-process JS eval adds ZERO new authority." That is
wrong on auditability. A sub-agent reading env via the `bash` tool produces a visible,
logged `Tool: bash` row in the tree (auditable). A workflow script reads `process.env`
directly with **no tool call, no tree row, no trace** — silent credential access. Same raw
authority, fundamentally different observability posture. The leak is invisible.

**The fix:** run the body in an `AxJSRuntime` isolate (already imported + proven in
`rlm-node.ts:164` with `AxJSRuntimePermission.TIMING`) instead of bare `new Function`. Pass
the prims as runtime *inputs*, not closure params, so the body can call them but cannot reach
`process`/`globalThis`/`require`. This realizes the "only the prims are in scope" intent that
the comment already claims. (Lighter `delete globalThis.process` guards are NOT acceptable —
incomplete, async-race-prone, and `globalThis` traversal still finds it.)

---

### D2 · Infinite pure-JS loop hangs the turn — no wall-clock cap on the script body · HIGH

**Where:** `src/core/workflow.ts:109-113` (the `otelContext.with(parentCtx, () =>
runScript(...))` call) and `runScript` at 48-66.

**Repro (RAN real):** a script body of `while (true) {}` (no `await`) never yields, so the
`await` at line 109/112 never resolves. A 2s probe timeout fired with the script still
busy-spinning. Contrast the node path: `runNode` → `resilientNode` →
`withTimeout(nodeId, LEAF_TIMEOUT_MS, …)` (orch-resilience.ts:189) caps every agent/rlm/judge
node at 120s. The **script body itself** goes through none of that — `workflowTool.func`
awaits `runScript` directly with no `withTimeout`, no `Promise.race`, no deadline. The abort
signal cannot help: a synchronous loop never reaches a yield point to observe `signal.aborted`.

**The fix:** wrap the `runScript` call in a timeout race. Either reuse `withTimeout(rootId,
SCRIPT_TIMEOUT_MS, signal, …)` (consistent with nodes; `NodeTimeoutError` is already caught by
the existing `catch` at workflow.ts:118 and surfaces as a clean string) or a plain
`Promise.race([scriptPromise, timeoutPromise])` gated by an env-overridable default (e.g.
`RLM_SCRIPT_TIMEOUT_MS`, ~5 min). Note: a timeout *rejects* the promise but a truly
synchronous `while(true)` still pins the event loop until it yields — the real durable fix is
**D1's isolate** (a worker the host can terminate). The timeout is the cheap first guard;
the isolate is the complete one.

---

### D3 · Per-session module Maps never cleared — unbounded memory leak · HIGH

**Where:** `turnEmits` `src/core/runtime.ts:114`; `turnCtx` `src/core/orch-spans.ts:58`;
`turnAborters` `src/core/agent.ts:208`.

**Repro (RAN real, static):** `grep` for `clearTurn*` / `turnEmits.delete` / `turnCtx.delete`
/ `turnAborters.delete` across `src/` returns **nothing** — these Maps are only ever `.set`
(agent.ts:258-259, 262) and `.get`, never deleted. `deleteSession` (sessions.ts:36) is
`sessionsRT.delete(id)` and nothing else — it releases the `AxMemory` + span but leaves all
three turn-keyed Maps holding the sessionId's `ActivitySink` closure, `OtelContext`, and
`AbortController` forever. Session ids are unique and never reused (atoms.ts `newId()`), so a
long-lived TUI/server accumulates one dead entry per Map per session created. The comment at
orch-spans.ts:55-57 literally promises "cleared on turn end" — that cleanup does not exist.

Per-session serialization (busyAtom) means at most one *live* entry per session, so this is
not a per-turn leak — it is a per-*session* leak that is unbounded over process lifetime.

**The fix:** export `clearTurnEmit` (runtime.ts), `clearTurnContext` (orch-spans.ts), and a
`clearTurnAborter` (agent.ts — needs an exported hook since `turnAborters` is closed over
inside `createAgent`), and call all three from `deleteSession` alongside the existing
`sessionsRT.delete(id)`. This mirrors the pattern the session-RT leak fix already used.

---

### D4 · `runRlm` throws on timeout/HARD-breach, violating its "answer always returned" contract · MED

**Where:** `src/core/rlm-node.ts:219-225` (the un-try/caught `await withTimeout(...)`) and the
`budget.charge` at 188 inside `actorTurnCallback`.

**Repro (REASONED — needs a live hung forward or a forced HARD breach):** the contract at
rlm-node.ts:21-23 states "Crossing the SOFT line only nudges — the RLM answer is ALWAYS
returned. Only the HARD runaway ceiling throws … → a partial." But `runRlm` has **no
try/catch** around `withTimeout`: a `NodeTimeoutError` (orch-resilience.ts:149) at 600s, or any
`rlm.forward` rejection, propagates uncaught. The HARD-ceiling `BudgetExhaustedError` from the
per-turn `budget.charge` (line 188) also escapes. The *production* caller is protected —
workflow-prims.ts:243-249 wraps the `rlm()` prim in try/catch and returns `rlm node failed:
…`. But **direct callers are not**: `scripts/telemetry-live.test.ts:93` calls `runRlm(...)`
bare, so a timeout there is an uncaught rejection. And per the contract a *timeout* should
return a partial, not throw at all.

**The fix:** wrap the `withTimeout` call (and the tail `budget.charge` reconcile at 231) inside
`runRlm` in try/catch that emits a delta and returns `{ answer: "", evidence: [] }` (plus the
turns/callbacks counted so far). Then `runRlm` honors its own contract for *all* callers, and
the prim's outer catch becomes a belt-and-braces backstop rather than the only guard.

---

### D5 · Token budget never charged for pure-JS CPU — HARD ceiling ineffective for loops · MED

**Where:** `src/core/orch.ts:262-264` (`charge` = `used += tokensOf(usage)`); charged only from
LLM-node usage at `workflow-prims.ts` (agent/judge) and `rlm-node.ts:188`.

**Repro (RAN real, static):** `Budget.charge` only folds `tokensOf(usage)` from agent/rlm/judge
forwards. A pure-JS `for`/`while` makes zero LLM calls → zero `charge` → `used` never moves →
`WF_TOKEN_HARD` (20M) never trips. So the HARD ceiling — the engine's stated runaway backstop —
is **blind to CPU runaway**. It only catches token overflow from many LLM calls, not a tight
compute loop. This is the cost-axis twin of D2 (which is the hang axis): the same uncapped
script body that hangs also escapes the only spend ceiling.

**The fix:** the wall-clock cap from D2 is the right backstop here — CPU runaway is a *time*
problem, not a *token* problem, so bound it with time, not by trying to charge tokens for raw
JS. No separate budget change needed once D2's script-body timeout lands.

---

### D6 · 10x soft→hard RLM budget gap lets a loopy run burn ~18M extra tokens · LOW

**Where:** `src/core/rlm-node.ts:53-57` (`RLM_TOKEN_BUDGET` 2M soft, `RLM_TOKEN_HARD` 20M hard).

**Repro (REASONED):** the soft line (2M) is advisory and never stops the RLM (contract:
"answer is ALWAYS returned"). A loopy exploration spending 2.1M–20M tokens only emits a UI
nudge; nothing stops it until 20M. That is up to ~18M tokens of unbilled-by-the-engine spend
before the HARD ceiling fires. The 10x gap is *intentional* (the comment: "~20M only catches a
true runaway loop") to avoid guillotining legitimate long-horizon runs — so this is a tunable
cost trade-off, the weakest of the six, not a crash/escape.

**The fix:** none required for correctness. If cost tolerance matters, lower `RLM_RLM_TOKEN_HARD`
via env, or add a caller-level circuit-breaker that `freeze()`s the budget after the soft
crossing. Listed as confirmed only because it is a real (if bounded) cost-leak vector, not a
documented-as-acceptable shortcut.

---

## 3. One-level guard + in-process eval boundary verdict

**One-level recursion guard: SOUND (structural).** Verdict quotes the proof. workflow.ts:128-130:

> The agent-callable workflow tool — added to the MAIN chat gen ONLY (agent.ts), never to a
> node gen (nodes carry BASE_TOOLS), so the one-level recursion guard holds.

A script's `agent()`/`rlm()` nodes are built with `BASE_TOOLS` only (file/shell), which does
not include `WORKFLOW_TOOLS`, so a node literally has no `workflow` function to call — a script
cannot spawn a script. The guard is enforced by *construction*, not a runtime check. The only
wart: if a model somehow induced a node to call `workflow`, it would surface as a generic ax
"function not found", not a clear "recursion not allowed" — a UX gap, **not an escape**. The
boundary is not escapable for recursion.

**In-process eval boundary: ESCAPABLE — confirmed (see D1).** The eval reaches `process` and
`globalThis`. The design comment claims the only in-scope names are the prims (workflow.ts:7),
but `new Function` does not enforce that — the body has the full global object. The
escape was RAN-real (env vars read). The `AxJSRuntime` isolate that *would* make this sound is
already used by the RLM executor (rlm-node.ts:19: "TIMING permission only — no
network/fs/process") but is **not** applied to the workflow script body. So: the RLM executor
sandbox is sound; the workflow script eval is escapable.

---

## 4. Trace integrity verdict

**One trace per session — INTACT in the live path; one REASONED fragmentation risk (unproven).**

The live chat path keeps a single trace. `turn()` stashes its `traceContext` by sessionId
(orch-spans.ts:59); the workflow handler recovers it (`getTurnContext(sessionId)`,
workflow.ts:105) because ax forwards a tool func only a `traceId` string + `{sessionId, ai,
abortSignal}` — never the `Context` (orch-spans.ts:47-54). The whole script body then runs
inside `otelContext.with(parentCtx, …)` (workflow.ts:109), and node spans mint under it via
`startNodeSpan` parenting to the recorded parent ctx (orch-spans.ts:75-83). Shape:
`chat.session → chat.turn → orch.node workflow → orch.node {branch/judge/rlm} → ax gen_ai`.

The flagged risk (workflow-prims.ts:244): the `rlm()` prim does `otelContext.with(
otelContext.active(), () => runRlm(...))` and `runRlm` *also* reads `otelContext.active()`
(rlm-node.ts:135) — it re-wraps active() rather than threading the *captured* `parentCtx`. The
verdict claims a yield in `streamingForward` could drop the ALS context to ROOT and fragment
the RLM into a separate trace id. **This is REASONED, not RAN — and the premise is shaky:** the
prims run *synchronously inside* the `otelContext.with(parentCtx, …)` established at
workflow.ts:109 (the body is invoked Promise-native within that `with`, not resumed across a
streaming yield), so `active()` resolves to `chat.turn` here. The redundant double-wrap is
harmless today (OTel context wrapping is idempotent) but is a real *fragility*: if `rlm()`/
`runRlm` were ever lifted out of the workflow.ts `with` (e.g. a standalone rlm tool), active()
would be ROOT and the RLM subtree would get a NEW trace id, fragmenting it.

**Verdict:** trace is one-per-session as built. The fragmentation is latent, not live. Harden
it anyway by threading the explicit captured `parentCtx`/`traceContext` into the `rlm()` prim
and `runRlm` signature instead of relying on ambient `active()` — make the nesting guaranteed,
not incidental. No live trace-id split was observed.

---

## 5. What was REASONED-only vs RAN-real (coverage honesty)

**RAN real (probed against running code or grepped source):**
- D1 eval escape — executed scripts that read `process.env` / `process.argv` / `globalThis`.
- D2 infinite loop — `while(true){}` body hung past a 2s probe timeout; confirmed no
  `withTimeout` wraps `runScript` (workflow.ts:109-113).
- D3 leak — grep proved zero `delete`/`clearTurn*` for all three Maps; read `deleteSession`
  (sessions.ts:36) confirming it only drops `sessionsRT`.
- D5 budget blindness — read `allocate.charge` (orch.ts:262-264): sums only `tokensOf(usage)`.
- `parallelLimit` caps concurrency (orch-recipes.ts, holder-cursor pump) — confirmed via the
  existing deterministic unit test (orch-core.test.ts: 20 thunks / limit 4 never exceeds 4).
- Soft budget never throws / only HARD + `freeze` throw — read `guard()` (orch.ts:255-258).
- Abort threads into every *node* — read the full chain (workflow.ts:89 → workflow-prims
  `optsFor` abortSignal → `resilientNode` → `withTimeout` forked child signal,
  orch-resilience.ts:130-156, 183-189).

**REASONED only (NOT run — need a live CF/network call or a forced fault injection):**
- D4 contract breach — verified the *missing try/catch* by reading rlm-node.ts:219-225 and the
  bare caller telemetry-live.test.ts:93, but did not drive an actual RLM timeout or HARD breach.
- D6 token gap — arithmetic from the constants; no real 18M-token run.
- §4 trace fragmentation — reasoned from the streaming-yield/ALS premise; no fragmented
  trace id observed (and the premise looks unlikely in the live path, see §4).
- RLM `withTimeout` actually aborting the **in-flight CF HTTP** (vs just rejecting the race
  while the request continues at CF) — relies on ax honoring `abortSignal` in `forward`; the
  code wires the forked signal (rlm-node.ts:219-223) but no real hung-forward test proves the
  HTTP stops. Potential CF-cost leak if ax does not fully abort. Unverified.
- RLM EMPTY/NOMATCH blob handling — no test exercises a context with no answer.

**Explicitly NOT inflated into defects (documented shortcuts / graceful degradation):**
- Soft budget being advisory-only (the root-cause fix: completed work is never guillotined) —
  by design, tested (orch-core.test.ts).
- Graceful max-steps finalize emitting raw tool tokens on the degenerate `maxSteps<=1` case —
  detected + nudged once, bounded, tested.
- RLM distiller→executor handoff flake (~1/4) — a documented ax-internal flake, mitigated by
  the DISTILLER/EXECUTOR steers + a 5x retry in the live harness; not an engine bug.
- `TurnQueue.push` dropping after `close()` — proven unreachable by streaming order (drain
  emits before close).
- Budget `used` "race" under 100 parallel nodes — `charge` is synchronous with no await, each
  Budget is per-turn, JS is single-threaded; not a real race.
- Abort propagation into the RLM — verified correct (signal → `withTimeout` child →
  `forward.abortSignal`); the claimed asymmetry is functional parity, not a gap.
- One-level guard surfacing a generic ax error instead of "recursion not allowed" — UX, not
  escape.
- `String(out.answer ?? "")` / `Array.isArray` evidence coercion — matches the RLM signature;
  lossy only on an off-contract model shape, no logging — minor, not a defect.
