export const meta = {
  name: 'orch-round-2',
  description: 'Round 2 of the orchestration layer: correct concurrent tool routing (per-leaf nodeId-bound logger), velocity-adaptive tool window in the TUI tree, and the RLM node kind (AxAgent callbacks -> NodeEvents, rendered nested live). Sequential on main, self-heal to tsc-green + adversarial review, commit per feature.',
  whenToUse: 'Trigger AFTER orch-full-build has landed (emit-wire, recipes, budget-enforce, live-tree, demo-wire all committed + tsc green) and the tree confirmed working. Fixes the parallel-tool-routing gap and adds the polish + RLM nesting.',
  phases: [
    { title: 'Scout',         detail: 'pin orch-recipes, the live-tree NodeView, activity/atoms node state, ax AxAgent callbacks' },
    { title: 'leaf-logger',   detail: 'per-leaf nodeId-bound logger + id-routed sink — concurrent tool events route to the right branch' },
    { title: 'tool-window',   detail: 'ts on node tool events + velocity/acceleration-adaptive rolling tail in NodeView' },
    { title: 'rlm-node',      detail: 'rlmNode(axAgent) recipe: bridge actorTurnCallback/onFunctionCall/onContextEvent into NodeEvents; render nested live; TUI trigger' },
    { title: 'Report',        detail: 'status, what is now correct/visible, residual risk, next' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const MAX_HEAL = 4
const MAX_HARDEN = 2

const SPEC = `
ax2 orchestration layer ROUND 2. Round 1 already shipped on main: orch.ts (5 primitives leaf/parallel/pipeline/emit/allocate),
orch-recipes.ts (agent/judge/loopUntilDry/adversarialVerify + orchestrate()), budget enforcement (allocate + BudgetExhaustedError),
and live-tree (atoms NodeEvent reducer + chat.tsx recursive NodeView rendering the orchestration tree). RE-CONFIRM exact names/lines at Scout — do not hardcode from this spec.

ROUND-1 GAP THIS ROUND FIXES (the crux): under parallel(), multiple agent() leaves run concurrently and each fires ax tool events
(logger -> activity bus). Today the bus sink is effectively single-stream and tool events carry NO nodeId, so concurrent branches'
tool rows interleave and cannot be routed to the correct branch node. A module-global 'currentNodeId' is WRONG (races across fibers).

PRINCIPLES (unchanged): core stays EXACTLY 5 primitives in orch.ts; everything new is recipe/UI. Promise-native at combinator level,
Effect at session boundary + otel.ts. NEVER share a mutating AxMemory across concurrent leaves. Match surrounding style. Real
@ax-llm/ax types (read ../ax/src/ax when types break); unavoidable any => 'ponytail:' + 'Upgrade:' trigger (bun run debt enforces).
GREEN GATE = ${CHECK} clean. ${LINT} may stay RED only on PRE-EXISTING user dead exports (history/clipboard/toolui/abortTurn) —
never blame/delete those; every NEW export you add must be consumed.
`

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string' }, checkOutput: { type: 'string' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' },
    newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

// SCOUT
phase('Scout')
const SCOUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const SCOUT = [
  { key: 'orch-recipes', prompt: `Read src/orch.ts and src/orch-recipes.ts. Report verbatim: the agent() recipe signature + how it calls leaf() and passes opts, whether opts already carries a per-call logger, the orchestrate() entry, how emit() pushes NodeEvents, and the Budget/charge path. The leaf-logger fix threads a nodeId-bound logger through agent(); the rlm-node adds a sibling recipe.` },
  { key: 'live-tree-ui', prompt: `Read src/chat.tsx (the NodeView + how nodes render) and src/atoms.ts (the node-state reducer + activity sink handler) and src/activity.ts (Activity union incl any 'node' variant + how tool events are tagged). Report: exact node-state shape, how tool steps attach to a node today, the sink routing, and where a per-node tool-window selector + ts field slot in. Cite file:line.` },
  { key: 'ax-logger', prompt: `Read ../ax/src/ax (ai + dsp). Report: the AxLoggerFunction signature + what payload it emits per tool call/result, and that AxAIServiceOptions.logger (per-forward) overrides the service logger. This is how each leaf injects its OWN nodeId-bound logger so tool events self-route. Cite file:line.` },
  { key: 'ax-agent-cb', prompt: `Read ../ax/src/ax/agent. Report exact payload shapes for AxAgent callbacks usable to render RLM nesting live: actorTurnCallback (AxAgentActorTurnCallbackArgs), onFunctionCall, onContextEvent, and the llmQuery sub-call path + AxLlmQueryBudgetState (depth). The rlm-node recipe maps these to NodeEvents (start/delta/done + nested parentId). Cite file:line.` },
]
const scout = (await parallel(SCOUT.map(s => () =>
  agent(`${s.prompt}\n\nStructured facts, area="${s.key}", verbatim signatures, cite file:line.\n\n${SPEC}`,
    { label: s.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' })
))).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/4`)

const FEATURES = [
  { key: 'leaf-logger', title: 'leaf-logger',
    spec: `Fix concurrent tool-event routing. (1) In src/orch-recipes.ts agent() recipe: build a per-leaf logger bound to that node's nodeId (a function closing over nodeId that emits a node-tagged tool Activity), and pass it as the per-forward logger via leaf's opts (AxAIServiceOptions.logger — confirm the field from scout; if LeafOpts must carry logger, add it without breaking leaf's core signature/shape). NO module-global currentNodeId. (2) Make the activity sink id-routed: tool events tagged with nodeId attach to that node in atoms (extend the reducer). (3) Verify: under a parallel() of >=2 agent() leaves, each branch's tool rows attach to the correct branch node in the tree (reason through it / add a tiny test if cheap). tsc green; do not change the 5-primitive core.` },
  { key: 'tool-window', title: 'tool-window',
    spec: `Velocity/acceleration-adaptive tool tail in the TUI. (1) Ensure each node-tagged tool Activity carries a timestamp (add ts where the sink records it — pass a real clock value at record time; do NOT use Date.now inside any workflow/orchestration-determinism path, this is pure UI runtime state so a runtime clock is fine in app code). (2) In src/chat.tsx NodeView: add a toolWindow(node, now) selector that renders only the last N tool rows for a RUNNING node, where N = clamp(BASE - k*velocity, 1, MAX) with velocity = tools/sec over a rolling ~2s window, shrink faster on positive acceleration (burst), grow slower on deceleration, with hysteresis to avoid flicker; show a '+M more' affordance for hidden rows. Full list still kept in state. On node done: collapse to a one-line summary (count + per-kind tally). On focus/expand: override the window, show all. Recompute on tool-event tick, not every frame (respect opentui batching). tsc green; no behavior change to non-orchestration transcript.` },
  { key: 'rlm-node', title: 'rlm-node',
    spec: `Add the RLM node kind so an AxAgent (RLM) run renders nested live. (1) In src/orch-recipes.ts add rlmNode(nodeId, axAgent, opts, ai, input): run the AxAgent forward threading tracer/traceContext (nest under the session span) AND wiring its callbacks (actorTurnCallback/onFunctionCall/onContextEvent + llmQuery depth from AxLlmQueryBudgetState — exact shapes from scout) into emit() NodeEvents with correct parentId so Distiller/Executor/llmQuery/Responder render as nested nodes. Forked AxMemory if it fans out concurrently. (2) Wire a TUI trigger (a key via useKeyboard, distinct from the parallel demo) that runs an RLM orchestration for the current input. (3) Keep core at 5 primitives — rlmNode is a recipe. tsc green; verify the trigger path typechecks end-to-end.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.title)
  let impl = await agent(
    `Implement round-2 feature "${f.key}" in the ax2 main working tree. Build on round-1 (already on main).\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} MUST end green (modulo pre-existing user dead exports). Self-heal up to ${MAX_HEAL}. Mark deliberate shortcuts 'ponytail:' + 'Upgrade:'. When green, COMMIT this feature alone (--no-verify) 'feat(orch): ${f.key} ...'. Report sha/diff/check tail/new ponytails.\n\nCONTRACTS:\n${CONTRACTS}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`Feature "${f.key}" left ${CHECK} RED. Fix + re-run to green, commit --no-verify.\nFAILING:\n${impl.checkOutput}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'routing', focus: `CONCURRENCY CORRECTNESS: under parallel branches, do tool events route to the RIGHT node (no module-global node id, no fiber race, no shared mutating AxMemory)? For tool-window, is velocity/accel math sound + flicker-free? For rlm-node, do nested NodeEvents carry correct parentId? Cite file:line.` },
    { k: 'orthogonality', focus: `CORE + DEBT: core still EXACTLY 5 primitives (new code is recipe/UI only)? No unmarked any/ponytail, no new dead export, non-orchestration transcript behavior unchanged? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Skeptical. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: ${blockers.length} blockers`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix in tree, ${CHECK} green, AMEND the feature commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}" for your lens; blockers closed, no new ones? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final round-2 report for the ax2 author (blunt, terse, full substance, markdown). Cover: (1) HEADLINE — features landed green, anything failed. (2) PER-FEATURE one line: status/sha/what it fixes-or-adds/open blocker. (3) IS THE PARALLEL-TOOL-ROUTING GAP NOW CLOSED? say plainly. (4) what the TUI tree now shows (adaptive tool tail? RLM nested?). (5) residual risk (new ponytails, lint-red pre-existing user exports, unsound casts). (6) NEXT most-valuable follow-up. Do not oversell; headline anything red.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
