export const meta = {
  name: 'workflow-tool',
  description: 'Give ax2 a real ULTRACODE-style workflow tool: a workflow({script}) tool where the model AUTHORS a JS orchestration script (not JSON strategy-params) using prims bound in-process — phase/log/agent/parallel/pipeline/judge/rlm/budget/args — mirroring the assistant Workflow tool API. RLM is just ONE prim (rlm() = the existing rlm-node kind), one node-kind among many, NOT special. Backend = the EXISTING engine (orch.ts 5 prims + orch-recipes). Runs in-process like ultracode (NO sandbox ceremony — the model already has bash, so in-process JS eval adds zero threat; ponytail-note it). Replaces the fixed-menu rlm_workflow JSON tool as the primary self-orchestration interface. Sequential, LIVE-verified on real CF-Kimi (Kimi authors a script that fans out + uses rlm() + returns a synthesized result), self-heal + adversarial review, commit each.',
  phases: [
    { title: 'Study',  detail: 'ax2 orch.ts prims + orch-recipes (runNode/agent/parallel/pipeline/judge/loopUntilDry/parallelLimit) + rlm-node runRlm signature + the current JSON rlm_workflow + agent.ts CHAT_TOOLS wiring; AND mirror the assistant Workflow API (phase/log/agent{schema,label,phase,model}/parallel/pipeline/budget/args) from the spec below' },
    { title: 'prims',  detail: 'bind the prims as in-process async fns over the existing recipes: agent(prompt,opts)->node forward, parallel(thunks), pipeline(items,...stages), phase(t)/log(m)->emit, judge(...), rlm(context,query,opts)->runRlm node kind, budget{total,spent,remaining}, args. Same semantics/quirks as ultracode (parallel = barrier, returns null on throw; pipeline = no barrier)' },
    { title: 'workflow-tool', detail: 'the workflow({script}) AxFunction: build prims, run the model-authored script in-process via an async Function with ONLY the prims in scope, nodes emit to the OrchTree, return the script result string. Guards: budget ceiling, abort, branch cap via parallelLimit, one-level (script prims carry BASE_TOOLS leaves only). ponytail: in-process LLM-authored JS = host authority, but <= the bash tool it already has; upgrade = AxJSRuntime isolate. Add to CHAT_TOOLS' },
    { title: 'cutover', detail: 'make workflow({script}) the primary self-orchestration tool; keep rlm_workflow ONLY if the model needs a no-code fallback (else drop it — one workflow tool). Update agent.ts ORCH overlay/prompt to teach the script API + show 2-3 example scripts (fan-out+judge, pipeline, an rlm() blob-mine). Keep ONE-WORD vocab: node' },
    { title: 'verify', detail: 'LIVE on CF-Kimi: Kimi authors + runs a real script — (a) phase + parallel 3 agents + judge -> synthesized answer; (b) a script that calls rlm(bigBlob, query) and returns the buried fact; prove the script ran in-process, nodes rendered, real result returned. NOT compile-only' },
    { title: 'Report', detail: 'can ax2 now author+run JS workflows like ultracode, RLM as a plain prim? live proof of a Kimi-authored multi-node script + an rlm() node; residual' },
  ],
}

const CHECK = 'bun run check'
const MAX_HEAL = 5
const MAX_HARDEN = 2

