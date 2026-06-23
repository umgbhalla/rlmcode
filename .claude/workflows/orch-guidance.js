export const meta = {
  name: 'orch-guidance',
  description: 'Give ax2 the DEEP, dense, heavily-exampled orchestration guidance that makes the assistant\'s ultracode Workflow engine usable — so the ax2 agent orchestrates INTELLIGENTLY (picks the right strategy, decomposes, forks mem, bounds concurrency, never require() in RLM) instead of blind. Rewrite the ORCH_OVERLAY + the orchestrate/run_orch_script/run_rlm tool descriptions to be rich + exampled, author a complete .ax/orch/GUIDE.md reference with runnable example scripts, and live-verify the agent actually orchestrates well. Sequential on main, study-grounded, live-verified, commit each.',
  phases: [
    { title: 'Study',     detail: 'the assistant\'s ultracode Workflow guidance structure (patterns/templates/anti-patterns) + ax2\'s REAL orch surface (5 prims, recipes, strategies, run_rlm, dynamic .ax/orch, ctx/prims API)' },
    { title: 'tool-guidance', detail: 'rewrite ORCH_OVERLAY + orchestrate/run_orch_script/run_rlm tool descriptions: dense, when-to-use, per-strategy examples, anti-patterns, fork-mem, bounded-concurrency, NO-require-in-RLM' },
    { title: 'guide-doc',  detail: 'author .ax/orch/GUIDE.md — deep reference with COMPLETE runnable example scripts (parallel/judge/verify/structured-pipeline/loop-until-dry/plan) + prims/recipes/ctx API + anti-patterns; ship the example scripts' },
    { title: 'verify',    detail: 'live run: a decomposable task → agent picks orchestrate with the RIGHT strategy + distinct subtasks; a trivial task → agent does NOT over-orchestrate' },
    { title: 'Report',    detail: 'does the agent now orchestrate intelligently? quote its real choices' },
  ],
}

const CHECK = 'bun run check'
const LIVE = 'AX2_LIVE=1 bun --env-file=.env scripts/orch-live.test.ts'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
WORKTREE — CRITICAL: this workflow runs PARALLEL to another on the main checkout. ALL file reads, edits, shell commands, the live
harness, and git commits MUST happen in the ISOLATED worktree at ax2-guidance (branch feat/orch-guidance) — cd there
first / use that absolute path. NEVER touch ax2 (the main checkout — another workflow is editing it concurrently).
Commit on feat/orch-guidance in the worktree.

ax2 agent (CF Kimi) has orchestration TOOLS (orchestrate, run_orch_script, run_rlm) but THIN guidance — so it orchestrates blind or
not at all. GOAL: give it the DEEP, dense, heavily-exampled guidance that makes the assistant's ultracode Workflow engine work, so the
ax2 agent decides WELL: when to fan out vs single-turn, which strategy, how to decompose, fork mem, bound concurrency, and (RLM) write
pure JS never require(). RE-CONFIRM the real orch surface at Study (other workflows just edited these files — read current state).

THE ASSISTANT'S ULTRACODE GUIDANCE SHAPE (model ax2's guidance on this): a dense tool description + a patterns/templates/anti-patterns
body: the small orthogonal primitive set; DEFAULT to pipeline over parallel; structured output via schema/signature; loop-until-dry;
adversarial-verify (N skeptics, default-refuted); judge panels; budget-gated loops; "scale to what's asked"; concrete runnable templates;
explicit anti-patterns (don't reify patterns as core; don't fan-out trivial; barrier only when a stage needs ALL prior results).

