export const meta = {
  name: 'orch-exceed-ultracode',
  description: 'Make ax2 orchestration MATCH/EXCEED the ultracode workflow engine, proven on CF Kimi (weak-model floor → stronger on Claude). Budget-gated + resumable: runs the prioritized feature pile as far as budget allows, stops cleanly, resumes from cache. Each feature study-grounded + LIVE-verified (real Kimi run, not tsc) + adversarially reviewed + committed. GEPA self-improvement deferred.',
  phases: [
    { title: 'Study',        detail: 'parallel/pipeline impl, orchestrate fan-out + MAX_BRANCHES, AxAI service + AxRateLimiter API, the per-feature harness pattern, leaf opts/usage' },
    { title: 'concurrency',  detail: 'parallelLimit(thunks,n) bounded (cap 100, queue rest) + AxRateLimiter on the service + branch cap → 100' },
    { title: 'structured',   detail: 'first-class typed structured pipeline — gen(any signature) leaves threaded stage→stage with typed handoff' },
    { title: 'graceful-maxsteps', detail: 'max-steps = hard ceiling that BLOCKS new tool calls + FORCES a final reply (functionCall:none), ends the turn cleanly — no throw, no string-match; reply carries enough state to continue in a new turn' },
    { title: 'verified-step', detail: 'untilGate / verifyHarden / verifiedStep recipes — auto self-heal-to-green + adversarial-verify+harden, budget-bounded (the repasted workflow harness, now a primitive)' },
    { title: 'resume-journal', detail: 'journal completed leaves by (nodeId, inputHash, optsHash) → replay on re-run so a crash/network death never loses finished leaf work' },
    { title: 'retry-timeout', detail: 'per-leaf retry-with-backoff on transient errors (rate-limit/network) + per-leaf timeout so a hung/flaky leaf does not stall or kill the run' },
    { title: 'plan-execute', detail: "orchestrate strategy 'plan': a planner leaf emits a STRUCTURED subtask list, then fan out over it (auto-decomposition — the model plans the split)" },
    { title: 'cost-meter',   detail: 'sum token usage per node + run total, surface in the OrchTree + return (live cost/usage observability)' },
    { title: 'multi-model',  detail: 'per-NODE model + thinking-level routing over a TWO-model pool: Kimi K2.7 + GLM 5.2 (both on CF, same creds), each with its thinking level' },
    { title: 'gepa',         detail: 'OPT-IN GEPA scaffold: agent.optimize() to learn node/model selection + prompts from a task set. Off by default. Eventual self-improvement (Conductor).' },
    { title: 'Report',       detail: 'live proof per feature; honest scorecard of which ultracode + Fugu capabilities ax2 now matches/exceeds' },
  ],
}

const CHECK = 'bun run check'
const LIVE = 'AX2_LIVE=1 bun --env-file=.env scripts/orch-live.test.ts'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
ax2 self-orchestration on @ax-llm/ax (CF Kimi). Engine: src/orch.ts 5 prims (leaf, parallel, pipeline, emit, allocate); recipes in
src/orch-recipes.ts (agent/judge/loopUntilDry/adversarialVerify); tools in src/orch-tools.ts (orchestrate/run_orch_script); dynamic
scripts load via src/orch-load.ts and get a prims toolkit incl gen(signature,description). Budget is now SOFT (advisory) after
orch-soft-budget. RE-CONFIRM all names/lines at Study.

THE TWO LEAPS (match/exceed ultracode for SCALE):

1. BOUNDED CONCURRENCY (cap 100). Today src/orch.ts parallel = Promise.all(thunks.map(...)) — fires ALL at once, NO cap. A big fan-out
   (e.g. 50 leaves) hits CF Kimi simultaneously → rate-limit blowup. ultracode caps concurrency (~16) and QUEUES the rest. ADD a bounded
   helper parallelLimit(thunks, n): run at most n concurrently, queue the rest, preserve input order in the result, failed slot → null
   (same contract as parallel). Cap n at MAX_CONCURRENCY = 100 (a const; clamp n to 1..100; sensible default e.g. 8). Keep the existing
   core 'parallel' as-is (the 5 prims stay 5) — parallelLimit is a userland helper (orch-recipes.ts or a small util), NOT a 6th core prim.
   ALSO: attach an AxRateLimiterFunction to the AI service (ax supports rateLimiter in AxAIServiceOptions / per-forward) so even an
   unbounded parallel is throttled — a token-bucket / min-interval limiter (env AX2_MAX_RPS, sensible default). RAISE the orchestrate tool
   branch cap: MAX_BRANCHES 4 → allow up to 100 (clamp the model's request to 1..100), and fan the nodes out via parallelLimit(nodes,
   concurrency) so 100 branches run ≤concurrency-at-a-time. Keep the 4 safety guards (BASE_TOOLS-only leaves, abort, trusted-dir, soft
   budget) intact.

