export const meta = {
  name: 'agent-self-orchestrate',
  description: 'Make the ax2 agent SELF-ORCHESTRATE like an autonomous coding agent: expose the orchestration engine to the model AS TOOLS (orchestrate + run_orch_script) so it can decide mid-turn to fan out / judge / verify / loop / write+run a dynamic script — bounded by a STRUCTURAL one-level recursion guard (leaves get file-tools MINUS orchestration tools), a token budget ceiling, and a branch cap. Teach BASE_PROMPT when to use them. Sequential on main, self-heal to tsc-green + 2-lens adversarial review (correctness + safety/recursion), commit each.',
  whenToUse: 'Trigger AFTER orch-zero-import lands (it touches tools.ts/agent.ts). Turns the user-triggered orchestration (^o//run) into an agent-driven capability.',
  phases: [
    { title: 'Scout',        detail: 'pin tools.ts AxFunction shape + extra(ai/sessionId/step), orch-run.orchestrate + orch-load.loadAndRunOrch signatures, how a leaf turn gets its tool set, the trace/span entry' },
    { title: 'orch-tools',   detail: 'orchestrate + run_orch_script AxFunctions with structural one-level guard + budget + branch cap' },
    { title: 'autonomy',     detail: 'BASE_PROMPT: when/how to self-orchestrate; defaults + caps documented' },
    { title: 'Report',       detail: 'status, is the agent autonomous now, the safety bounds, residual' },
  ],
}

const CHECK = 'bun run check'
const MAX_HEAL = 4
const MAX_HARDEN = 2

const SPEC = `
ax2 is a Bun+TS TUI coding agent on @ax-llm/ax. The orchestration ENGINE is built on main: src/orch.ts (5 prims
leaf/parallel/pipeline/emit/allocate), src/orch-recipes.ts (agent/judge/loopUntilDry/adversarialVerify), src/orch-run.ts
(orchestrate() multi-node run, forks AxMemory per branch), src/orch-load.ts (loadAndRunOrch — runtime import()+run a trusted
.ax/orch/ script). Today these are USER-triggered only (^o = orchestrateAtom, /run = runScriptAtom in chat.tsx). The agent itself
(the 'chat' AxGen in src/agent.ts, tools = src/tools.ts AxFunction[]) canNOT invoke them. RE-CONFIRM all names/lines/signatures at Scout.

GOAL: make the agent SELF-ORCHESTRATE — like an autonomous agent that fans out its own subagents. Expose the engine to the model as
TOOLS so it decides, mid-turn, to decompose/fan-out/judge/verify/loop or write+run a dynamic script. AxFunction handlers receive an
\`extra\` arg with { sessionId, ai, step, abortSignal, ... } (CONFIRM the exact fields at Scout) — that gives a tool the AxAIService +
session needed to run orchestration leaves.

THE NON-NEGOTIABLE SAFETY MODEL (an LLM that can spawn fan-outs that spawn fan-outs = runaway cost — bound it like a real engine):
  1) STRUCTURAL one-level recursion guard: leaves spawned BY an orchestration tool MUST run with a tool set that EXCLUDES the
     orchestration tools (orchestrate, run_orch_script) — include only the file tools (bash/read_file/write_file/edit_file/glob/grep/
     web_fetch). So a leaf physically cannot re-orchestrate. This is structural, NOT a depth counter (counters race under parallel).
     Implement by splitting the tool list: BASE_TOOLS (file tools) and ORCH_TOOLS (the two new ones); the main chat gen gets
     BASE_TOOLS+ORCH_TOOLS, every orchestration leaf gen gets BASE_TOOLS only.
  2) BUDGET ceiling: each self-orchestration runs under an allocate(total) budget (a sane default cap, e.g. derive from MAX_STEPS or a
     new AX2_ORCH_TOKEN_BUDGET env, default ~40k); on exhaustion BudgetExhaustedError aborts the sub-run and the tool returns a
     truncated/partial result string to the model rather than throwing the whole turn.
  3) BRANCH cap: orchestrate caps parallel leaves (e.g. max 4; clamp the model's request).
  4) abortSignal: thread extra.abortSignal so a cancelled turn cancels the sub-run.

PRINCIPLES: core stays EXACTLY 5 primitives in orch.ts — the tools live in tools.ts (or a new src/orch-tools.ts) and CALL the existing
orchestrate()/loadAndRunOrch()/recipes; do NOT add a 6th core prim. Sub-runs render in the SAME OrchTree (thread the emit/onEvent path)
and nest under the turn's span (one-trace-per-session intact). Fork AxMemory per concurrent leaf (reuse orch-run's optsFor discipline) —
NEVER share a mutating mem. Match style. Real @ax-llm/ax types. Unavoidable any => 'ponytail:' + 'Upgrade:'. GREEN GATE = ${CHECK} clean.
Commit each feature --no-verify, conventional message.
`

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'guardsImplemented', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' },
    checkOutput: { type: 'string' }, committed: { type: 'boolean' }, commitSha: { type: 'string' },
    guardsImplemented: { type: 'array', items: { type: 'string' }, description: 'which of the 4 safety guards are actually in the code, with file:line' },
    newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