// The assistant Workflow API to MIRROR (so ax2's workflow tool feels identical).
const ULTRACODE_API = `
ASSISTANT WORKFLOW API to MIRROR (the model writes a script body using these, exactly these semantics):
- phase(title: string): void — start a phase; nodes after it group under that title in the live tree.
- log(msg: string): void — narrator line to the user.
- agent(prompt: string, opts?: {label?, phase?, schema?, model?, effort?}): Promise<string|object> — spawn ONE node (a BASE_TOOLS leaf: file/shell). Without schema returns its text; with a JSON-schema returns the validated object. null if it dies.
- parallel(thunks: Array<()=>Promise<any>>): Promise<any[]> — BARRIER: run all concurrently, await all. A throwing thunk resolves to null (filter(Boolean)). Capped at the concurrency limit; excess queue.
- pipeline(items, stage1, stage2, ...): Promise<any[]> — each item flows through all stages independently, NO barrier between stages. stage(prev, item, i). A throwing stage drops that item to null.
- judge(candidates: string[], criteria?: string): Promise<string> — one judge node picks the best candidate verbatim.
- rlm(context: string, query: string, opts?): Promise<string> — the RLM NODE KIND: mine a BIG context blob in the code runtime (out of the prompt) for query. JUST a prim, not special.
- budget: {total:number|null, spent():number, remaining():number} — advisory token budget.
- args: any — input value (usually undefined for ax2 self-orchestration).
- return <value> — the script's return value is what the workflow tool returns to the model.
Quirks to preserve: parallel = barrier + null-on-throw; pipeline = no barrier; no Date.now/Math.random determinism caveat is NOT needed here (ax2 in-process). The script is a plain async body (await allowed at top level of the body).`

