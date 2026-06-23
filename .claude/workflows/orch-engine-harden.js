export const meta = {
  name: 'orch-engine-harden',
  description: 'FIX the confirmed orchestration-engine defects from engine-verify (docs/ENGINE-HARDEN.md): D2 runScript has no timeout → an infinite/CPU-bound script hangs the turn; D3 turnCtx/turnEmits/turnAborters Maps leak (never cleared on session close); D4 runRlm can throw past its "answer always returned" contract; D1 the in-process workflow eval reaches process.env/globalThis while the comment/tool-desc falsely claim "ONLY prims in scope" (honest-docs fix for 0.0.1 — it is <= the bash tool; the AxJSRuntime isolate is the post-0.0.1 upgrade). STRICTLY src/core ENGINE files only (workflow.ts/workflow-prims/runtime.ts/orch-spans.ts/rlm-node.ts/sessions.ts/agent.ts + SECURITY.md) — DISJOINT from the concurrent UI workflow which owns src/tui. Each fix gated on tsc + lint + (runtime fixes) the live workflow proof + a unit test, adversarial review, commit each.',
  phases: [
    { title: 'Study',   detail: 'read docs/ENGINE-HARDEN.md + the cited code (workflow.ts/workflow-prims/runtime.ts/orch-spans.ts/rlm-node.ts/sessions.ts/agent.ts); confirm exact line refs + the disjoint-file boundary (do NOT touch src/tui)' },
    { title: 'timeout', detail: 'D2+D5: wrap runScript in a wall-clock timeout (the workflow tool has no withTimeout though nodes do) → an infinite/CPU-bound script returns a partial+timeout, never hangs the turn' },
    { title: 'leak',    detail: 'D3: export clearTurn helpers (turnCtx in orch-spans, turnEmits in runtime, turnAborters in agent) + call them from sessions.ts deleteSession (and turn-end) so the per-session Maps do not grow unboundedly' },
    { title: 'rlm-contract', detail: 'D4: wrap runRlm so a thrown executor/forward error returns an empty partial string (honor the "answer always returned" contract); protect the bare caller' },
    { title: 'eval-honesty', detail: 'D1: fix the FALSE "ONLY prims in scope" claim — the workflow.ts comment + the tool description + the agent.ts overlay + SECURITY.md must state the script body runs in-process with host access (<= the bash tool already exposed); ponytail the AxJSRuntime-isolate upgrade' },
    { title: 'Report',  detail: 'per defect: fixed + how verified (live/unit/tsc); re-confirm the engine-verify repros no longer reproduce; residual' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const LIVE = 'RLM_LIVE=1 bun --env-file=.env scripts/workflow-live.test.ts'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
rlmcode orchestration engine (src/core). engine-verify confirmed these defects (docs/ENGINE-HARDEN.md) — FIX them for v0.0.1. STRICTLY src/core
engine files + SECURITY.md. DO NOT TOUCH src/tui — a concurrent UI workflow (tui-mature) owns it; staying in src/core keeps us disjoint (git
handles disjoint-file concurrent commits to main). Do NOT touch chat.tsx/messages.tsx/composer.tsx/toolui.ts/palette.tsx/etc.

DEFECTS:
- D2 (HIGH) workflow.ts:109-113 — runScript runs the model-authored body with NO timeout (nodes have withTimeout via orch-resilience, the script
  body does not). An infinite or CPU-bound pure-JS script HANGS the turn. FIX: race runScript against a wall-clock timeout (a sane ceiling, env-
  overridable e.g. RLM_WORKFLOW_TIMEOUT_MS); on timeout return a partial string ("workflow timed out after Ns"), never hang. This also covers D5
  (the token budget is blind to CPU runaway — a wall-clock cap is the backstop a token ceiling can't be).
- D3 (HIGH) leak — turnCtx (orch-spans.ts ~58), turnEmits (runtime.ts ~114), turnAborters (agent.ts ~208) are module Maps keyed by sessionId that
  are SET per turn but NEVER deleted; sessions.ts deleteSession (~36) only drops sessionsRT. FIX: export clearTurnContext/clearTurnEmit (+ a
  turnAborters delete) and call them from deleteSession so closing a session frees its entries (and optionally clear stale per-turn entries at
  turn end). Prove with a unit (set N sessions, delete, assert the Maps shrank).
- D4 (MED) rlm-node.ts:219-225 — runRlm has no try/catch around the executor/forward, so a throw escapes past its "answer is ALWAYS returned"
  contract (the bare caller telemetry-live.test.ts:93 is unprotected). FIX: wrap; on error return an empty/partial answer string + log, never throw.
- D1 (HIGH, honesty) workflow.ts:48-66 + the tool description + the agent.ts orchestration overlay + SECURITY.md — the comment claims the script
  body sees "ONLY the prims in scope", but a new Function body CAN reach process.env/globalThis (engine-verify read env vars for real). The
  AUTHORITY is fine (<= the unsandboxed bash tool the agent already has — no NEW capability), but the CLAIM is false → fails the honest-docs bar.
  FIX (0.0.1): correct the comment + tool-desc + overlay to state the script runs IN-PROCESS with host access (bounded only by the budget/timeout,
  <= bash); add/extend a SECURITY.md line naming process.env reachability; ponytail the real isolate: 'ponytail: in-process new Function reaches
  host globals (<= bash); Upgrade: run the script in an AxJSRuntime isolate with prims as host globals (proven in rlm-node.ts)'. Do NOT build the
  isolate now (big; out of 0.0.1 scope; the user wanted the simple in-process model — just make the docs HONEST + bounded).

PRINCIPLES: minimal, correct fixes (ponytail: any unavoidable shortcut with a ceiling + upgrade). Keep the workflow tool's behavior identical for
good scripts (only add the timeout/honesty). ONE WORD vocab: node. ${CHECK} + ${LINT} green; the runtime fixes (D2/D4) verified with the LIVE
proof (${LIVE}) + a unit where it fits; D3 with a unit. Commit each --no-verify with Co-Authored-By: Claude Opus 4.8 (1M context)
<noreply@anthropic.com>. Do NOT git add -A. Re-confirm line refs at Study (concurrent churn on src/tui won't move these, but verify).
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
const study = await agent(`Read docs/ENGINE-HARDEN.md + the cited engine code: workflow.ts + workflow-prims.ts (runScript + the budget), runtime.ts (turnEmits + budget charge), orch-spans.ts (turnCtx), rlm-node.ts (runRlm), agent.ts (turnAborters + the overlay + setTurnContext call), sessions.ts (deleteSession), SECURITY.md, orch-resilience.ts (the existing withTimeout to mirror). Confirm EXACT line refs for each fix + that all targets are src/core (NOT src/tui — the disjoint boundary). Report the withTimeout pattern to reuse + where each clearTurn call goes. Cite file:line.\n\n${SPEC}`,
  { label: 'study', phase: 'Study', schema: FIND, agentType: 'Explore' })
const STUDY = JSON.stringify(study, null, 1)
log('studied engine-harden targets')

const FIXES = [
  { key: 'timeout', live: true, spec: `D2+D5: wrap workflow.ts runScript in a wall-clock timeout (reuse the withTimeout shape from orch-resilience.ts; ceiling env-overridable RLM_WORKFLOW_TIMEOUT_MS, sane default e.g. 300_000). On timeout the tool returns a partial string ("workflow timed out after Ns — partial"), the turn NEVER hangs. Keep good scripts identical. VERIFY: a live (or unit) probe — a script with 'while(true){}' (or a long sleep loop) returns the timeout partial within the ceiling, not a hang; a normal script still works. tsc+lint green. commit.` },
  { key: 'leak', live: false, spec: `D3: export clearTurnContext (orch-spans.ts), clearTurnEmit (runtime.ts), and a turnAborters delete (agent.ts) — then call all three from sessions.ts deleteSession(sessionId) so closing a session frees its per-session Map entries. (Optionally also clear a turn's entry at turn end if safe.) VERIFY with a unit test (scripts/): create N sessions (set the Maps), deleteSession, assert the Maps no longer hold those ids. tsc+lint green. commit.` },
  { key: 'rlm-contract', live: false, spec: `D4: wrap rlm-node.ts runRlm's executor/forward in try/catch so a thrown error returns an empty/partial answer string (+ a logged note), honoring the "answer is ALWAYS returned" contract — never throw to the caller. Protect the bare caller path too. VERIFY: a unit/probe where the forward throws → runRlm resolves a string (not a rejection). tsc+lint green. commit.` },
  { key: 'eval-honesty', live: false, spec: `D1: make the in-process eval docs HONEST. Fix the false "ONLY the prims in scope" claim in workflow.ts (the runScript comment + the tool description string) + the agent.ts orchestration overlay wording → state the script body runs IN-PROCESS with host access, bounded by budget + the new timeout, and is <= the bash tool the agent already has (no NEW authority). Extend SECURITY.md with a line naming process.env/globalThis reachability from a workflow script. Add the ponytail: 'in-process new Function reaches host globals (<= bash); Upgrade: AxJSRuntime isolate with prims as host globals (per rlm-node.ts)'. Do NOT build the isolate. VERIFY: tsc+lint+debt green; grep proves the false claim is gone + the ponytail + SECURITY line exist. commit.` },
]

const results = []
for (const f of FIXES) {
  if (budget.total && budget.remaining() < 70000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Fix "${f.key}" in the rlmcode ENGINE (src/core only — do NOT touch src/tui), grounded in the study + docs/ENGINE-HARDEN.md.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + ${LINT} green${f.live ? ` AND a real verification (${LIVE} or a unit) — set verified + paste verifyOutput proving the defect's repro no longer reproduces` : ' AND a unit verification — set verified + paste verifyOutput'}. Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'fix(orch): ${f.key} …'. Report sha/diff/check tail/verified/verifyOutput/new ponytails. Do NOT git add -A, do NOT touch src/tui.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `fix:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 50000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/${LINT}/verify). Fix + re-verify, commit --no-verify. src/core only.\nFAILING:\n${impl.checkOutput}\nVERIFY:\n${impl.verifyOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'really-fixed', focus: `Does the fix REALLY close the defect — the engine-verify repro no longer reproduces (quote verifyOutput)? D2: an infinite script returns a timeout partial, not a hang. D3: the Maps actually shrink on deleteSession. D4: runRlm returns a string on a thrown forward. D1: the false claim is gone + SECURITY/ponytail honest. Reject reasoning-only where a probe is feasible. Cite file:line.` },
    { k: 'safe-scoped', focus: `src/core ONLY (NO src/tui touched — the disjoint boundary)? good-script behavior unchanged? no new defect introduced? ponytail correct (D1 names the isolate upgrade)? lint+debt green? Cite file:line.` },
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
  `Final report (blunt, terse, markdown) on the engine hardening. Per defect (D2 timeout, D3 leak, D4 rlm-contract, D1 eval-honesty): FIXED + how verified (the engine-verify repro no longer reproduces — quote)? Then: are the 4 confirmed HIGH/MED engine defects from docs/ENGINE-HARDEN.md now closed for v0.0.1? residual / anything red. Confirm src/tui was NOT touched (disjoint).\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { fixes: results, report }
