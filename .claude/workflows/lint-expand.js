export const meta = {
  name: 'lint-expand',
  description: 'BUILD the approved rlmcode lint rework (grounded in .research/lint-proposal.md). Wave 1: turn on @effect/language-service diagnosticSeverity (ERROR tier + side-effect bans ERROR in src/core, OFF at the app/tui/otel edge) + run it headless in `check`; add tsconfig strict flags (noUncheckedIndexedAccess first); add oxlint as a per-statement gate. Wave 2: replace design-check.ts FIXED budgets with the DYNAMIC rubric (role x export-fan x git-churn x density, rustc ERROR/WARN tiers) + extend the mutate rule to any module-scope let/var write in core + design-check.test.ts fixtures. Wave 3: bun run debt:audit (churn-ranked ponytail-audit, advisory) + AGENTS.md policies (test-rewrite-on-bump, mock-first hermetic gate, the new gate philosophy) + 0.0.2 version bump + CHANGELOG. Each step self-heals to a GREEN gate, gets a 2-lens adversarial review (correctness + no-false-positive-flood / gate-still-meaningful), commits alone --no-verify. STRICTLY lint-infra: tsconfig.json, scripts/design-check.ts(+test), .oxlintrc.json, package.json, AGENTS.md, CHANGELOG.md, sdk.ts/otel.ts version + whatever src/ fixes the new diagnostics force. Do NOT git add -A.',
  phases: [
    { title: 'Study' }, { title: 'effect-ls' }, { title: 'tsconfig' }, { title: 'oxlint' },
    { title: 'dynamic-budgets' }, { title: 'debt-audit' }, { title: 'agents-md' }, { title: 'release' }, { title: 'Report' },
  ],
}

const ROOT = '/Users/umang/hub/ax2'
const CHECK = 'bun run check'
const LINT = 'bun run lint'
const MAX_HEAL = 6
const MAX_HARDEN = 2

const SPEC = `
You are reworking the rlmcode lint/quality gate per the APPROVED proposal at ${ROOT}/.research/lint-proposal.md (READ IT — it has the exact severity lists, the oxlintrc, the dynamic-budget formula, and the AGENTS.md wording). Decisions locked by the user: build all waves; ADD oxlint; the effect-LS side-effect bans are ERROR inside src/core/ and OFF at the edge (src/app/, src/tui/, src/otel.ts).

CONTEXT: today's gate = \`bun run lint\` = check (tsc --noEmit) + test (hermetic) + analyze (scripts/design-check.ts, FIXED CC=20/nest=8/size=300|500) + debt (scripts/ponytail-debt.ts). @effect/language-service is ALREADY a devDep + loaded in tsconfig but sets NO diagnosticSeverity (enforces nothing). rlmcode core is Effect v4 / effect-smol. Baseline is clean: 0 module-scope let/var.

PRINCIPLES (rustc model): every rule lands at a TIER — ERROR blocks the gate, WARN is surfaced+counted but non-blocking, OFF. Stage diagnostics by tier; do NOT flip all ~98 effect-LS checks to error blindly — use the proposal's ERROR/WARN/OFF split. Ref/SubscriptionRef are SANCTIONED (never ban Effect's reactive primitives). Keep yuku (cross-file reachability + crosscore boundary + write-flow) AND oxlint (per-statement) AND effect-LS (Effect idioms) as COMPLEMENTARY layers — do not remove any.

HARD RULES: TypeScript strict stays; never relax a flag to silence an error — FIX the underlying code. Fixing effect-LS ERRORs means real refactors (floatingEffect, leakingRequirements, side-effects → Clock/Random/Config) — do them properly, keep behavior identical, prove with the existing test/test:tui suites. design-check.ts thresholds live as NAMED consts at the top, tunable only with a reason. Per step: ${CHECK} green AND (where touched) ${LINT} green AND the existing hermetic test suite green. Commit each step ALONE with --no-verify, Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT git add -A (concurrent sessions' dirty files exist) — add only the files this step changed. Report sha + a tight diff summary + the gate output tail + new ponytails.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'risks'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } } } }
const IMPL = { type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'gateOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string', description: "'green' only when the step's gate passes for real (reproduced), else 'red'" },
    filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' }, gateOutput: { type: 'string', description: 'the reproduced gate command + its output tail proving green' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' }, newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  } }
const REVIEW = { type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } } }

phase('Study')
const study = await agent(`Read ${ROOT}/.research/lint-proposal.md IN FULL + the current rlmcode lint infra (tsconfig.json, scripts/design-check.ts, scripts/ponytail-debt.ts, package.json scripts, the effect-LS prepare patch). Confirm: (1) where diagnosticSeverity goes + whether effect-LS supports PER-DIRECTORY severity (ERROR core / OFF edge) — if not, the fallback is a separate tsconfig for core OR WARN-global for the side-effect detectors (report which is feasible); (2) the headless effect-language-service diagnostics CLI invocation that actually exits non-zero; (3) design-check.ts's current budget consts + the AST walk + the --staged git read (where churn hooks in); (4) the oxlint install + .oxlintrc wiring. Report facts + cites + risks (esp. how big the effect-LS ERROR fallout in src/core is likely to be).\n\n${SPEC}`,
  { label: 'study', phase: 'Study', schema: FIND, agentType: 'Explore' })