phase('Scout')
const SCOUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const scout = (await parallel([
  () => agent(`Read src/tools.ts fully. Report: the AxFunction type shape (name/description/parameters/func), the EXACT \`extra\` object an AxFunction handler receives (every field — sessionId, ai, step, abortSignal, ...), how the tools array is exported + consumed by the chat gen in src/agent.ts. The new orchestration tools will be AxFunctions using extra.ai/sessionId. Cite file:line.\n\n${SPEC}`,
    { label: 'tools', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read src/orch-run.ts + src/orch-load.ts + src/orch-recipes.ts. Report verbatim: orchestrate() signature + how it's currently called from atoms (orchestrateAtom), loadAndRunOrch() signature, how the OrchPrims toolkit + emit/onEvent + optsFor (forked mem) are built, and how a sub-run would render in the OrchTree + nest under a span. The new tools call these. Cite file:line.\n\n${SPEC}`,
    { label: 'orch-entries', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read src/agent.ts: the chat AxGen def + how its functions/tools are passed, the turn() flow + span, MAX_STEPS, the budget/allocate usage, and BASE_PROMPT. Report how to (a) build a RESTRICTED leaf tool set (file tools only, no orch tools) for sub-run leaves, and (b) where the orchestration tools get added to the MAIN chat gen only. Cite file:line.\n\n${SPEC}`,
    { label: 'agent-wiring', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
])).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/3`)

const FEATURES = [
  { key: 'orch-tools', title: 'orch-tools',
    spec: `Build the agent-callable orchestration tools (in src/orch-tools.ts, exporting an AxFunction[]; or extend tools.ts — keep tools.ts lean). (1) Split tools: BASE_TOOLS = the existing file tools (bash/read_file/write_file/edit_file/glob/grep/web_fetch); ORCH_TOOLS = the two new ones. The main chat gen (agent.ts) gets BASE_TOOLS+ORCH_TOOLS; orchestration LEAVES get BASE_TOOLS only (structural one-level guard). (2) Tool \`orchestrate\`: params { task:string, strategy:'parallel'|'judge'|'verify'|'best_of_n' (default 'parallel'), branches?:number }. Handler uses extra.ai + extra.sessionId + extra.abortSignal to run the matching recipe/orchestrate() over the task with BASE_TOOLS-only leaves, under an allocate(budget) ceiling (default ~40k tokens or AX2_ORCH_TOKEN_BUDGET), clamping branches to <=4, forking mem per branch; returns the synthesized result as a string (on BudgetExhaustedError return a partial result string, do NOT throw the whole turn). Emits NodeEvents so it renders in the OrchTree under the turn's span. (3) Tool \`run_orch_script\`: params { name:string, message?:string }. Handler calls loadAndRunOrch against .ax/orch/<name> (trusted dir, path-escape already rejected) with the same budget/guard, returns the result string. (4) Mark the in-process-trust reality with a ponytail referencing the existing AxJSRuntime-sandbox upgrade. tsc green; core stays 5 prims; verify leaves do NOT carry the orch tools.` },
  { key: 'autonomy', title: 'autonomy',
    spec: `Teach the agent to self-orchestrate. Update BASE_PROMPT in src/agent.ts: add a concise section — the agent has \`orchestrate(task, strategy)\` and \`run_orch_script(name)\` tools; USE orchestrate when a task splits into independent parts (strategy 'parallel'), needs best-of-N or a verify-before-accept ('judge'/'verify'/'best_of_n'); USE run_orch_script after write_file-ing a custom \`.ax/orch/<name>.ts\` flow. State the bounds plainly so it self-limits: leaves run with file tools only (no nested orchestration — one level), a token budget caps each run, branches are capped at 4. Keep it terse. Do NOT regress the orchestration note already added (gen/dynamic-script). tsc green.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 70000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.title)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} MUST end green. Self-heal up to ${MAX_HEAL}. Mark shortcuts 'ponytail:' + 'Upgrade:'. When green, COMMIT alone (--no-verify) 'feat(orch): ${f.key} ...'. Report sha/diff/check tail, guardsImplemented (which of the 4 safety guards are in the code, file:line), new ponytails.\n\nCONTRACTS:\n${CONTRACTS}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" left ${CHECK} RED. Fix + re-run green, commit --no-verify.\nFAILING:\n${impl.checkOutput}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'safety-recursion', focus: `THE SAFETY MODEL — verify ALL 4 guards actually hold in code: (1) leaves spawned by orchestrate/run_orch_script get BASE_TOOLS only, NOT the orch tools (trace it — can a leaf turn reach the orchestrate tool? if yes = BLOCKER, infinite recursion); (2) a budget ceiling really bounds the sub-run + BudgetExhaustedError returns partial, not crash; (3) branches clamped <=4; (4) abortSignal threaded. Any guard missing/bypassable = blocker. Cite file:line.` },
    { k: 'correctness-purity', focus: `Does orchestrate/run_orch_script actually run the real recipes/orchestrate/loadAndRunOrch via extra.ai/sessionId, render in OrchTree, nest under the span, fork mem per branch? Core still EXACTLY 5 prims (tools CALL the engine, add no 6th prim)? No unmarked any/ponytail, no new dead export, single-turn + ^o//run paths unchanged? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Skeptical — default to blocker on any safety doubt. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: ${blockers.length} blockers`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}" (safety-critical — fix fully). Fix, ${CHECK} green, AMEND commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}" for your lens; blockers closed, no new ones? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, guards: impl ? impl.guardsImplemented : [], openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Cover: (1) both features green? (2) CAN THE AGENT NOW SELF-ORCHESTRATE — what tools does it have (orchestrate/run_orch_script), what can it do autonomously mid-turn? (3) THE SAFETY BOUNDS — confirm all 4 guards hold (structural one-level no-recursion, budget ceiling, branch cap, abort) with file:line; if ANY is missing say so LOUD. (4) residual (ponytails incl the in-process-trust one, anything red). (5) one line: is ax2 now a self-driving orchestrating agent, bounded? Headline anything red or any missing guard.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
