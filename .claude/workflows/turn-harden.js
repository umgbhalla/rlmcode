export const meta = {
  name: 'turn-harden',
  description: 'Fix the stuck/crawl root causes from stuck-analysis (docs/STUCK-ANALYSIS.md). A (pre-0.0.1 BLOCKER): the main chat turn drains chat.streamingForward in a naked for-await with NO timeout — if CF stalls mid-stream the turn HANGS forever (only esc escapes); every other path (leaf 120s, workflow 300s, RLM 600s) is timeout-wrapped, only the main turn is bare. Add a per-chunk stall watchdog (resets per chunk) + an outer per-turn wall-clock cap, both abort-threaded + env-tunable. B: CF contention — the 218s actual cause (shared llm + single-clock rate limiter); tune/isolate. C: over-exploration — move the "WHEN NOT trivial" guardrail to the TOP of the overlay + a direct-answer steer + lower MAX_STEPS from 50. STRICTLY src/core (agent.ts/run.ts/runtime.ts/orch-resilience.ts) — DISJOINT from the concurrent UI workflow (src/tui). Each gated on tsc + lint + verification (A: a stalled-stream unit proves the watchdog fires + no hang), adversarial review, commit each.',
  phases: [
    { title: 'Study',  detail: 'read docs/STUCK-ANALYSIS.md + agent.ts (turn() runForward streamingForward drain ~326-366, the overlay ~44-61, MAX_STEPS), run.ts (runTurn .finally/queue.close), runtime.ts (rateLimiter/RLM_MAX_RPS), orch-resilience.ts (withTimeout — the pattern to reuse). Confirm the disjoint boundary (NO src/tui).' },
    { title: 'stall-watchdog', detail: 'A (BLOCKER): wrap the streamingForward drain in a per-chunk STALL watchdog (~60s, reset on each delta; env RLM_STREAM_STALL_MS) + an OUTER per-turn wall-clock cap (~10min; env RLM_TURN_TIMEOUT_MS), both aborting the turn (thread the existing aborter) → on stall/cap the turn returns a partial, never hangs. Unit: a mock stream that emits a chunk then NEVER closes → the turn resolves (watchdog fired), does not hang.' },
    { title: 'rate-throttle', detail: 'B: reduce CF contention — tune the rate limiter / give chat vs workflow-node CF calls separate throttles (or a sane RLM_MAX_RPS) so a normal chat turn is not starved while workflows run. Measure/reason the per-call latency improvement.' },
    { title: 'prompt-trim', detail: 'C: move the "WHEN NOT (trivial/sequential) — DO IT DIRECTLY" guardrail to the TOP of the RLM_WORKFLOW_OVERLAY (before the orchestration patterns) + add a direct-answer steer for simple asks; lower MAX_STEPS default from 50 to a saner cap (env-overridable). A trivial question should answer directly, not do 12 tool steps.' },
    { title: 'Report', detail: 'per fix: done + verified (A: the stall unit; B: latency reasoning; C: a real-CF or reasoned check a trivial Q answers in few steps); the HANG blocker closed for 0.0.1? src/tui untouched (disjoint)?' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
rlmcode turn loop (src/core). stuck-analysis (docs/STUCK-ANALYSIS.md) confirmed: the 218s was a CRAWL (contention + over-exploration), but a
real HANG defect exists — FIX it for v0.0.1. STRICTLY src/core (agent.ts/run.ts/runtime.ts/orch-resilience.ts). DO NOT touch src/tui (a concurrent
UI workflow owns it; staying in src/core keeps us disjoint — git handles disjoint-file concurrent commits).

R1 / FIX A (HIGH, pre-0.0.1 BLOCKER) — agent.ts ~326-366: turn()'s runForward does 'for await (const d of chat.streamingForward(service, ...))'
inside Effect.tryPromise with NO timeout/race/watchdog (only a user abortSignal). If CF stalls mid-stream (no more chunks, no done, no error),
runForward never resolves → run.ts ~222 .finally never runs → queue.close() never fires → the drain (run.ts ~229) never ends → replyPromise never
settles → INFINITE spinner (only esc). Every other path is timeout-wrapped (LEAF_TIMEOUT_MS 120s, workflow 300s, RLM 600s) — only the main turn is
bare (orch-recipes.ts:180 sets POSITIVE_INFINITY → orch-resilience.ts:189 skips withTimeout for non-finite; that infinity carve-out is for the
fan-out's per-node cap, but the single stream must STILL not hang). FIX: add (1) a PER-CHUNK STALL watchdog — a timer reset on every delta; if no
delta for RLM_STREAM_STALL_MS (default ~60s) → abort the turn (fire the existing aborter) → the drain ends with a partial reply ("⚠ stream stalled");
(2) an OUTER per-turn WALL-CLOCK cap RLM_TURN_TIMEOUT_MS (default ~600_000) as a backstop. Both must abort-thread (the turn's AbortController) so the
in-flight CF request is actually cancelled + the queue closes. NEVER hang. Keep good turns identical.

R2 / FIX B (the actual 218s mover) — runtime.ts rateLimiter (minIntervalRateLimiter / RLM_MAX_RPS) is a single global clock shared by chat turns
AND workflow nodes; under concurrent load every CF call is throttled to the same lane → a chat turn's 12 steps each wait. FIX: tune (a saner
RLM_MAX_RPS) and/or give the user's chat turn priority vs background workflow nodes (e.g. separate throttle lanes / a higher chat priority). Reason
or measure the per-call latency improvement. Don't over-engineer — a sane default + a knob.

R3 / FIX C (over-exploration / UX) — agent.ts RLM_WORKFLOW_OVERLAY (~44-61) front-loads orchestration patterns (78.8% of the prompt) BEFORE the
"WHEN NOT: a trivial task — DO IT DIRECTLY" guardrail (~54), so a thinking model over-explores (12 steps) on trivial asks. FIX: move the guardrail
to the TOP of the overlay; add a crisp "answer simple questions directly, do NOT fan out / read files for a trivial ask" steer; lower MAX_STEPS
default (50 → e.g. 24, env-overridable). A trivial question should answer in 1-2 steps.

PRINCIPLES: minimal correct fixes. The aborts must REALLY cancel (thread the AbortController into forward + close the queue). env-tunable knobs with
sane defaults (ponytail any fixed constant). ONE WORD vocab: node. ${CHECK} + ${LINT} green; FIX A verified by a UNIT (a mock AxAIService whose
stream emits one chunk then never closes → the turn RESOLVES via the watchdog within the bound, not a hang) — deterministic, no real CF. Commit each
--no-verify with Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT git add -A, do NOT touch src/tui. Re-confirm line
refs at Study.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'verified', 'verifyOutput', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, verified: { type: 'boolean' }, verifyOutput: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' }, checkOutput: { type: 'string' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' }, newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

phase('Study')
const study = await agent(`Read docs/STUCK-ANALYSIS.md + the code: agent.ts (turn()/runForward streamingForward drain, the RLM_WORKFLOW_OVERLAY + the trivial guardrail, MAX_STEPS), run.ts (runTurn .finally/queue.close/the drain), runtime.ts (rateLimiter/RLM_MAX_RPS), orch-resilience.ts (withTimeout pattern + the POSITIVE_INFINITY skip). Confirm EXACT lines for FIX A (stall watchdog + wall-clock cap on the drain + the abort/queue-close chain), B (rate limiter), C (overlay reorder + MAX_STEPS). Confirm all targets are src/core (NOT src/tui). Report the withTimeout/abort pattern to reuse. Cite file:line.\n\n${SPEC}`,
  { label: 'study', phase: 'Study', schema: FIND, agentType: 'Explore' })
const STUDY = JSON.stringify(study, null, 1)
log('studied turn-harden targets')

const FIXES = [
  { key: 'stall-watchdog', spec: `FIX A (BLOCKER): in agent.ts runForward, wrap/instrument the streamingForward for-await with (1) a per-chunk STALL watchdog (reset a timer on every delta; on RLM_STREAM_STALL_MS ~60s of no delta → abort the turn via the existing AbortController so forward() cancels + the loop breaks → run.ts .finally → queue.close → the turn returns a partial "⚠ stream stalled"), and (2) an OUTER per-turn wall-clock cap RLM_TURN_TIMEOUT_MS (~600_000) as a backstop (also aborts). Both must actually cancel the in-flight CF request + close the queue (no orphan). Good turns unchanged. VERIFY (unit, no real CF): a mock AxAIService whose stream yields one chunk then NEVER closes → the turn RESOLVES (watchdog fired) within the bound, NOT a hang. Paste the unit output. tsc+lint green. commit.` },
  { key: 'rate-throttle', spec: `FIX B: reduce CF contention (the 218s mover). In runtime.ts, tune the rate limiter so a chat turn isn't starved by concurrent workflow-node CF calls — either a saner RLM_MAX_RPS default, or separate throttle lanes / chat-priority vs background nodes. Keep it simple + env-tunable. VERIFY: reason (or a quick measure) the per-call latency under concurrent load improves; tsc+lint green. commit.` },
  { key: 'prompt-trim', spec: `FIX C: in agent.ts, REORDER the RLM_WORKFLOW_OVERLAY so the "WHEN NOT (trivial/sequential) → DO IT DIRECTLY" guardrail leads (before the orchestration patterns) + add a crisp "answer simple questions directly; do NOT fan out / read files / orchestrate for a trivial ask" steer; lower the MAX_STEPS default (50 → ~24, env-overridable RLM_MAX_STEPS). VERIFY: a real-CF (or carefully-reasoned) check that a trivial question ("hi" / "what is 2+2") answers in 1-2 steps, not 12; the overlay still teaches orchestration for real multi-node asks. tsc+lint green. commit.` },
]

const results = []
for (const f of FIXES) {
  if (budget.total && budget.remaining() < 70000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Fix "${f.key}" in rlmcode (src/core ONLY — do NOT touch src/tui), grounded in the study + docs/STUCK-ANALYSIS.md.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + ${LINT} green AND the verification (set verified + paste verifyOutput). Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'fix(turn): ${f.key} …'. Report sha/diff/check tail/verified/verifyOutput/new ponytails. Do NOT git add -A, do NOT touch src/tui.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `fix:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 50000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/${LINT}/verify). Fix + re-verify, commit --no-verify. src/core only.\nFAILING:\n${impl.checkOutput}\nVERIFY:\n${impl.verifyOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'really-fixed', focus: `Does it REALLY fix the root cause — A: a stalled stream now ABORTS + the turn returns (unit proves no hang, abort actually cancels + closes the queue)? B: contention reduced (chat not starved)? C: a trivial ask answers in 1-2 steps + the guardrail leads? Quote verifyOutput. Reject reasoning-only for A (the unit is required). Cite file:line.` },
    { k: 'safe-scoped', focus: `src/core ONLY (NO src/tui — disjoint)? good turns unchanged (the watchdog doesn't kill a legitimately-long but-progressing turn — it resets per chunk)? aborts really cancel + close the queue (no orphan/leak)? knobs env-tunable + ponytailed? lint+debt green? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nVERIFY:\n${impl ? impl.verifyOutput : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: verified=${impl ? impl.verified : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 50000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real, re-verify, AMEND commit. src/core only.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + still verified? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nVERIFY:\n${impl ? impl.verifyOutput : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ fix: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, verified: impl ? impl.verified : false, openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Per fix (A stall-watchdog, B rate-throttle, C prompt-trim): done + how verified (A: the stalled-stream unit — quote; B: latency; C: trivial-ask step count). Is the HANG blocker (the untimed stream drain) CLOSED for v0.0.1 — a stall can no longer freeze a turn? Did the 218s-class crawl improve (B+C)? src/tui untouched (disjoint from tui-mature)? residual.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { fixes: results, report }