const STUDY = JSON.stringify(study, null, 1)
log('studied lint infra + proposal')

const STEPS = [
  { key: 'effect-ls', spec: `Turn on @effect/language-service enforcement (proposal a.2 — the biggest lever). Set diagnosticSeverity in tsconfig.json per the proposal's ERROR tier (floatingEffect, missingEffectContext/Error, missingStarInYieldEffectGen, missingReturnYieldStar, effectFnImplicitAny, anyUnknownInErrorContext, tryCatchInEffectGen, catchUnfailableEffect, effectGenUsesAdapter, runEffectInsideEffect, leakingRequirements, multipleEffectProvide, strictEffectProvide, returnEffectInGen, missingEffectServiceDependency, missingLayerContext, unsupportedServiceAccessors, classSelfMismatch) and the WARN tier (serviceNotAsClass, effectFnOpportunity, effectDoNotation, missedPipeableOpportunity, unnecessaryPipe, unnecessaryEffectGen, nestedEffectGenYield, strictBooleanExpressions, preferSchemaOverJson). The side-effect detectors (asyncFunction, globalDate/globalDateInEffect, globalRandom/globalRandomInEffect, globalTimersInEffect, processEnvInEffect, newPromise, cryptoRandomUUIDInEffect, extendsNativeError, schemaSyncInEffect, lazyPromiseInEffectSync) = ERROR in src/core/, OFF at the edge (src/app/, src/tui/, src/otel.ts) — implement per-directory if effect-LS supports it (e.g. a core-scoped tsconfig the check runs), ELSE per the Study's feasible fallback (and note it). Wire the headless CLI into the \`check\` script: \`tsc --noEmit && effect-language-service diagnostics --project tsconfig.json\` (confirm the exact flag that exits non-zero). Then FIX every ERROR-tier diagnostic in src/ for real (proper Effect refactors — Clock/Random/Config for side-effects, fix floating/leaking effects) keeping behavior identical; the hermetic test suite + test:tui must stay green. Gate: ${CHECK} green (now including effect-LS) + bun run test green.` },
  { key: 'tsconfig', spec: `Add the tsconfig strict flags (proposal a.1): noUncheckedIndexedAccess FIRST (it surfaces real undefined-access bugs in runtime.ts/orch*.ts — fix each properly, don't blanket non-null-assert), then noUncheckedSideEffectImports, erasableSyntaxOnly, isolatedModules, noImplicitOverride, noFallthroughCasesInSwitch, moduleDetection:force. Fix all fallout for real. Gate: ${CHECK} green + bun run test green.` },
  { key: 'oxlint', spec: `Add oxlint as a NEW per-statement gate (proposal a.3). \`bun add -d oxlint\`. Write .oxlintrc.json EXACTLY per the proposal (categories correctness/suspicious/perf=error; rules no-var, no-param-reassign, consistent-type-imports inline, no-import-type-side-effects, import/no-duplicates, import/no-cycle, array-type generic; no-console=warn; KEEP OFF: no-explicit-any, no-namespace, no-non-null-assertion, ban-ts-comment, no-shadow). Add an \`oxlint\` script (oxlint over src/ + scripts/) and wire it into the \`lint\` script (after check, before/with analyze). Fix every ERROR hit for real. Gate: bun run oxlint clean + ${CHECK} + bun run test green.` },
  { key: 'dynamic-budgets', spec: `Replace the FIXED budgets in scripts/design-check.ts with the DYNAMIC rubric (proposal b). Add a churn map (one \`git log --since='90 days ago' --name-only --pretty=format: -- <path>\` parsed to Map<path,count>). Compute per-file: role∈{barrel,core,app,tui,script}; export_fan (Exported symbols, already iterated); import_fan (edges, already built); density (cc/effective_loc per fn). SIZE budget = size_base{barrel250,core450,app450,tui550,script600} + min(150, export_fan*20), ×0.8 when hot (churn>=8 && lines>=0.7*raw). CC budget = cc_base{core12,app14,tui18,script16,barrel8} − 2 when hot+branchy; nest = 6 + floor(async_depth/2) cap 8; density>0.15 → WARN. Tiers: over-budget=ERROR (blocks); within-10% / density>0.15 / hotspot=WARN (surfaced, non-blocking). Keep --staged blocking model. ALSO extend the \`mutate\` finding to flag ANY module-scope let/var with >=1 write in src/core/ (loop-local let in a fn body stays allowed). All constants NAMED at top. Add design-check.test.ts fixture cases for the rubric (role-scaled size/CC, churn squeeze, density WARN, the new mutate rule). Re-tune so current src/ is GREEN at the ERROR tier (no false-positive flood; WARNs are fine). Gate: bun run analyze (exit 0, WARNs ok) + bun run test (incl. design-check.test) green + ${CHECK} green.` },
  { key: 'debt-audit', spec: `Add the advisory debt audit (proposal d). A new \`bun run debt:audit\` script that computes the churn-ranked candidate list (reuse the churn map approach) and emits a priority-sorted file list (priority = rough size/complexity × churn) for the ponytail-audit pass — a CLI cannot call an LLM, so the script is the DETERMINISTIC churn-ranking + it writes/refreshes docs/DEBT-AUDIT.md scaffolding; the actual /ponytail-audit semantic scan is an AGENT process step documented in AGENTS.md (next step). debt:audit is ADVISORY — never wired into the blocking \`lint\` script, never exits non-zero on findings. Gate: bun run debt:audit runs clean + ${CHECK} green. Keep scripts/ponytail-debt.ts (the blocking marker gate) unchanged.` },
  { key: 'agents-md', spec: `Update AGENTS.md (proposal e + the gate philosophy). Add: (e.1) test-rewrite-on-bump policy (version bump of rlmcode or a load-bearing dep = DELETE + rewrite all tests end-to-end, no inline patching; mock-first happy-path + one edge per behavior); (e.2) mock-first hermetic gate (lint/test/test:tui = zero network/zero live AI via RLM_MOCK; live only in the separate bun run live). Update the static-analysis section + the gate table to reflect the reworked lint (check now includes effect-LS; oxlint is a new layer; analyze is dynamic-budget + rustc ERROR/WARN tiers; debt:audit advisory). Document: the rustc tier model, the dynamic-budget rubric rationale (role×fan×churn×density), the Effect-driven mandate (mutable-state ban, side-effects→edge, Ref sanctioned), and that when the AGENT runs lint it ALSO runs the /ponytail-audit skill (advisory). Keep AGENTS.md accurate to what shipped. Gate: ${CHECK} green (doc-only, but confirm nothing else drifted).` },
  { key: 'release', spec: `Finalize. Run the FULL ${LINT} + bun run test:tui + bun run sdk:smoke — all GREEN (fix any residual). Bump version 0.0.1 → 0.0.2 in package.json, src/core/sdk.ts (RLM_VERSION), src/otel.ts (SERVICE_VERSION). Add a CHANGELOG.md v0.0.2 section documenting the lint rework (effect-LS enforcement, tsconfig flags, oxlint, dynamic budgets, debt:audit, the AGENTS.md policies). Do NOT git tag (the tag is the human-controlled action). Gate: full ${LINT} + test:tui + sdk:smoke all green; version consistent at 0.0.2.` },
]

