export const meta = {
  name: 'run-orch-code',
  description: 'Let the ax2 agent WRITE + RUN orchestration JS in the AxJSRuntime sandbox — like the RLM actor writes JS, like an ultracode Workflow script — instead of the JSON-param orchestrate tool / file-only run_orch_script. Add a run_orch_code({code}) tool: the model authors JS using injected HOST PRIMITIVES (node/leaf, parallel, pipeline, judge, loopUntilDry, llmQuery, gen) proxied across the AxJSRuntime worker (the same mechanism RLM uses for llmQuery), executed in the sandbox, result returned. This is the legit untrusted-LLM-code path → it RESOLVES the in-process-trust ponytail (sandbox = the upgrade). Sequential on main, live-verified (agent-authored code actually runs + fans out), self-heal + adversarial review, commit each.',
  phases: [
    { title: 'Study',   detail: 'how ax injects HOST-FUNCTION globals into AxJSRuntime (RLM llmQuery/final mechanism, buildRuntimeGlobals, AxJSRuntime.createSession globals + the worker host-call proxy) — the exact API to inject node/parallel/pipeline/gen' },
    { title: 'prims-bridge', detail: 'a bridge that injects the orchestration prims as AxJSRuntime host globals (proxied to the main thread where forwards run); deterministic + budgeted' },
    { title: 'run-orch-code', detail: 'the run_orch_code({code}) tool: run agent-authored JS in the sandbox with prims injected; render nodes; return the result; guards (budget, abort, branch cap, NO file/net/proc — sandbox)' },
    { title: 'verify',  detail: 'LIVE: the agent (or a test) authors JS that fans out (parallel node()s + a merge) → runs in the runtime → returns a real synthesized result; require is impossible (sandbox), prims work' },
    { title: 'Report',  detail: 'can the agent now write+run orchestration JS like ultracode? does it close the in-process-trust ponytail? live proof' },
  ],
}

const CHECK = 'bun run check'
const LIVE = 'AX2_LIVE=1 bun --env-file=.env scripts/orch-live.test.ts'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
ax2 = opentui TUI on @ax-llm/ax (CF Kimi). THE GAP the user hit: orchestration is exposed as JSON-PARAM tools (orchestrate({task,strategy})
+ run_orch_script({name}) which loads a trusted FILE). The model cannot WRITE + RUN orchestration JS the way the RLM actor writes JS in
AxJSRuntime, or the way an ultracode Workflow script composes prims. AxJSRuntime exists in ax2 but ONLY run_rlm uses it. The orchestration
prims (node/leaf, parallel, pipeline, judge, loopUntilDry, gen) are NOT injected into a general agent-authored code runtime.

THE BUILD: a run_orch_code({code}) tool where the model authors JS that calls injected HOST PRIMITIVES, executed in an AxJSRuntime sandbox,
result returned. Grounded in how ax already does this for RLM: AxAgent injects llmQuery/final/etc as HOST globals proxied across the
AxJSRuntime worker boundary (the worker calls them, they execute on the host/main thread where the ai service + forwards live, results
marshalled back). STUDY that exact mechanism (../ax/src/ax/agent runtimeGlobals/runtimePrimitives + AxJSRuntime.createSession(globals,...)
+ the worker host-call proxy in ../ax/src/ax/funcs/jsRuntime*.ts) before building — do NOT invent it.

