# STUCK-ANALYSIS — why rlmcode sits at "thinking… 218s"

## 1. Headline — HANG vs CRAWL

**The observed 218s is a CRAWL. A separate, unguarded HANG defect also exists and is the urgent one.**

These are two different things and the report conflates them. Keep them apart:

- **The 218s case = CRAWL.** The turn *completed* — `turn.done` fired, a reply came back, the
  spinner was advancing (live `replyDelta`/`thinkingDelta`). Trace evidence: ~12 tool steps +
  9 reads + 42.2k tokens on Kimi K2.7 (a thinking model). Normal turns in motel are 200–300ms;
  this turn was 218s because every CF step ran ~15–25s under concurrent campaign load (solo
  baseline ~6.5s) and there were 12 of them in a waterfall. `12 × ~18s ≈ 216s` ≈ the 218s.
  That is slow, not stuck. **No span shows a 60s+ gap with no chunk arriving** — which is what a
  real hang would look like.

- **The HANG is a real, currently-unmitigated DEFECT — it just didn't fire in this trace.**
  The main turn's stream drain has **no timeout of any kind**. `agent.ts:353`:
  ```ts
  for await (const d of chat.streamingForward(service, { message: msg }, opts)) { … }
  ```
  is a naked `for-await` inside `Effect.tryPromise` (`agent.ts:326-366`) with **no
  `withTimeout`, no `Promise.race`, no per-chunk watchdog** — only `abortSignal` (line 347),
  which needs the *user* to hit cancel. If CF opens the stream, sends some chunks, then stalls
  (half-open socket, CF Worker freeze, backpressure) **with no `done` and no error**, the
  `for-await` suspends forever. Then `runForward` never resolves → `.finally` at `run.ts:222`
  never runs → `queue.close()` (line 224) never fires → the drain at `run.ts:229` never ends →
  `replyPromise` never settles → spinner spins forever. **Verified end-to-end in source.**

**The asymmetry is the smoking gun.** Every *other* CF path is timeout-wrapped; only the main
turn is bare:

| path | timeout | source |
|---|---|---|
| leaf orchestration node | `LEAF_TIMEOUT_MS` (120s) | `orch-resilience.ts:180,189` |
| workflow op | `WF_TIMEOUT_MS` (300s) | per report |
| RLM op | `RLM_TIMEOUT_MS` (600s) | per report |
| **main chat turn** | **`Number.POSITIVE_INFINITY` → `withTimeout` skipped** | **`orch-recipes.ts:180` + `orch-resilience.ts:189`** |

`orch-recipes.ts:180`: `const timeoutMs = isMainTurn ? Number.POSITIVE_INFINITY : LEAF_TIMEOUT_MS`.
`orch-resilience.ts:189`: `Number.isFinite(timeoutMs) ? withTimeout(...) : once(signal)` — non-finite
**skips the timeout entirely**. The carve-out is *intentional* (a turn fans out a whole
orchestration; a 120s leaf cap would guillotine it — comment at `orch-resilience.ts:164-167`).
But disabling the per-*node* cap also left the *stream drain itself* with no backstop. That is
the bug: the design removed the wrong guard. A long orchestration needs no per-node deadline;
it still needs the single forward's stream to not hang forever.

---

## 2. Ranked root causes

| # | title | kind | where | the fix |
|---|---|---|---|---|
| **R1** | Stream drain has zero timeout — a stalled CF stream hangs the turn indefinitely | **HANG** (defect) | `agent.ts:353` (drain), `326-366` (no race); unmitigated via `orch-recipes.ts:180` → `orch-resilience.ts:189` | Per-chunk **stall watchdog** (abort if no chunk for N s) **and** an outer per-turn **wall-clock cap**. §3-A. |
| **R2** | CF contention: user chat + campaign workflows share ONE service + ONE global rate-limiter clock | **CRAWL** (root of 218s) | `runtime.ts:84` (single `llm`), `runtime.ts:29-45` (shared `nextAllowed`) | Throttle/serialize concurrent callers; isolate chat from campaign load. §3-B. |
| **R3** | Over-exploration: 12 tool steps for a trivial "write a workflow?" | **CRAWL / UX** | `agent.ts:44-61` overlay; `runtime.ts:56-64` BASE_PROMPT; `runtime.ts:66` `MAX_STEPS=50` | Reorder prompt (guardrail first), steer trivial asks to a direct answer, lower `MAX_STEPS`. §3-C. |
| **R4** | Thinking-model opacity: Kimi K2.7 reasoning is wall-clock the user can't attribute | **UX** | `agent.ts` (Kimi = THINKING model); reasoning streamed live as `thinkingDelta`, final tokens at `turn.done` | Surface elapsed wall-clock + reasoning-token attribution on the spinner; optional `effort:'low'`. §3-D. |
| R5 | Rate-limiter is a global single-clock, so campaign starts push chat starts back | CRAWL (amplifier, not root) | `runtime.ts:29-41` (`nextAllowed` shared) | Working as designed (anti-thundering-herd). Tune `RLM_MAX_RPS` or go per-source; ~1s/turn of the 218s, minor. |