const results = []
for (const s of STEPS) {
  if (budget.total && budget.remaining() < 120000) { log(`budget low — stop before ${s.key}`); break }
  phase(s.key)
  let impl = await agent(
    `Implement lint-rework step "${s.key}" in rlmcode. READ ${ROOT}/.research/lint-proposal.md for exact detail.\n\nSTEP SPEC:\n${s.spec}\n\nWhen the step's gate is GREEN (reproduced — paste the command + output tail in gateOutput, NOT compile-only claims), COMMIT alone --no-verify 'chore(lint): ${s.key} …' (or feat/fix as fits). Self-heal up to ${MAX_HEAL} times. Add only the files this step changed (NO git add -A).\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${s.key}`, phase: s.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 80000)) {
    heal++; log(`${s.key}: heal ${heal}`)
    impl = await agent(`"${s.key}" gate is RED. Fix for real (no flag-relaxing to silence errors — fix the code) + re-verify the gate green (reproduce it), commit --no-verify.\nGATE OUTPUT:\n${impl.gateOutput}\nNOTES:\n${(impl.notes || []).join(' | ')}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${s.key}:${heal}`, phase: s.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'correct', focus: `Is "${s.key}" CORRECT + behavior-preserving? effect-LS/oxlint/tsconfig fixes are real refactors (not flag-relaxing / blanket // oxlint-disable / non-null-assertion spam to silence)? The hermetic test + test:tui still pass? For dynamic-budgets: the rubric math matches the proposal + the constants are named? Reproduce the gate. Cite file:line.` },
    { k: 'meaningful', focus: `Does the gate still MEAN something — no false-positive flood downgraded to nothing, no rule turned OFF to dodge real work, yuku/effect-LS/oxlint all still active + complementary, ERROR vs WARN tiers as the proposal specifies, Ref/SubscriptionRef NOT banned, side-effect bans ERROR in core / OFF at edge as decided? No accidental scope creep outside lint-infra. Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed lint step "${s.key}". Demand a reproduced gate. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nGATE:\n${impl ? impl.gateOutput : ''}\n\nPROPOSAL is at ${ROOT}/.research/lint-proposal.md.\n${SPEC}`,
      { label: `review:${s.key}:${l.k}`, phase: s.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${s.key}: blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 80000)) {
    hr++; log(`${s.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in lint step "${s.key}". Fix for real, re-verify the gate green, AMEND the commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `harden:${s.key}:${hr}`, phase: s.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${s.key}"; blockers closed + gate still green? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nGATE:\n${impl ? impl.gateOutput : ''}\n\n${SPEC}`,
        { label: `reverify:${s.key}:${l.k}:${hr}`, phase: s.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ step: s.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, files: impl ? impl.filesChanged : [], openBlockers: blockers, ponytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Per step (effect-ls/tsconfig/oxlint/dynamic-budgets/debt-audit/agents-md/release): green? committed (sha)? gate reproduced? open blockers? Then: is the lint gate now the proposed rustc-tiered system — effect-LS enforcing, oxlint layered, dynamic budgets live, debt:audit advisory, AGENTS.md policies in? What effect-LS/tsconfig fallout got fixed in src/? Residual / any RED / any rule parked at WARN that should become ERROR later.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { steps: results, report }