REQUIREMENTS:
1. STUDY: the EXACT ax API to inject custom HOST FUNCTION globals into a standalone AxJSRuntime (not via AxAgent) — how a worker-side call
   (e.g. await node(gen,opts)(ai,input) or await llmQuery(q)) proxies to a host async fn + returns. Confirm AxJSRuntime supports arbitrary
   host-function globals (it does for RLM's primitives). Prove with a minimal inject+call snippet that actually runs.
2. PRIMS BRIDGE: inject the ax2 orchestration prims as host globals into an AxJSRuntime session — node/leaf (forward via the main-thread ai),
   parallel, pipeline, judge, loopUntilDry, gen (build an AxGen), and llmQuery (semantic sub-query). The actual forwards run on the MAIN
   thread (where llm + budget + tracer live); the worker just orchestrates. Budget (allocate, soft/hard), abort, branch cap apply. The
   worker is least-privilege (no NETWORK/FILESYSTEM/CHILD_PROCESS — only what the prims proxy) → this is the SANDBOX that makes running
   model-authored code safe.
3. run_orch_code({code}) tool (in orch-tools.ts or a new file): runs the model's JS in the sandboxed AxJSRuntime with the prims bridge;
   the code's nodes render in the OrchTree (emit); returns the code's result (a string/JSON) to the model. Guards: budget ceiling, abort,
   branch cap, sandbox permissions []. Add it to the main chat gen's tools (ONE level — sandboxed code can't spawn run_orch_code again:
   don't inject run_orch_code/orchestrate as a prim, only the leaf prims).
4. This RESOLVES the in-process-trust ponytail (orch-load.ts:11 / orch-tools.ts:488): model-authored orchestration now runs in the
   AxJSRuntime ISOLATE, not in-process. Update/remove those ponytails accordingly (run_orch_script could also route through the sandbox).

VERIFY (LIVE, not compile-only): a real run where agent-authored JS — e.g. \`const rs = await parallel([()=>node(gen('q->a'),opts)(ai,{q:'X'}), ()=>node(...)(ai,{q:'Y'})]); return rs.filter(Boolean).join('\\n')\` — actually executes in the sandbox, the prims proxy to real CF-Kimi forwards, and a real synthesized result returns. Also prove require/import/fs are UNAVAILABLE (sandbox) — a code that tries require throws, the run still returns cleanly. Extend the live harness.

PRINCIPLES: core stays the 5 prims in orch.ts; run_orch_code is a TOOL that runs them in the sandbox (no 6th prim). ONE-WORD vocab: node.
Real ax API only (read ../ax/src). Unavoidable any => 'ponytail:'. ${CHECK} + bun run lint green + the LIVE proof. Commit each --no-verify.
Do NOT git add -A. NOTE: heavy concurrent restructure on this repo — re-confirm orch-tools/rlm-tool/runtime line refs at Study (they move).
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'liveVerified', 'liveOutput', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, liveVerified: { type: 'boolean' }, liveOutput: { type: 'string' },
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
  () => agent(`Study how ax injects HOST-FUNCTION globals into AxJSRuntime so a worker-side call proxies to a host async fn + returns: read ../ax/src/ax/agent (runtimeGlobals, runtimePrimitives, completion, the actor loop) + ../ax/src/ax/funcs/jsRuntime*.ts (createSession, the worker host-call/RPC proxy, splitGlobalsForWorker, the fnMap). Report the EXACT API to construct a standalone AxJSRuntime and inject arbitrary async host-function globals the sandboxed code can await. Prove with a real minimal snippet. Cite file:line.\n\n${SPEC}`,
    { label: 'ax-runtime-globals', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Read ax2 src/orch.ts (the 5 prims), src/orch-recipes.ts (node/runNode/parallel/pipeline/judge/loopUntilDry/gen signatures), src/orch-tools.ts (orchestrate/run_orch_script + the boundary/budget/abort), src/rlm-tool.ts (how it builds AxJSRuntime), src/runtime.ts (llm). Report exactly which prims to inject + how the main-thread forwards (node()) would be called from the worker via a host proxy, where budget/abort/branchcap apply, and which ponytails (in-process-trust) this closes. Cite file:line.\n\n${SPEC}`,
    { label: 'ax2-prims', phase: 'Study', schema: FIND, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/2`)

const FEATURES = [
  { key: 'prims-bridge', live: true, spec: `Build a bridge that injects the orchestration prims as AxJSRuntime HOST GLOBALS (per the study): node/leaf, parallel, pipeline, judge, loopUntilDry, gen, llmQuery — each a host async fn the sandboxed code awaits; forwards run on the MAIN thread (llm + budget + tracer). Least-privilege runtime (permissions []). Budget(allocate soft/hard)+abort+branchcap apply. LIVE proof: a host-side test runs a trivial sandbox snippet that awaits an injected prim (e.g. await llmQuery('2+2?')) and gets a real CF-Kimi answer back across the worker boundary. tsc+lint green. commit.` },
  { key: 'run-orch-code', live: true, spec: `Add the run_orch_code({code}) tool (orch-tools.ts or new src/orch-code.ts): runs the model's JS in the sandboxed AxJSRuntime with the prims bridge; nodes emit to the OrchTree; returns the code's result to the model. Guards: budget ceiling, abort, branch cap, sandbox permissions []; do NOT inject run_orch_code/orchestrate as prims (one level). Add to the main chat gen tools (agent.ts). LIVE proof: run agent-style JS that does `const rs=await parallel([()=>llmQuery('X'),()=>llmQuery('Y')]); return rs.join('|')` → real result; AND a snippet that tries require(...) → it throws in-sandbox, the tool returns cleanly (proves sandbox). tsc+lint green. commit.` },
  { key: 'close-trust-ponytail', live: false, spec: `Now that model-authored orchestration runs in the AxJSRuntime ISOLATE: update the in-process-trust ponytails (orch-load.ts:11 / orch-tools.ts:488). If run_orch_script can also route through the sandbox (loading the file's code into the runtime instead of in-process import()), do that + remove/relax the ponytails. If a path still runs in-process, keep a sharpened ponytail naming exactly what's left. tsc+lint+debt green. commit.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree, grounded in the study (real ax AxJSRuntime host-globals API — no invented calls).\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + bun run lint green.${f.live ? ' THEN run the LIVE proof (real CF-Kimi through the sandbox) — set liveVerified + paste liveOutput; require-in-sandbox must throw while the run returns cleanly.' : ''} Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(orch): ${f.key} ...'. Report sha/diff/check tail/liveVerified/liveOutput/new ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint or live). Fix + re-verify${f.live ? ' (real sandbox run)' : ''}, commit --no-verify.\nFAILING:\n${impl.checkOutput}\nLIVE:\n${impl.liveOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'really-runs', focus: `Does agent-authored JS REALLY run in the AxJSRuntime sandbox with the prims as host globals — proven by live output (a parallel/llmQuery snippet returns a real CF-Kimi result across the worker)? Is require/import/fs genuinely unavailable (sandbox)? Reject compile-only. Cite file:line + quote live output.` },
    { k: 'safe-sandbox', focus: `Is it actually SANDBOXED (AxJSRuntime worker, permissions [], no in-process eval)? budget+abort+branchcap applied? one-level (sandbox can't call run_orch_code/orchestrate)? core still 5 prims? Does it really close the in-process-trust ponytail or is there a leftover in-process path? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Demand live proof + real sandboxing. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: live=${impl ? impl.liveVerified : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real, re-verify${f.live ? ' (live sandbox)' : ''}, AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + live still real? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, liveVerified: impl ? impl.liveVerified : false, liveOutput: impl ? (impl.liveOutput || '').slice(0, 300) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). (1) Can the agent now WRITE + RUN orchestration JS in the AxJSRuntime sandbox (run_orch_code) with the prims as host globals — like ultracode/RLM? quote the live output of agent-authored JS executing + returning a real result. (2) Is it genuinely SANDBOXED (require/fs unavailable, proven)? (3) Does it close the in-process-trust ponytail? (4) core 5 prims intact, budget/abort/cap applied? (5) residual. Headline anything red or compile-only.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