const SPEC = `
ax2 = opentui TUI agent on @ax-llm/ax (CF Kimi K2.7 + GLM 5.2). USER'S ASK (verbatim intent): build ULTRACODE INFRA = a workflow tool
where the model AUTHORS a JS orchestration SCRIPT (like the assistant's Workflow tool), with RLM as just A TYPE OF NODE (one prim), NOT a
separate tool and NOT a fixed JSON strategy-menu.

CURRENT STATE (already in-tree, do NOT redo): RLM is ALREADY a node-kind — rlm-node.ts runRlm, invoked via rlm_workflow strategy 'rlm'
(mines a big 'context' blob in the AxJSRuntime code runtime). Standalone run_rlm tool is GONE. ✓ "RLM as node type" = done.
THE GAP: the self-orchestration tool is rlm_workflow({task, subtasks, strategy: enum[parallel|judge|verify|best_of_n|plan|rlm], branches})
— a fixed 6-strategy MENU passed as JSON. The model CANNOT write a script (no loops/conditionals/free nesting). That is the "json bullshit".

THE BUILD: a workflow({script}) tool. The model writes a JS body using prims bound in-process; the engine runs it; the return value comes
back to the model. Mirror the assistant Workflow API EXACTLY (see ULTRACODE_API block). RLM = the rlm() prim, one node-kind among agent/
parallel/pipeline/judge — nothing special. Backend = the EXISTING engine (orch.ts 5 prims + orch-recipes recipes) — add NO 6th core prim;
the prims are thin in-process bindings over runNode/parallelLimit/pipeline/judge/loopUntilDry/runRlm.

RUN MODEL (KEY — do NOT over-build): run the script IN-PROCESS like the assistant's Workflow tool does — an async Function whose only
in-scope names are the prims (phase/log/agent/parallel/pipeline/judge/rlm/budget/args). NO AxJSRuntime worker, NO host-call proxy, NO
sandbox ceremony. SECURITY: the model ALREADY has the bash tool (tools.ts is unsandboxed real shell), so in-process JS eval adds ZERO new
authority — it is <= bash. ONE ponytail: 'ponytail: in-process LLM-authored JS = host authority, but <= the bash tool already exposed;
upgrade = AxJSRuntime isolate if untrusted scripts ever run'. That is the WHOLE security note — do not build an isolate (user rejected it).

GUARDS (reuse the existing ones): budget ceiling (allocate SOFT/HARD, advisory — never discard a completed node, only HARD throws);
abortSignal threaded into every node forward; branch cap via parallelLimit at ORCH_CONCURRENCY (a 100-thunk parallel runs ~8 at once, rest
queue); ONE LEVEL — the agent()/rlm() prim nodes are BASE_TOOLS leaves (file/shell only), they carry NO workflow tool, so a script cannot
spawn a script (structural). CONTEXT/TRACE: the tool handler runs Promise-native inside forward() inside otelContext.with(traceContext), so
node emits nest under the live chat.turn span in the SAME OrchTree (one trace per session) — same pattern as rlm-workflow.ts today.

CUTOVER: make workflow({script}) the PRIMARY self-orchestration tool in CHAT_TOOLS. Drop rlm_workflow unless a no-code fallback is clearly
worth keeping (prefer ONE workflow tool — the user said "workflow tool" singular). Update the ORCH overlay/prompt in agent.ts to teach the
script API with 2-3 concrete example scripts (fan-out+judge; a pipeline; an rlm() blob-mine). Strategy 'plan' auto-decompose etc. become
things the model can just WRITE in a script (loop + parallel), so they need not survive as enum cases.

VERIFY (LIVE, real CF-Kimi — not compile-only): a real run where Kimi, given a task, AUTHORS a script and the tool runs it:
  (a) a script that does: phase('fan'); const rs = await parallel([()=>agent('audit X'),()=>agent('audit Y'),()=>agent('audit Z')]); return await judge(rs.filter(Boolean)) — real synthesized answer, 3 nodes + a judge render.
  (b) a script that does: return await rlm(BIG_BLOB, 'which fn registers the /auth route?') — the buried fact comes back (rlm node kind works AS a prim).
Paste the live output + the authored script text. Prove nodes rendered in the OrchTree (node events) + a real result returned.

PRINCIPLES: core stays the 5 prims in orch.ts; the workflow tool is a thin in-process script runner over the recipes (no 6th prim). ONE
WORD vocab: node (no worker/leaf synonyms in NEW prose). Real ax API only (read ../ax/src when types bite). Unavoidable any => 'ponytail:'.
${CHECK} + bun run lint green + the LIVE proof. Commit each --no-verify with Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>.
Do NOT git add -A (concurrent sessions' dirty files). NOTE: heavy concurrent restructure — re-confirm orch-recipes/rlm-node/rlm-workflow/
agent.ts line refs + exact recipe signatures at Study (they move). This worktree may be slightly behind; build on what's actually present.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'liveVerified', 'liveOutput', 'authoredScript', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, liveVerified: { type: 'boolean' }, liveOutput: { type: 'string' }, authoredScript: { type: 'string' },
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
const study = (await parallel([
  () => agent(`Read ax2 src/orch.ts (5 prims + allocate/Budget/NodeOpts), src/orch-recipes.ts (EXACT signatures: runNode/agent/parallel/parallelLimit/pipeline/judge/loopUntilDry/MAX_CONCURRENCY), src/rlm-node.ts (runRlm signature + how it bridges events), src/rlm-workflow.ts (the current JSON tool + onEvent/budget/abort/trace wiring + how the tool handler runs inside forward), src/agent.ts (CHAT_TOOLS, the ORCH overlay/prompt, RLM_WORKFLOW_TOOLS). Report the EXACT functions + signatures the prim bindings will wrap, the budget/abort/trace wiring to copy, and where to register the new tool + edit the prompt. Cite file:line.\n\n${SPEC}`,
    { label: 'ax2-engine', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Pin the prim CONTRACT mirroring the assistant Workflow API for ax2 in-process: for each of phase/log/agent/parallel/pipeline/judge/rlm/budget/args give the exact ax2-side binding (which recipe it calls, what it returns, null-on-throw + barrier semantics for parallel, no-barrier for pipeline) and the async-Function run shape (only prims in scope, await-able body, return value marshalled back). Note the one-level guard (prim nodes = BASE_TOOLS leaves) + the single ponytail (in-process eval <= bash). Cite file:line from orch-recipes/rlm-node.\n\n${ULTRACODE_API}\n\n${SPEC}`,
    { label: 'prim-contract', phase: 'Study', schema: FIND, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/2`)

const FEATURES = [
  { key: 'prims', live: false, spec: `Implement the prim bindings (a buildWorkflowPrims(ai, rootId, budget, signal, choice) -> {phase,log,agent,parallel,pipeline,judge,rlm,budget,args} over the existing recipes). agent->a single BASE_TOOLS node forward (runNode), parallel->parallelLimit barrier (null-on-throw), pipeline->per-item no-barrier stages, judge->the judge recipe, rlm->runRlm node kind, phase/log->onEvent emits, budget->the allocate-backed {total,spent,remaining}. tsc+lint green. commit.` },
  { key: 'workflow-tool', live: true, spec: `Add the workflow({script}) AxFunction (in rlm-workflow.ts or a new src/workflow-tool.ts): runs the model-authored script body in-process via an async Function whose ONLY in-scope names are the prims; nodes emit to the OrchTree (same trace wiring as rlm-workflow.ts); returns the script's return value (stringified). Guards: budget ceiling, abortSignal, branch cap (parallelLimit), one-level (prim nodes carry BASE_TOOLS only). ponytail: in-process LLM JS = host authority but <= bash; upgrade = AxJSRuntime isolate. Register in CHAT_TOOLS. LIVE proof: feed a hardcoded test script through the tool handler (no model needed yet) — phase+parallel 3 agents+judge returns a real synthesized string on CF-Kimi; paste output. tsc+lint green. commit.` },
  { key: 'cutover-prompt', live: true, spec: `Make workflow({script}) the PRIMARY self-orchestration tool. Drop rlm_workflow from CHAT_TOOLS unless a no-code fallback is justified in one line (prefer dropping — one workflow tool). Update the agent.ts ORCH overlay to teach the script API with 2-3 example scripts (fan-out+judge; pipeline; rlm() blob-mine). LIVE proof: run bun run chat-style turn (or a scripted turn harness) where CF-Kimi is asked a task, AUTHORS a script, the tool runs it, real result returns — paste the model-authored script + output. ALSO an rlm() script returns a buried fact from a big blob. tsc+lint green. commit.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 working tree, grounded in the study (real ax2 recipe signatures — no invented calls). Mirror the assistant Workflow API.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + bun run lint green.${f.live ? ' THEN run the LIVE proof (real CF-Kimi through the tool handler) — set liveVerified + paste liveOutput + the authoredScript that ran.' : ''} Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(workflow): ${f.key} ...'. Report sha/diff/check tail/liveVerified/liveOutput/authoredScript/new ponytails. Do NOT git add -A.\n\nULTRACODE_API:\n${ULTRACODE_API}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint${f.live ? '/live' : ''}). Fix + re-verify${f.live ? ' (real CF-Kimi run + paste authoredScript)' : ''}, commit --no-verify.\nFAILING:\n${impl.checkOutput}\nLIVE:\n${impl.liveOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'really-ultracode', focus: `Is this a REAL ultracode-style script tool — the model writes arbitrary JS (loops/conditionals/free nesting of agent+parallel+pipeline+judge+rlm), NOT a JSON strategy-menu? Does it mirror the assistant API (parallel barrier+null-on-throw, pipeline no-barrier, agent schema)? Proven by a Kimi-authored script in live output (quote it)? Reject compile-only or a thin JSON wrapper. Cite file:line.` },
    { k: 'rlm-is-a-prim', focus: `Is rlm() just ONE prim/node-kind among many (not special, not a separate tool)? Does a live script actually call rlm() and get a buried fact back? core still 5 prims (no 6th)? one-level guard real (prim nodes = BASE_TOOLS leaves)? budget/abort/branch-cap applied? the single ponytail correct (in-process <= bash, not an over-built sandbox)? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Demand a Kimi-authored script in live proof. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nLIVE:\n${impl ? impl.liveOutput : ''}\nAUTHORED SCRIPT:\n${impl ? impl.authoredScript : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: live=${impl ? impl.liveVerified : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real, re-verify${f.live ? ' (live Kimi-authored script)' : ''}, AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + live still a real Kimi-authored script? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, liveVerified: impl ? impl.liveVerified : false, liveOutput: impl ? (impl.liveOutput || '').slice(0, 400) : '', script: impl ? (impl.authoredScript || '').slice(0, 400) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). (1) Can ax2 now AUTHOR + RUN a JS workflow script like the assistant Workflow tool — loops/conditionals/free nesting? quote a Kimi-authored script + its live output. (2) Is rlm() just one prim/node-kind (live proof it returns a buried fact)? (3) core 5 prims intact (no 6th), one-level + budget/abort/cap applied, single in-process ponytail (<= bash)? (4) is rlm_workflow dropped or kept-with-reason? (5) residual / anything red or compile-only.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
