export const meta = {
  name: 'engine-verify',
  description: 'DEEP adversarial verification of the rlmcode orchestration ENGINE — do NOT trust the "core is solid" audit. Read-only + BOUNDED real-CF probes: hammer the workflow tool, RLM, budget/abort/concurrency, the one-level guard, the in-process eval boundary, error handling, and trace integrity with adversarial inputs, on the REAL committed engine. Adversarially verify each weakness (real vs noise), then synthesize a RANKED HARDENING worklist (→ the orch-engine-harden phase). Pure analysis + observation — NO source edits, NO git, safe alongside the UI workflow. Writes docs/ENGINE-HARDEN.md.',
  phases: [
    { title: 'Probe',     detail: 'parallel adversarial probers, each on a distinct engine surface — read the code AND run BOUNDED real-CF / harness probes; report weaknesses (severity, real-bug?, where, repro/evidence)' },
    { title: 'Verify',    detail: 'adversarial skeptic per weakness — is it a REAL defect (crash/hang/leak/escape/data-loss) or graceful-degradation/noise? demand a repro' },
    { title: 'Synthesize', detail: 'rank confirmed defects; write docs/ENGINE-HARDEN.md — the fix worklist for orch-engine-harden' },
  ],
}

const SPEC = `
rlmcode orchestration engine (src/core): orch.ts (5 prims: node/parallel/pipeline/emit/allocate), orch-recipes.ts (runNode/parallelLimit/
pipeline/judge/loopUntilDry), workflow.ts + workflow-prims.ts (the workflow({script}) tool — model-authored JS run IN-PROCESS via new Function),
rlm-node.ts (RLM actor over AxJSRuntime), orch-resilience.ts (retry/timeout), orch-spans.ts (trace nesting + the getTurnContext fix), runtime.ts
(llm/budget/limits/rate-limiter). The live harness: scripts/workflow-live.test.ts (RLM_LIVE=1 bun --env-file=.env scripts/workflow-live.test.ts =
'bun run live') drives the REAL workflow tool on CF Kimi.

GOAL: DO NOT TRUST the code. Adversarially probe for REAL defects — crashes, hangs, unbounded loops/cost, leaks, the one-level recursion escape,
the in-process eval reaching host globals, error-swallowing, trace fragmentation on the real streaming path, race conditions. Mix READ-ONLY code
review with BOUNDED real-CF / harness probes (prove behavior, don't just reason).

STRICT: READ-ONLY. Do NOT edit source, do NOT git. A UI workflow is concurrently editing src/tui — do NOT touch src/tui. You MAY: read any file,
run 'bun run check' (tsc), run BOUNDED real probes (e.g. a tiny RLM_LIVE workflow-tool call, or a unit harness you keep in /tmp and delete), query
motel (127.0.0.1:27686). BOUND real-CF probes HARD: tiny scripts, low fan-out (≤3), short timeouts — you are testing GRACEFUL DEGRADATION + the
HARD ceilings, NOT burning tokens. If a probe would be expensive/runaway, REASON about it from the code instead + note you didn't run it. The ONLY
write allowed is the final docs/ENGINE-HARDEN.md.

A "defect" = something that CRASHES the turn, HANGS, leaks unboundedly, escapes the one-level guard, reaches host globals it shouldn't, loses
data, or fragments the trace. A documented shortcut (a ponytail with a ceiling) or graceful degradation (a partial string on budget/timeout) is
NOT a defect — note it but don't inflate it.
`

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['surface', 'weaknesses'],
  properties: { surface: { type: 'string' }, weaknesses: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['title', 'severity', 'isRealDefect', 'where', 'evidence', 'ranReal'],
    properties: {
      title: { type: 'string' }, severity: { type: 'string', description: 'critical | high | medium | low' },
      isRealDefect: { type: 'boolean' }, where: { type: 'string' },
      evidence: { type: 'string', description: 'a repro or a precise code-path proof — not a vibe' },
      ranReal: { type: 'boolean', description: 'did you actually run a real/harness probe, or reason from code?' },
    } } } },
}
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['title', 'confirmedDefect', 'reasoning', 'fix'],
  properties: { title: { type: 'string' }, confirmedDefect: { type: 'boolean' }, reasoning: { type: 'string' }, fix: { type: 'string', description: 'the concrete fix' } },
}