2. FIRST-CLASS STRUCTURED PIPELINE. Today orchestration nodes are string-only (message:string->reply:string). Make TYPED STRUCTURED
   leaves first-class so stages thread structured objects, not strings (the ultracode "structured output between the pipeline" shape).
   ax signatures already support typed multi-field output (f.json, arrays, classes) + parse/retry — expose it: a recipe/strategy that
   builds gen(signature) leaves and threads their TYPED outputs through pipeline() stages. Add an orchestrate strategy 'pipeline' (or a
   structuredPipeline helper) where stage k's typed output feeds stage k+1's input; each stage is a gen with its own signature. Render
   stages as nodes (emit). Dynamic .ax/orch scripts already can do this via gen()+leaf()+pipeline — make it a first-class, documented path
   (helper + an example .ax/orch/structured-pipe.ts + a line in BASE_PROMPT/tool description).

UNIFIED VOCABULARY — ONE WORD, ZERO SYNONYMS: the orchestration unit is a NODE. Full stop. leaf, agent (as a noun), worker, task, job,
unit, runner — ALL forbidden as names for the unit; they are the SAME thing = a node. The core primitive currently named 'leaf' (the one
that calls ax.forward) is renamed to NODE; the agent() recipe and orch-tools 'worker()' collapse into the node vocabulary; OrchNode /
NodeEvent / NodeView already use it. A node may run on any model/thinking-level and may itself be a child ax-agent — that is the SAME node,
not a new noun. Every feature uses 'node' and nothing else. No reserved second word for any special case (Fugu is NOT a thing here — see
multi-model). This rename is behavior-preserving; do it as part of the first feature that touches these files and keep it consistent.
PRINCIPLES: core stays EXACTLY 5 prims in orch.ts. Match style. Real @ax-llm/ax types (read ../ax/src + node_modules/@ax-llm/ax for the
rateLimiter + signature APIs). Fork mem per branch. Unavoidable any => 'ponytail:' + 'Upgrade:'. ${CHECK} green AND keep bun run lint
green AND the LIVE harness (${LIVE}, gated behind AX2_LIVE=1) must pass with REAL output. Commit each fix --no-verify, conventional
message. Do NOT git add -A (unrelated dirty scripts/ from another session) — stage only your files.
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
  () => agent(`Read src/orch.ts (parallel + pipeline impls, exact signatures) and src/orch-tools.ts (the fan-out, MAX_BRANCHES=4, boundary/optsFor, how nodes are spawned). Report exactly where to slot a parallelLimit(thunks,n) and how the orchestrate fan-out would call it; where MAX_BRANCHES is clamped. Cite file:line.\n\n${SPEC}`,
    { label: 'parallel-now', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read src/agent.ts (the ai({...}) llm service creation, runtime.ts) and grep node_modules/@ax-llm/ax/index.d.ts for AxRateLimiterFunction + how rateLimiter is passed (AxAIServiceOptions.rateLimiter? per-forward?). Report the EXACT way to attach a rate limiter (token-bucket / min-interval) to the CF-Kimi service so concurrent forward() calls are throttled. Cite file:line.\n\n${SPEC}`,
    { label: 'ratelimiter', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read src/orch-load.ts (OrchPrims incl gen(), the pipeline prim exposure) + src/orch.ts pipeline + .ax/orch/example.ts. Report how a TYPED structured leaf is built today via gen(signature) + leaf(), how pipeline() threads values, and exactly how to make a first-class 'structured pipeline' (stage k typed output → stage k+1 input) as a recipe/strategy. Cite file:line.\n\n${SPEC}`,
    { label: 'structured', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/3`)

const FIXES = [
  { key: 'concurrency', title: 'concurrency', live: true,
    spec: `Bounded concurrency, cap 100. (1) Add parallelLimit(thunks, n): runs at most n concurrently, QUEUES the rest, returns results in INPUT ORDER, failed slot → null (same contract as parallel). Put it in src/orch-recipes.ts (or a small util) — NOT a 6th core prim (orch.ts stays 5). Add MAX_CONCURRENCY = 100 (const); clamp n to 1..100; default ~8. Unit-test it headless (scripts/*.test.ts, no LLM): assert order preserved, never more than n in flight (use a counter), failures→null. (2) Attach an AxRateLimiterFunction (token-bucket or min-interval, env AX2_MAX_RPS sensible default) to the CF-Kimi service per the study so concurrent forwards are throttled. (3) Raise the orchestrate tool branch cap: clamp the model's branch request to 1..100 (not 4), and fan nodes out via parallelLimit(nodes, concurrency). Keep the 4 safety guards. GATE: live harness extended to run a bounded fan-out of ~12 branches — assert all complete with real output AND no rate-limit/crash (bounded concurrency holds). Report actual output + that >4 branches ran.` },
  { key: 'structured', title: 'structured', live: true,
    spec: `First-class typed structured pipeline. Add a structuredPipeline helper (orch-recipes.ts) and/or an orchestrate strategy 'pipeline': given an ordered list of typed stages (each a gen(signature) + an input-mapper), run them with pipeline() so stage k's TYPED structured output feeds stage k+1's input; fork mem per stage; emit each stage as a node. Make the dynamic path first-class: ship .ax/orch/structured-pipe.ts demonstrating gen("scope:string -> findings:json[], severity:string[]") → next typed stage, and add one line to the tool description / BASE_PROMPT that structured typed leaves + pipeline are supported. GATE: live harness — a 2-stage structured pipe where stage1 returns a TYPED object (e.g. {items:[...]}) and stage2 consumes it typed and returns a real answer; assert the typed handoff produced real non-empty structured output. Report the actual structured output.` },

  { key: 'graceful-maxsteps', title: 'graceful-maxsteps', live: true,
    spec: `Make max-steps a GRACEFUL hard ceiling (claude_code model), for BOTH the main turn (src/agent.ts) and orchestration nodes. RE-CONFIRM the current code at study: today agent.ts uses a brittle string-match isMaxSteps (/max steps reached/i, a ponytail) + a separate no-tools answerGen recovery. REPLACE that with the clean in-loop behavior: when the step count reaches maxSteps, the FINAL model call must run with tool-calling DISABLED (functionCall:'none' or empty functions — confirm the exact ax forward option in node_modules/@ax-llm/ax) so the model is FORCED to produce a final text reply from the tool results + context already in memory. NO throw, NO string-match. The turn/node returns that real reply. The reply should be self-contained enough to continue: the session AxMemory persists, so a follow-up turn resumes — emit a small "max steps reached — finalizing (continue in a new message)" activity/marker so the user/UI knows it was truncated, not finished. Remove or relax the isMaxSteps string-match ponytail (agent.ts ~:88) and the answerGen path if the in-loop force-reply supersedes it (keep behavior: a max-steps turn still ends with a usable answer, never an error or empty). Apply the same to orchestration nodes (orch-tools worker / agent recipe) so a node that exhausts steps returns its best reply, not an error. GATE: live run — a task that WILL exceed a small maxSteps (set AX2_MAX_STEPS low in the harness) returns a real non-empty final reply with no thrown error and no further tool calls after the cap. Report the live output proving graceful finalize. tsc + lint green, commit checkpoint.` },

  { key: 'verified-step', title: 'verified-step', live: false,
    spec: `Make the repasted workflow harness a RECIPE so orchestrations self-manage. Add to orch-recipes.ts: (a) untilGate(produce, gate, max=4): run produce(), evaluate gate(result) (a predicate or async check, e.g. "tests pass" / "non-empty"); if it fails, call produce() again with the failure fed back (produce takes the prior failure), loop until gate passes or max — return the last result + whether it passed. (b) verifyHarden(value, skeptics, fix, max=2): adversarialVerify(value, skeptics); while not accepted and < max, call fix(value, votes) and re-verify. (c) verifiedStep({produce, gate, skeptics, fix}): untilGate then verifyHarden, BUDGET-BOUNDED via the soft Budget (stop looping when over the soft ceiling, return best-so-far — never infinite). All Promise-native, composed ONLY from the 5 core prims + existing recipes (NO 6th core prim). Headless tests (no LLM, fake produce/gate): assert untilGate retries until gate true / stops at max; verifyHarden hardens until accepted / max; verifiedStep stops on budget. tsc + lint green.` },

  { key: 'resume-journal', title: 'resume-journal', live: false,
    spec: `Crash/network resilience — never lose a completed leaf. Add src/orch-journal.ts: a per-run journal keyed by (nodeId, hash(input), hash(opts-relevant)) → stored result. Wrap the agent()/leaf path (a journaledLeaf or an opt on the agent recipe) so a completed leaf records its result; on a re-run with the same key, REPLAY the cached result instead of re-calling the model. Persist the journal to .ax/journal/<sessionId>.json (atomic write) so it survives a process crash; load on run start. Keep it OFF by default (opt-in via a flag/ctx) so normal turns are unaffected; orchestrations + dynamic scripts opt in. Determinism: hash inputs stably (no Date.now in the key). Headless test (no LLM): record a fake result, "restart" (reload journal), assert the second run replays from cache (the fake model fn is NOT called again). tsc + lint green. ponytail if file-locking/concurrent-writes is simplified — Upgrade: proper lock.` },

  { key: 'retry-timeout', title: 'retry-timeout', live: false,
    spec: `Transient resilience. Wrap node execution (a withRetry helper on the node path) with: (a) retry-with-backoff on TRANSIENT errors only (rate-limit 429, network/timeout, 5xx) — exponential backoff + jitter-by-index (NO Math.random; vary by attempt index), max ~3 attempts; do NOT retry on real logic errors (AxFunctionError, budget). (b) per-node TIMEOUT (env AX2_LEAF_TIMEOUT_MS sensible default) via AbortController so a hung node aborts + counts as a failure (null), never stalls the whole fan-out. Thread the existing abortSignal so a cancelled turn still cancels. Headless test (no LLM, fake node that throws transient N times then succeeds / one that hangs): assert retry recovers the transient, timeout fires on the hang, logic errors are NOT retried. tsc + lint green.` },

  { key: 'plan-execute', title: 'plan-execute', live: true,
    spec: `Auto-decomposition. Add an orchestrate strategy 'plan' (and/or a planExecute recipe): a PLANNER leaf with a structured signature (e.g. "task:string -> subtasks:string[]") emits a distinct subtask list, THEN fan out over subtasks[i] via parallelLimit (each branch its own subtask, BASE_TOOLS leaf), then optionally judge/merge. This automates real division-of-labour from the model itself (vs the caller passing subtasks). Cap subtasks to the branch cap. Emit the planner + each branch as nodes. GATE: live harness — give a decomposable task, assert the planner produced >1 DISTINCT subtask and each branch returned real work for ITS subtask (distinct outputs). Report the plan + branch outputs.` },

  { key: 'cost-meter', title: 'cost-meter', live: false,
    spec: `Observability — live cost/usage. Sum token usage per node (from readUsageOf / the leaf result usage) and a run total; surface it: include perNode + total tokens in the node's done event / OrchTree state and in the orchestrate tool's returned summary string (e.g. "...· 4 branches · 318k tok"). If ax exposes a cost estimate (getEstimatedCost on the service), include approx cost too. Render the total in the TUI tree footer/summary (chat.tsx) without breaking layout. Headless test: drive fake usage through the path, assert per-node + total sum correctly. tsc + lint green.` },

  { key: 'multi-model', title: 'multi-model', live: true,
    spec: `Per-NODE MODEL + THINKING-LEVEL routing over a TWO-model pool — Kimi K2.7 + GLM 5.2 ONLY (no opus/gpt/gemini, no Fugu roster — a node simply runs on a chosen model). Both run on Cloudflare Workers AI using the EXISTING CLOUDFLARE_API_TOKEN/ACCOUNT_ID — NO new API keys. (1) Thread an optional { model?: string, effort?: 'low'|'medium'|'high'|'xhigh'|'max', thinkingTokenBudget?: ... } through the node path → node opts (ax forward accepts model + AxModelConfig.effort/thinkingTokenBudget per-call; confirm exact fields from node_modules/@ax-llm/ax). Default = the session model (Kimi K2.7) at default effort — unchanged behaviour when nothing passed. (2) Add a model REGISTRY (src/models.ts): exactly two entries — 'kimi' = @cf/moonshotai/kimi-k2.7-code, 'glm' = @cf/zai-org/glm-5.2 (VERIFIED live: both models run on the SAME CF v1 OpenAI-compat endpoint with the existing CLOUDFLARE creds — routing is JUST swapping the per-forward model param, NO separate AxAIService needed). resolveModel(name) → kimi | glm, default kimi. VERIFIED: BOTH are THINKING models — they return a reasoning_content field separate from content; thinking-level control is via ax thinkingTokenBudget/showThoughts. CRITICAL GOTCHA (verified): at low max_tokens the reasoning eats the whole budget and content comes back EMPTY — so a leaf MUST get enough completion budget (or an explicit thinkingTokenBudget) or it returns nothing; ensure the leaf opts give adequate maxTokens/thinking budget for both models. NO other models. (3) Document the two models + their thinking levels in BASE_PROMPT. GATE: live run proving (a) default Kimi path unchanged, (b) a leaf routed to GLM 5.2 returns real output, (c) an explicit thinking level passes through to forward() on BOTH models without breaking. Report the live output from both models. tsc + lint green, commit checkpoint.` },

  { key: 'gepa', title: 'gepa', live: false,
    spec: `OPT-IN GEPA self-improvement scaffold (Conductor-style) over the Kimi+GLM pool — eventual, do NOT run a full optimize automatically. Wire agent.optimize({ train, validation }, { target, bootstrap, maxMetricCalls, judgeOptions }) over the ORCHESTRATOR to learn better node/model selection + node prompts. Ship: (a) src/orch-optimize.ts with the optimize() call + applyOptimization() + a persisted optimized-program artifact loader, (b) a tiny example task set (train + held-out) with criteria + expectedActions, (c) a script "gepa" gated behind AX2_GEPA=1 (skips otherwise) that runs the optimize ONLY when the flag is set. GATE for THIS feature = COMPILE + scaffold wired (tsc + lint green) + a DRY assertion that the optimize call is constructed correctly (NOT a full live GEPA run — expensive, run it manually later). GEPA full-run is eventual/opt-in. ponytail: scaffold-only until a deliberate optimize run lands an artifact. Upgrade: run the real optimize over Kimi+GLM + commit the artifact. commit checkpoint.` },
]

const results = []
for (let i = 0; i < FIXES.length; i++) {
  const f = FIXES[i]
  if (budget.total && budget.remaining() < 90000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.title)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree, grounded in the study (real ax APIs only).\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} green + keep bun run lint green.${f.live ? ` THEN run the live harness (${LIVE}) — green ONLY with real output proving the feature (bounded fan-out completes / typed handoff works), set liveVerified=true + paste liveOutput.` : ''} Self-heal up to ${MAX_HEAL}. Mark shortcuts 'ponytail:' + 'Upgrade:'. When green, COMMIT alone (--no-verify) 'feat(orch): ${f.key} ...'. Report sha/diff/check tail/liveVerified/liveOutput/new ponytails. Do NOT git add -A — stage only your files.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint or live). Fix for real + re-verify${f.live ? ` (${LIVE} must give real output)` : ''}, commit --no-verify.\nFAILING:\n${impl.checkOutput}\nLIVE:\n${impl.liveOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'really-works', focus: `For "${f.key}": concurrency — does parallelLimit ACTUALLY bound in-flight to n (prove via the counter test) + preserve order + the rate limiter is attached + >4 branches ran live without crash? structured — typed output of stage1 really feeds stage2 typed (prove with live structured output)? Reject compile-only. Cite file:line + quote live output.` },
    { k: 'safety-purity', focus: `core still EXACTLY 5 prims (parallelLimit is a helper, NOT in orch.ts)? 4 guards intact (BASE_TOOLS-only leaves, abort, trusted-dir, soft budget)? fork-mem per branch/stage? cap really 100 (clamped)? no unmarked any/ponytail; lint green; single-turn + ^o unbroken? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Skeptical; demand real output for live fixes. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: live=${impl ? impl.liveVerified : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}" — fix for real, re-verify${f.live ? ' (live)' : ''}, AMEND commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + live still real? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, liveVerified: impl ? impl.liveVerified : false, liveOutput: impl ? (impl.liveOutput || '').slice(0, 300) : '', openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown, no spin). Per fix (concurrency, structured): green/red, commit, and QUOTE the real CF-Kimi output proving it (a >4 bounded fan-out completed without rate-limit blowup; a typed structured stage1→stage2 handoff produced real output). Then: (1) can ax2 now run MANY instances in one orchestration, bounded to ≤N (cap 100) + rate-limited — like/better than ultracode? (2) is the structured pipeline first-class (typed objects between stages)? (3) core still 5 prims, 4 guards intact, lint green? (4) residual ponytails. (5) one honest line. Headline anything red or only compile-verified.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
