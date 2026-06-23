export const meta = {
  name: 'orch-full-build',
  description: 'Build the full orchestration layer on top of the orch skeleton: emit-wire, userland recipes, budget enforcement, live TUI tree, and a real triggerable multi-node run. Sequential on main, self-heal to tsc-green + adversarial review per feature, commit each as a checkpoint.',
  phases: [
    { title: 'Scout',          detail: 'parallel read-only: pin orch.ts, activity bus, atoms, chat.tsx, usage readers' },
    { title: 'emit-wire',      detail: 'emit() -> emitActivity + OTel span annotation' },
    { title: 'recipes',        detail: 'agent/judge/loopUntilDry/adversarialVerify userland helpers (consume the skeleton exports)' },
    { title: 'budget-enforce', detail: 'allocate() reads real usage + typed BudgetExhaustedError' },
    { title: 'live-tree',      detail: 'atoms NodeEvent reducer + chat.tsx recursive NodeView (the live orchestration tree)' },
    { title: 'demo-wire',      detail: 'orchestrate() entry + TUI trigger running a real multi-node fan-out end-to-end' },
    { title: 'Report',         detail: 'final status, diff summary, residual risk, what is now usable' },
  ],
}

const CHECK = 'bun run check'        // tsc --noEmit + Effect LS — the hard green gate
const LINT = 'bun run lint'          // check + analyze + debt — informational (stays red on pre-existing user dead exports)
const MAX_HEAL = 4
const MAX_HARDEN = 2

const CORE_SPEC = `
ax2 orchestration layer. orch.ts ALREADY EXISTS on main with the 5-primitive CORE:
  leaf<I,O>(gen,opts)=>(ai,input)=>gen.forward(...)   // only thing that calls ax; opts=LeafOpts (mem,sessionId,tracer,traceContext,maxSteps,stream,abortSignal)
  parallel(thunks)=>Promise.all(.catch(()=>null))     // fan-out; failed=>null; .filter(Boolean)
  pipeline(items,...stages)                            // no-barrier async-generator sequence
  emit(NodeEvent,opts):Effect<void>                    // STUB today (Effect.void); wire it in emit-wire
  allocate(total):Budget                               // STUB today (0/total/no-op); wire it in budget-enforce
NodeEvent = {type:'start',nodeId,parentId?,phase} | {type:'delta',nodeId,chunk} | {type:'done',nodeId,result} | {type:'error',nodeId,cause}
Budget = {total; spent():Promise<number>; remaining():Promise<number>; freeze(reason):void}
PRINCIPLES: core stays EXACTLY 5 primitives. agent()/judge/loopUntilDry/adversarialVerify are USERLAND recipes (each <15 lines), NEVER added to core. Promise-native at combinator level; Effect at the session boundary (turn() in agent.ts) and otel.ts only. Match surrounding code style. Real @ax-llm/ax types where exported; minimal local structural types else; unavoidable any => 'ponytail:' comment WITH an 'Upgrade:' trigger (bun run debt enforces). Local deps in ../ (ax, opentui, motel, effect-smol) — read there when beta types break, not npm.
GREEN GATE = ${CHECK} clean. ${LINT} may stay RED ONLY on PRE-EXISTING user dead exports (history/clipboard/toolui x3/agent.ts abortTurn) — never blame those on this work, never delete the user's in-flight files. But every NEW export YOU add MUST be consumed (no new dead exports).
`

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string', description: 'green | red (green = check clean modulo pre-existing)' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string', description: 'unified git diff of THIS feature' },
    checkOutput: { type: 'string', description: 'final check tail: "clean" or verbatim errors' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    newPonytails: { type: 'array', items: { type: 'string' }, description: 'any ponytail: markers this feature added, with Upgrade trigger' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
      properties: {
        severity: { type: 'string' }, isBlocker: { type: 'boolean' },
        where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' },
      } } },
  },
}