R1 is a latent defect (didn't fire here). R2 is what actually produced the 218s. R3+R4 are why
the turn did 12 expensive steps instead of 1.

---

## 3. The fixes, prioritized

### FIX A — kill the hang (R1) — **two guards, do both**

**A1. Per-chunk stall watchdog** (distinguishes *slow* CF from *stalled* CF — the right
granularity). At `agent.ts:352-360`, race each `iterator.next()` against an inactivity deadline
that **resets on every chunk**, so a continuous-but-slow stream is never penalised but a
dead-air stream aborts:

```ts
const STREAM_STALL_MS = Number(process.env.RLM_STREAM_TIMEOUT_MS ?? 60_000)
const it = chat.streamingForward(service, { message: msg }, opts)[Symbol.asyncIterator]()
let reply = ""
try {
  for (;;) {
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`stream stalled >${STREAM_STALL_MS}ms`)), STREAM_STALL_MS))
    const { done, value } = await Promise.race([it.next(), timeout])
    if (done) break
    const delta = (value as { delta?: { reply?: string; thought?: string } }).delta ?? {}
    if (delta.thought) emit({ kind: "thinkingDelta", text: delta.thought })
    if (delta.reply) { reply += delta.reply; emit({ kind: "replyDelta", text: delta.reply }) }
  }
} finally { await it.return?.() }   // release the CF connection on abort
```

**A2. Outer per-turn wall-clock cap** — backstop for "stream chunks forever / runaway step
loop". Apply at the Effect boundary (`agent.ts:372`, where `runForward(message)` is piped):

```ts
const TURN_TIMEOUT_MS = Number(process.env.RLM_TURN_TIMEOUT_MS ?? 600_000) // 10 min
const res = yield* runForward(message).pipe(
  (eff) => Number.isFinite(TURN_TIMEOUT_MS)
    ? Effect.timeoutFail(eff, { duration: TURN_TIMEOUT_MS, onTimeout: () => new ChatError(`turn >${TURN_TIMEOUT_MS}ms`) })
    : eff,
  …existing taps…
)
```

Why both: A1 catches a mid-stream stall in 60s (the common hang); A2 caps total turn time even
if chunks keep trickling or the tool loop runs away. Both must thread/honour the abort so the CF
HTTP actually stops, not just the JS race. Make both env-tunable, non-finite = disabled (tests).
This restores parity with the workflow/RLM/leaf paths that already do exactly this.

### FIX B — relieve contention (R2) — tuning + isolation

The 218s is CF saturation: chat and live-proof campaigns hammer one `llm` service through one
global `nextAllowed` clock. Options, cheapest first:

- **Tune now (no code):** lower concurrent campaign fan-out, or set `RLM_MAX_RPS` to match the
  real CF account ceiling so you stop self-inducing 429-adjacent slowdowns.
- **Isolate sources (code):** give campaign orchestration its own throttle / service instance so
  a background campaign can't starve an interactive chat turn. The rate-limiter caps *starts*,
  not *in-flight duration* (`runtime.ts:35-39`), so under saturation chat still queues behind
  campaign calls — splitting the clock per source fixes that.

This is the fix that actually moves the 218s number. It is a **tuning/UX phase**, not a 0.0.1
blocker.

### FIX C — stop over-exploring (R3) — prompt + step cap

- **Reorder the overlay** (`agent.ts:44-61`): the "WHEN NOT: a trivial task — DO IT DIRECTLY"
  guardrail is at line 54, *after* the WHEN-to-orchestrate patterns (lines 50-52). A thinking
  model reads the whole prompt before reasoning, so it's primed to explore. Put the guardrail
  **first**, then the patterns.
- **Add a direct-answer steer** to BASE_PROMPT: "For a trivial ask with a direct answer, answer
  in one turn; only orchestrate for genuinely independent parts or N-way redundancy."
- **Lower `MAX_STEPS`** (`runtime.ts:66`) default from 50 toward ~20-25 — 12 steps for "write a
  workflow?" is already excessive; a tighter ceiling bounds the blast radius.

### FIX D — thinking-model transparency (R4) — UX

Surface turn wall-clock + reasoning-token share on the spinner so "thinking… 218s" reads as
"reasoning + slow CF", not a freeze. Optionally default the main turn to `effort: 'low'`.

---

## 4. Campaign priority

**FIX A (the hang) is the pre-0.0.1 BLOCKER.** It is a correctness defect, not a tuning knob: a
single stalled CF stream freezes a session forever with a live-looking spinner and **no recovery
but a manual kill**. It did not fire in the 218s trace, but it is real, verified in source, and
the only CF path in the system without a timeout. ~1 hour of work; the pattern is already proven
three times over in the codebase (leaf/workflow/RLM). Ship A1 + A2 before 0.0.1.

**FIX B / C / D are a tuning + UX phase, post-blocker.** The actual 218s was a CRAWL — slow CF
under concurrent load (B) doing too many steps (C) on a thinking model whose cost is opaque (D).
Painful UX, not a defect. Sequence after A: B has the biggest wall-clock payoff, C cuts the step
count, D makes the remaining latency legible.

**Be honest about the split:** the dramatic "218s hang" headline was a *crawl* (it finished).
The genuinely dangerous thing is the *quiet* defect underneath — no stream/turn timeout on the
main path — which would produce a true, unrecoverable hang the day CF actually stalls. Fix that
first precisely because it hasn't bitten yet.