const SURFACES = [
  { key: 'workflow-tool', prompt: `Hammer the workflow({script}) tool (workflow.ts + workflow-prims.ts). Read it, then BOUNDED real probes via the live harness: (a) a malformed script (syntax error) → does it return a clean error string, not crash the turn? (b) a script that throws mid-run → caught? (c) a script with a small parallel fan-out → real result? (d) a script that loops a few times accumulating → ok? Look for: unbounded loops/cost (does ANYTHING stop a 'while(true)' script besides the HARD budget? is the HARD ceiling actually enforced?), the new Function eval reaching process.env/globalThis/require (the B3 concern — PROVE what a script body can reach), error swallowing. Report defects with repro.` },
  { key: 'rlm', prompt: `Hammer rlm-node.ts (the RLM actor). Read it, then bounded real probes: (a) rlm on a tiny blob with a clear answer → returns it? (b) rlm on an EMPTY/no-match blob → graceful (not crash/hang)? (c) the AxJSRuntime sandbox — can the executor reach require/import/fs (it shouldn't)? Look for: hangs (the timeout actually fires?), the sandbox boundary, error→partial. Report with evidence.` },
  { key: 'budget-abort-concurrency', prompt: `Read orch.ts (allocate/Budget/BudgetExhaustedError), orch-recipes.ts (parallelLimit/MAX_CONCURRENCY), runtime.ts (rateLimiter). Probe/reason: (a) does the SOFT budget only nudge (never discard a completed node) + HARD actually throw→partial? (b) does parallelLimit truly cap concurrency (a 100-thunk parallel runs ≤cap at once)? (c) does abortSignal thread into every node forward (a cancelled turn stops in-flight CF)? (d) any race in the budget charge / the holder-object reducers? Look for: leaks (the turnCtx/turnEmits Maps growing), races, abort not propagating. Report with code-path evidence.` },
  { key: 'one-level-guard', prompt: `Prove the ONE-LEVEL recursion guard: a workflow/RLM node's gen carries BASE_TOOLS only (never the workflow tool), so a script CANNOT spawn a script. Read agent.ts CHAT_TOOLS + workflow-prims node construction + rlm-node. Can a sub-agent node EVER reach the workflow tool (structural, not a depth counter)? Try (read-only/reason) to construct an escape. Report if the guard can be bypassed (critical) or is sound.` },
  { key: 'error-trace-integrity', prompt: `(a) ERROR HANDLING: force errors — a tool that errors, a CF-style failure (read the mock fail path + the real catchCause) → does the turn surface a "⚠ …" partial, never crash? Read run.ts/agent.ts catchCause + finalizeOnMaxSteps. (b) TRACE INTEGRITY: run a real workflow turn (or read recent motel traces) → is chat.session→turn→workflow→nodes ONE trace (the getTurnContext fix holding on the streaming for-await path)? Any orphan/fragmented spans? Query motel /api/traces + spans. Report with trace ids / evidence.` },
]

phase('Probe')
const probes = (await parallel(SURFACES.map(s => () =>
  agent(`DEEP ADVERSARIAL probe — surface "${s.key}". DO NOT trust the code. ${s.prompt}\n\nMix read-only code review with BOUNDED real/harness probes (set ranReal honestly). Return weaknesses (severity, isRealDefect, where file:line, evidence=a repro or precise code-path). NO source edits.\n\n${SPEC}`,
    { label: `probe:${s.key}`, phase: 'Probe', schema: FINDINGS, agentType: 'Explore' })
))).filter(Boolean)
const all = probes.flatMap(p => (p.weaknesses || []).map(w => ({ ...w, surface: p.surface })))
log(`probe: ${all.length} weaknesses; ${all.filter(w => w.isRealDefect).length} flagged real`)

phase('Verify')
const toVerify = all.filter(w => w.isRealDefect || w.severity === 'critical' || w.severity === 'high')
const verdicts = (await parallel(toVerify.map(w => () =>
  agent(`Adversarially verify this claimed engine DEFECT — REAL or graceful-degradation/documented-shortcut/noise? Read the cited code yourself; if it claims a repro, sanity-check it. A documented ponytail-ceiling or a partial-on-budget/timeout is NOT a defect; a crash/hang/unbounded-cost/one-level-escape/host-global-reach/data-loss IS. Default to NOT-a-defect if uncertain. Give the concrete fix if real.\nWEAKNESS: ${w.title}\nWHERE: ${w.where}\nEVIDENCE: ${w.evidence}\nRAN REAL: ${w.ranReal}\n\n${SPEC}`,
    { label: `verify:${(w.title || '').slice(0, 30)}`, phase: 'Verify', schema: VERDICT, agentType: 'Explore' })
))).filter(Boolean)
const confirmed = verdicts.filter(v => v.confirmedDefect)
log(`verify: ${confirmed.length}/${toVerify.length} confirmed defects`)

phase('Synthesize')
const report = await agent(
  `Synthesize the engine adversarial-verification (blunt, terse, markdown) AND write docs/ENGINE-HARDEN.md (this ONE additive write only — NOT src, NOT git). Structure: (1) headline — how many CONFIRMED real defects (crash/hang/leak/escape/data-loss) vs graceful/documented. (2) CONFIRMED DEFECTS ranked (title · where · repro · the fix) — these feed orch-engine-harden. (3) the one-level guard + in-process eval boundary verdict (sound or escapable — quote the proof). (4) trace integrity verdict (one-trace or fragmented — trace ids). (5) what was REASONED-only vs RAN-real (honesty about coverage). Don't inflate documented shortcuts into defects.\n\nWEAKNESSES:\n${JSON.stringify(all, null, 1)}\n\nVERDICTS:\n${JSON.stringify(verdicts, null, 1)}`,
  { label: 'synthesize', phase: 'Synthesize', agentType: 'general-purpose' })
return { weaknesses: all.length, confirmedDefects: confirmed.length, report }