ax2's REAL surface (confirm exact at Study): CORE 5 prims in orch.ts (node, parallel, pipeline, emit, allocate). Recipes in orch-recipes.ts
(runNode, judge, loopUntilDry, adversarialVerify, structuredPipeline, parallelLimit). Tools: orchestrate { task|subtasks, strategy:
parallel|judge|verify|best_of_n|plan, branches } (bounded ≤ MAX_BRANCHES via parallelLimit at ORCH_CONCURRENCY); run_orch_script { name }
(loads a trusted .ax/orch/<name>.ts exporting orchestrate(ctx, prims)); run_rlm { context, query } (RLM over a big blob). Dynamic scripts
get prims = { node/leaf, parallel, pipeline, emit, allocate, gen, runNode, judge, loopUntilDry, adversarialVerify, structuredPipeline } and
ctx = { message, ai, budget, onEvent, optsFor(), usageOf }. Models: Kimi + GLM (per-node model + thinking level). Multi-model, soft budget,
graceful max-steps all already shipped.

VOCABULARY: ONE WORD — NODE (no leaf/agent/worker as unit names). Match it in all new text/examples.

PRINCIPLES: do NOT change core/engine behavior — this is GUIDANCE (prose + tool descriptions + a doc + example scripts), not logic. Prompt
bloat is NOT a latency concern (benchmarked: prompt size barely moves CF latency). Real @ax-llm/ax + the actual ax2 API in every example
(no invented calls — a reader must be able to /run the examples). Unavoidable any => 'ponytail:'. ${CHECK} + bun run lint green. Commit each
feature --no-verify. Do NOT git add -A — stage only your files.
`

const FIND_SCHEMA = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'liveVerified', 'liveOutput', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, liveVerified: { type: 'boolean' }, liveOutput: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' }, checkOutput: { type: 'string' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' }, newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

phase('Study')
const study = (await parallel([
  () => agent(`Read src/agent.ts (ORCH_OVERLAY + how tool descriptions are set) + src/orch-tools.ts + src/rlm-tool.ts (the orchestrate/run_orch_script/run_rlm tool description strings) + src/orch-recipes.ts + src/orch-load.ts (OrchPrims + ctx shape). Report the EXACT current guidance text + the real prims/recipes/ctx/strategy API verbatim, so the new guidance + examples use real calls. Cite file:line.\n\n${SPEC}`,
    { label: 'orch-surface', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read .ax/orch/ (existing example scripts: example.ts, structured-pipe.ts, etc) + how run_orch_script loads them (orch-load.ts resolveScript). Report the exact dynamic-script contract (export shape, the injected prims/ctx, what a script can/can't do) + the existing examples, so GUIDE.md examples match reality + are runnable. Cite file:line.\n\n${SPEC}`,
    { label: 'dynamic-scripts', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/2`)

const FIXES = [
  { key: 'tool-guidance', title: 'tool-guidance', live: false,
    spec: `Rewrite the orchestration GUIDANCE the agent sees every turn — dense + exampled, the ultracode-equivalent. (A) ORCH_OVERLAY (src/agent.ts): a tight but rich block — WHEN to orchestrate (a task splits into independent parts / needs best-of-N or verify / a big blob needs run_rlm) vs WHEN NOT (trivial/sequential tasks — do them directly, do NOT fan out a one-liner); the strategy menu (parallel=fan distinct subtasks, judge=best-of-N, verify=skeptics vote, best_of_n=re-run+judge, plan=auto-decompose) each with a ONE-LINE when; the hard rules (give DISTINCT subtasks not N copies; fork mem per branch via ctx.optsFor; bounded ≤ branch cap; pick model/thinking per node; RLM actor writes PURE JS — never require/import). (B) The three tool descriptions (orchestrate/run_orch_script/run_rlm in orch-tools.ts + rlm-tool.ts): make each DENSE with a concrete example + when-to-use + the param semantics + a "point to .ax/orch/GUIDE.md for full examples" line. Real API only. ${CHECK} + lint green. commit.` },
  { key: 'guide-doc', title: 'guide-doc', live: false,
    spec: `Author .ax/orch/GUIDE.md — the DEEP, dense, fully-exampled orchestration reference (the ax2 analog of the assistant's ultracode Workflow guidance). Structure: (1) the 5 core prims + recipes + ctx/prims API, each with a signature + 1-line purpose; (2) WHEN to use orchestration vs a single turn vs run_rlm (decision guide); (3) STRATEGY recipes each with a COMPLETE runnable example: parallel fan-out over distinct subtasks, judge best-of-N, verify (skeptics), structuredPipeline (typed stage1→stage2), loopUntilDry, plan (auto-decompose); (4) DYNAMIC SCRIPT authoring — a full .ax/orch/<name>.ts that the reader can /run, showing gen()/runNode/parallel/pipeline/optsFor(fork mem)/budget, NO runtime imports; (5) ANTI-PATTERNS (don't fan-out trivial; prefer pipeline; barrier/parallel only when a stage needs ALL prior; never share a mutating mem across concurrent nodes; RLM = pure JS no require; don't blow the branch cap); (6) budget/concurrency/model-selection notes. Also SHIP the example scripts referenced (e.g. .ax/orch/{fanout,judge,verify,pipeline}.ts) — each must actually load + run via run_orch_script (no invented API). Every example uses the REAL prims/ctx. ${CHECK} + lint green (GUIDE.md is a doc; the example .ts scripts must typecheck if under tsconfig, else live in .ax/orch which is outside src — confirm). commit.` },
  { key: 'verify', title: 'verify', live: true,
    spec: `Live-verify the agent orchestrates INTELLIGENTLY with the new guidance. Build a tiny live probe (extend the harness or a script) that runs the REAL chat gen (BASE_PROMPT+ORCH_OVERLAY+tools) on: (a) a clearly DECOMPOSABLE task ("research these 3 independent things ...") — assert the model CHOOSES to call orchestrate with strategy + DISTINCT subtasks (or run_orch_script); (b) a TRIVIAL task ("what is 2+2") — assert it does NOT over-orchestrate (answers directly / no orchestrate call). Report the model's ACTUAL tool choice for each. (If the model is too weak to reliably choose, report that honestly — the guidance still helps; do not fake a pass.) ${CHECK} + lint green. commit.` },
]

const results = []
for (let i = 0; i < FIXES.length; i++) {
  const f = FIXES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.title)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree, grounded in the study.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + bun run lint green.${f.live ? ` THEN run the live probe — report the model's ACTUAL orchestration choices, set liveVerified honestly.` : ''} Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(orch): ${f.key} ...'. Report sha/diff/check tail/liveVerified/liveOutput/new ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint). Fix + re-verify, commit --no-verify.\nFAILING:\n${impl.checkOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'accurate', focus: `Is the guidance ACCURATE to the real API (every example uses real prims/recipes/ctx that actually exist + run — no invented calls)? Does GUIDE.md cover when-to-orchestrate, every strategy with a runnable example, dynamic scripts, anti-patterns, fork-mem, NO-require-RLM? Cite file:line.` },
    { k: 'no-regress', focus: `Pure GUIDANCE — no engine/logic change (orch.ts 5 prims, recipes, tools' BEHAVIOR untouched, only descriptions/prose/docs)? ONE-WORD vocab (node)? lint green? example scripts actually loadable via run_orch_script? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: ${blockers.length} blockers`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix, ${CHECK}+lint green, AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, liveVerified: impl ? impl.liveVerified : false, liveOutput: impl ? (impl.liveOutput || '').slice(0, 300) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Per feature: green/red, commit. (1) Does ax2 now have deep, exampled orchestration guidance (ORCH_OVERLAY + rich tool descriptions + .ax/orch/GUIDE.md + runnable example scripts)? (2) From the live probe: does the agent CHOOSE orchestrate+right-strategy on a decomposable task, and NOT over-orchestrate a trivial one? quote its real choices (or honestly say the model is too weak to reliably choose). (3) accurate to real API, pure guidance (no engine change), lint green? (4) residual. Headline anything red or only compile-verified.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
