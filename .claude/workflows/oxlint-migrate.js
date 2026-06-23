export const meta = {
  name: 'oxlint-migrate',
  description: 'Add oxlint as rlmcode\'s fast JS-rule lint layer (the one thing the lint chain lacks). rlmcode lints via tsc-strict + @effect/language-service (types + Effect patterns), yuku/design-check (dead code, cycles, CC/nesting budgets), and ponytail-debt — but NO general JS-rule linter. oxlint COMPLEMENTS (does not replace) these: catch no-floating-promise / no-unused / eqeqeq / no-await-in-loop / react-hooks / no-explicit-any-where-avoidable, etc. STAGED — touches package.json + src/+scripts/ (violation fixes) → run AFTER the concurrent src workflows (tui-mature, turn-harden) land to avoid clobber. Steps: inventory (read-only oxlint run + pick the ruleset that fits Bun/TS/React/opentui/Effect), install+config (.oxlintrc.json), wire into bun run lint, fix the violations (real fixes, not blanket-disable), report. Each gated on tsc + the other lint layers staying green, adversarial review, commit each.',
  phases: [
    { title: 'Study',   detail: 'HARD DEP: confirm tui-mature + turn-harden landed (src + package.json stable). Run `bunx oxlint src scripts` READ-ONLY to inventory violations; categorize (real bugs vs noise vs rules that fight opentui/Effect/Bun). Decide the ruleset + which to enable/disable. Cite counts.' },
    { title: 'config',  detail: 'bun add -d oxlint + write .oxlintrc.json tuned for Bun + TS + React(opentui) + Effect: enable correctness + suspicious + the react/hooks rules; disable style nits + rules that clash (e.g. allow the documented `as any` ponytails, opentui JSX patterns); set the env/globals. tsc + existing lint stay green.' },
    { title: 'wire',    detail: 'add an `oxlint` script + fold it into `bun run lint` as a layer (after check, alongside analyze/debt — keep tsc/yuku/debt; oxlint is additive). Document the 4-layer lint in AGENTS.md.' },
    { title: 'fix',     detail: 'fix the real violations oxlint flags across src/ + scripts/ — REAL fixes (handle the floating promise, remove the unused, tighten the any) NOT blanket eslint-disable; only suppress with a justified inline reason (or a ponytail) where a rule genuinely mis-fits. Iterate until `oxlint` is clean + tsc + yuku + debt + test all green.' },
    { title: 'Report',  detail: 'oxlint green + what real bugs it caught + the final 4-layer lint chain; any rules disabled (with why); residual' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
rlmcode = Bun + TypeScript (strict), opentui REACT UI (src/tui), Effect v4 core (src/core), @ax-llm/ax. CURRENT lint (bun run lint) = check
(tsc --noEmit + @effect/language-service) + test (hermetic suite) + analyze (yuku-analyzer/design-check.ts: dead exports, cycles, CC/nesting/param
budgets) + debt (ponytail markers). NO general JS-rule linter. GOAL: ADD oxlint (https://oxc.rs) as a fast JS-rule layer — it COMPLEMENTS the
above (tsc=types, yuku=design, debt=markers, oxlint=JS-bug rules), does NOT replace them.

STRICT TIMING: this touches package.json (devDep + the lint script) + src/+scripts/ (violation fixes) → it MUST run AFTER the concurrent src
workflows (tui-mature on src/tui, turn-harden on src/core) have LANDED (HARD DEP check at Study — STOP if src/package.json look mid-flight/dirty
with their work). Otherwise we clobber.

WHAT oxlint ADDS (the high-value rules tsc/yuku miss): no-floating-promises / no-misused-promises (Effect + async — careful, Effect has its own
patterns), no-unused-vars (beyond tsc's noUnusedLocals — catches more), eqeqeq, no-await-in-loop (perf), no-constant-condition, react-hooks rules
(opentui React — exhaustive-deps, rules-of-hooks), no-debugger, no-console-where-inappropriate, prefer-const, etc. DISABLE/tune what fights the
codebase: the documented 'as any' ponytails (don't fail on those — they're justified + marked), opentui JSX element patterns, Effect's generator/
yield* patterns, bun globals. Use the oxlint categories (correctness, suspicious, perf, restriction) — enable correctness+suspicious, cherry-pick
the rest. .oxlintrc.json with the right env (es2024, bun) + globals.

FIX DISCIPLINE: fix the REAL violations (await the floating promise, delete the unused, narrow the any, add the missing hook dep) — do NOT blanket
'// oxlint-disable'. Suppress ONLY with a one-line justified reason where a rule genuinely mis-fits the opentui/Effect idiom (or a ponytail). The
point is to CATCH real bugs, not paper them. Keep tsc + yuku + debt + test green throughout. Document the 4-layer lint in AGENTS.md.

PRINCIPLES: minimal config + real fixes. ONE WORD vocab: node. Commit each step --no-verify with Co-Authored-By: Claude Opus 4.8 (1M context)
<noreply@anthropic.com>. Do NOT git add -A. The fix step CAN touch src/tui + src/core (the workflows have landed by then — re-confirm clean).
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'depLanded'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } }, depLanded: { type: 'boolean' } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'oxlintClean', 'realBugsCaught', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'rulesDisabled', 'notes'],
  properties: {
    status: { type: 'string' }, oxlintClean: { type: 'boolean' }, realBugsCaught: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' }, checkOutput: { type: 'string' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' }, rulesDisabled: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

phase('Study')
const study = await agent(`HARD DEP CHECK + inventory. (1) Confirm the concurrent src workflows (tui-mature, turn-harden) have LANDED — git status src/ + package.json clean of mid-flight work (set depLanded=false to STOP if not). (2) Run \`bunx oxlint src scripts\` READ-ONLY — report the violation COUNT by rule + category; categorize: real bugs (floating promise, unused, await-in-loop, hook deps), noise, rules that FIGHT opentui-JSX/Effect-generators/Bun/the documented as-any ponytails. (3) Recommend the .oxlintrc.json ruleset (enable correctness+suspicious + react-hooks; disable/tune the clashers) + env (es2024, bun) + globals. Cite counts + examples.\n\n${SPEC}`,
  { label: 'study', phase: 'Study', schema: FIND, agentType: 'Explore' })
if (!study || study.depLanded === false) { log('src workflows not landed (clobber risk) — STOP; run after tui-mature + turn-harden.'); return { stopped: 'concurrent src workflows not landed', study } }
const STUDY = JSON.stringify(study, null, 1)
log('studied oxlint inventory; deps landed — proceeding')

const STEPS = [
  { key: 'config', spec: `bun add -d oxlint. Write .oxlintrc.json tuned for Bun + TS + React(opentui) + Effect (per the study ruleset): enable correctness + suspicious + react-hooks (rules-of-hooks, exhaustive-deps); cherry-pick perf (no-await-in-loop) + restriction; DISABLE/tune the rules that fight the codebase (opentui JSX, Effect yield* generators, the documented as-any ponytails, bun globals). Set env es2024+bun + globals. Verify: \`bunx oxlint\` RUNS (may still report violations — that's the fix step); tsc + the existing lint stay green. commit (.oxlintrc.json + package.json devDep).` },
  { key: 'wire', spec: `Add an "oxlint" script (e.g. "oxlint": "oxlint src scripts") + fold it into "lint" as a layer (keep check + test + analyze + debt; add oxlint — order: check, oxlint, test, analyze, debt). Update AGENTS.md to document the 4-layer lint (types/JS-rules/design/debt) + when each runs. Verify tsc green + the lint chain wires (oxlint may still flag violations — fixed next). commit.` },
  { key: 'fix', spec: `Fix the REAL violations oxlint flags across src/ + scripts/ until \`bunx oxlint src scripts\` is CLEAN. REAL fixes: await/handle floating promises, remove unused, narrow avoidable any (the genuinely-needed ones stay as documented ponytails), add missing react-hook deps (carefully — opentui), fix eqeqeq/no-constant-condition. Do NOT blanket-disable; suppress ONLY with a one-line justified reason where a rule truly mis-fits. Keep tsc + yuku + debt + test green. Report the real bugs caught. Iterate. commit when oxlint + full lint green.` },
]

const results = []
for (const f of STEPS) {
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `oxlint-migrate step "${f.key}", grounded in the study.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} green + the existing lint layers (test/analyze/debt) stay green; for "fix" also \`bunx oxlint src scripts\` CLEAN. Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'chore(lint): oxlint ${f.key} …' (or 'fix(lint): …' for real bug fixes). Report sha/diff/check tail/oxlintClean/realBugsCaught/rulesDisabled. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (tsc/lint/oxlint). Fix + re-verify, commit --no-verify. Real fixes, not blanket-disable.\nFAILING:\n${impl.checkOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'real-fixes', focus: `Did "${f.key}" fix violations FOR REAL (handled the floating promise, removed the unused, narrowed the any) — NOT blanket-disabled? Any suppression justified one-line / ponytail? oxlint actually clean (quote)? List the real bugs caught. Cite file:line.` },
    { k: 'safe-complement', focus: `oxlint COMPLEMENTS (tsc/yuku/debt/test still green + intact, not replaced)? config doesn't disable so much it's toothless? no behavior change from a "fix" (e.g. adding a hook dep didn't break render; awaiting a promise didn't change semantics)? AGENTS.md documents the 4 layers? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed oxlint "${f.key}". LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nBUGS:\n${impl ? JSON.stringify(impl.realBugsCaught) : ''}\nDISABLED:\n${impl ? JSON.stringify(impl.rulesDisabled) : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: oxlintClean=${impl ? impl.oxlintClean : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in oxlint "${f.key}". Fix for real (real fixes not disables), re-verify, AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review oxlint "${f.key}"; blockers closed + still clean/complementary? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ step: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, oxlintClean: impl ? impl.oxlintClean : false, bugs: impl ? impl.realBugsCaught : [], openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown) on the oxlint migration. Per step (config/wire/fix): green? oxlint clean? Then: is oxlint now a real lint LAYER (in bun run lint, complementing tsc/yuku/debt — not replacing)? what REAL bugs did it catch (list)? what rules were disabled + why? the final 4-layer lint chain. residual.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { steps: results, report }