// ---------------------------------------------------------------------------
// SCOUT — pin the contracts the build needs.
// ---------------------------------------------------------------------------
phase('Scout')
const SCOUT = [
  { key: 'orch-current', prompt: `Read src/orch.ts in full. Report verbatim: every export + signature, LeafOpts fields, NodeEvent/Budget shapes, the two ponytail stubs (emit, allocate) and their exact current bodies, and the LeafOpts->AxProgramForwardOptions cast site. This is what recipes/emit/budget build on.` },
  { key: 'activity-bus', prompt: `Read src/activity.ts and src/atoms.ts. Report the EXACT activity bus contract: the Activity union variants + fields, emitActivity signature, setActivitySink mechanism, and HOW atoms.ts consumes activities into UI state (the sink handler, the SessionView/messages shape, how tool/result correlate). emit() must hook this; the live-tree reducer extends it. Cite file:line.` },
  { key: 'chat-ui', prompt: `Read src/chat.tsx and src/toolui.ts. Report: how the transcript renders (the turn/message mapping, collapsible tool views, ToolView/markdown usage), the opentui JSX elements + hooks in use (box/text/scrollbox, useKeyboard), and where a recursive orchestration-node tree view would slot in. The live-tree feature renders NodeEvent state here. Cite file:line.` },
  { key: 'usage-otel', prompt: `Read src/agent.ts (the turn() fn, the usage readers readUsage/sumUsage, max-steps detection, the OTel span/tracer setup, otelContext.with usage) and src/otel.ts. Report: exact usage-reader signatures + what they read from a forward result, how spans are created/named (chat.session/chat.turn), and how to annotate the active span. budget-enforce + emit-wire need these. Cite file:line.` },
]
const SCOUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const scout = (await parallel(SCOUT.map(s => () =>
  agent(`${s.prompt}\n\nReturn structured facts. area="${s.key}". Copy signatures verbatim; cite file:line. Do not invent.\n\n${CORE_SPEC}`,
    { label: s.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' })
))).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/4 contracts`)

// ---------------------------------------------------------------------------
// FEATURES — built strictly in order; each depends on the prior. SEQUENTIAL
// (shared working tree on main — no parallel writers).
// ---------------------------------------------------------------------------
const FEATURES = [
  { key: 'emit-wire', title: 'emit-wire',
    spec: `Wire emit(event:NodeEvent, opts?):Effect<void> in src/orch.ts to: (1) map each NodeEvent variant to an Activity and push via emitActivity (use the EXACT Activity union + emitActivity signature from scout — if NodeEvent has no clean Activity variant, add a minimal 'node' Activity variant in activity.ts and handle it in the atoms sink as a no-op-for-now so nothing breaks), and (2) annotate the active OTel span (addEvent/attributes) using the otel api already imported. Keep return type Effect<void>. REMOVE the emit ponytail marker (it is now real). Do not change the 5-primitive core shape. tsc must stay green.` },
  { key: 'recipes', title: 'recipes',
    spec: `Create src/orch-recipes.ts (userland, NOT core) exporting small helpers that CONSUME the skeleton exports (leaf, parallel, pipeline, emit) so they are no longer dead: \n- agent(nodeId, gen, opts, ai, input): emits start, runs leaf(gen,opts)(ai,input), emits done/error, returns O.\n- judge(ai, candidates[], judgeGen, judgeOpts): build a judge input from candidates, run one leaf, return the chosen result. <15 lines.\n- loopUntilDry(body:()=>Promise<T>, isDry:(prev,next)=>boolean, max=8): while-loop, returns accumulated.\n- adversarialVerify(produce:()=>Promise<T>, skeptics:Array<(x:T)=>Promise<boolean>>, accept=(votes)=>...): produce once, parallel() the skeptics, vote.\nEach must be correctly typed (real @ax-llm/ax types; no unmarked any). These are recipes — keep them tiny and composed only from the 5 core prims. tsc green; the new exports must themselves be consumed OR exported for app use (they are the public recipe surface — fine to export; note analyze may flag until demo-wire uses them).` },
  { key: 'budget-enforce', title: 'budget-enforce',
    spec: `Make allocate(total):Budget real in src/orch.ts. Add a typed class BudgetExhaustedError. Budget should hold an internal used-token tally; add a method to charge usage after a leaf (derive token count using the usage reader shape from scout — readUsage/sumUsage in agent.ts); spent()/remaining() reflect the tally; freeze(reason) and over-budget conditions throw BudgetExhaustedError. Wire the charge into agent()/leaf path if clean to do so WITHOUT changing leaf's core signature (prefer: agent() recipe charges the budget from the forward result's usage). REMOVE the allocate ponytail marker. Replace any string-matched max-steps budget notion only if trivial; otherwise leave turn()'s existing recovery intact. tsc green.` },
  { key: 'live-tree', title: 'live-tree',
    spec: `Render the live orchestration tree in the TUI. In src/atoms.ts: add orchestration-node state to the session view — a nodes map keyed by nodeId carrying {parentId?, label, phase, status:'running'|'done'|'error', result?} plus an ordered root list; feed it by handling the NodeEvent-derived 'node' activities in the existing activity sink (extend the sink handler from scout). In src/chat.tsx: add a recursive NodeView component (indent per depth, status glyph running/done/error, collapsible) that renders the nodes tree, reusing ToolView for any tool steps under a node, matching the existing transcript style + opentui elements from scout. Auto-expand running nodes. Do NOT break the existing single-turn transcript (orchestration tree shows only when nodes exist). tsc green.` },
  { key: 'demo-wire', title: 'demo-wire',
    spec: `Prove the whole stack end-to-end. Add an orchestrate() entry (in src/orch-recipes.ts or a new src/orch-run.ts) that, given the user message + session ctx, runs a REAL multi-node flow using the recipes — e.g. parallel() fan-out of 2-3 agent() leaves over the message (or a judge over 2 candidates) — emitting NodeEvents throughout so the live-tree renders. Wire a TUI trigger in src/chat.tsx (a key via useKeyboard, e.g. ctrl+o or a slash-style) that dispatches this orchestration for the current input instead of the normal single turn, through the same chat.session span (one-trace-per-session preserved) and the same per-session AxMemory discipline (fork memory per parallel branch — never share a mutating AxMemory across concurrent leaves; merge single-threaded). This consumes the recipe exports => analyze dead-export findings for them clear. tsc green; verify the trigger path typechecks end-to-end.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low (${Math.round(budget.remaining()/1000)}k) — stopping before ${f.key}`); break }
  phase(f.title)

  // implement (edits main, self-heals, commits when green)
  let impl = await agent(
    `Implement feature "${f.key}" in the ax2 main working tree (current branch). Build on what already exists — earlier features in this run are already committed.\n\nFEATURE SPEC:\n${f.spec}\n\nRules: ${CHECK} MUST end green (modulo pre-existing user dead exports). Self-heal: if check is red, fix and re-run, up to ${MAX_HEAL} attempts. Add a 'ponytail:' marker (with 'Upgrade:' trigger) for any deliberate shortcut. When green, COMMIT this feature alone with --no-verify and a conventional message 'feat(orch): ${f.key} ...'. Report the commit sha, the diff, check tail, any new ponytails.\n\nSCOUTED CONTRACTS (ground truth):\n${CONTRACTS}\n\n${CORE_SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })

  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++
    log(`${f.key}: heal ${heal} (check red)`)
    impl = await agent(
      `Feature "${f.key}" left ${CHECK} RED. Diagnose + fix in the working tree, re-run until green (modulo pre-existing user dead exports), then commit with --no-verify.\n\nFAILING:\n${impl.checkOutput}\n\nReturn the structured result.\n\n${CORE_SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }

  // adversarial review — 2 lenses, parallel (read-only, safe to fan out)
  const LENSES = [
    { k: 'correctness', focus: `CORRECTNESS + BEHAVIOR: does ${f.key} actually work as specified, typecheck soundly (no hidden any/unsound cast masking a bug), preserve existing single-turn behavior, and respect the per-session AxMemory no-share-across-concurrent rule? Cite file:line.` },
    { k: 'orthogonality', focus: `ORTHOGONALITY + DEBT: did it keep CORE to exactly the 5 primitives (no recipe smuggled into core, no duplicate event bus), consume the exports it should, add no UNMARKED any/ponytail, and introduce no NEW dead export beyond the documented skeleton ones? Cite file:line.` },
  ]
  const reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review the just-committed "${f.key}" change (read the touched files + the diff). Default skeptical. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : '(impl failed)'}\n\n${CORE_SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: ${reviews.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)} findings, ${blockers.length} blockers`)

  // harden blockers
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++
    log(`${f.key}: harden ${hr} (${blockers.length} blockers)`)
    impl = await agent(
      `Review found BLOCKERS in "${f.key}". Fix each in the working tree, keep core at 5 primitives + behavior intact, re-run ${CHECK} to green, then AMEND the feature commit (--no-verify).\n\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\nReturn the structured result.\n\n${CORE_SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}" for your lens, confirm blockers closed, no new ones. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : ''}\n\n${CORE_SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }

  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null,
    openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [], healUsed: heal, files: impl ? impl.filesChanged : [] })
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------
phase('Report')
const report = await agent(
  `Write the final build report for the ax2 author (blunt, terse, full technical substance, markdown). The orchestration layer was built feature-by-feature on main, each committed.\n\nCover: (1) HEADLINE — how many of the 5 features landed green, anything failed/partial — say it plainly. (2) PER-FEATURE — one tight line each: status, commit sha, what it enables, any open blocker. (3) WHAT IS NOW USABLE — can the user trigger a live multi-node orchestration in the TUI? what shows in the tree? is budget enforced? (4) RESIDUAL RISK — new ponytails (with Upgrade triggers), the known lint-red pre-existing user dead exports (not ours), any unsound cast. (5) NEXT — the single most valuable follow-up. If anything is red or has open blockers, headline it, do not oversell.\n\nRESULTS (JSON):\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })

return { features: results, report }
