export const meta = {
  name: 'implement-orch-skeleton',
  description: 'Implement ax2 src/orch.ts — a faithful port of the ultracode Workflow engine onto ax. Scouts current state, locks exact edits, implements + self-heals until check/lint green, adversarially reviews, hardens, reports.',
  whenToUse: 'Trigger when ready to build the orchestration layer (orch.ts). Default scope = walking-skeleton milestone 1 (leaf/parallel/pipeline + emit/allocate stubs + one agent.ts callsite refactor). Pass args to widen scope.',
  phases: [
    { title: 'Setup',     detail: 'create external git worktree (sibling), link node_modules, copy .env — main checkout untouched' },
    { title: 'Scout',     detail: 'parallel read-only: pin exact current lines, contracts, build baseline' },
    { title: 'Lock',      detail: 'merge facts + embedded spec into an exact, line-accurate edit plan' },
    { title: 'Implement', detail: 'apply edits in real tree, self-heal until check+lint green' },
    { title: 'Review',    detail: 'parallel skeptics: behavior-preservation, opts-exactness, scope-creep' },
    { title: 'Harden',    detail: 'fix any blocker findings, re-verify' },
    { title: 'Report',    detail: 'final diff + status + residual risk + next deferred item' },
  ],
}

// ===========================================================================
// SELF-CONTAINED SPEC — the fixated design, embedded so this workflow needs
// zero prior conversation/memory context when triggered later.
// ===========================================================================
const SPEC = `
ax2 src/orch.ts = a faithful PORT of the assistant's ultracode Workflow engine onto @ax-llm/ax.
ax2 is a Bun + TypeScript multi-session TUI coding agent: Effect v4 core, opentui (React) UI,
real OpenTelemetry -> local motel. LLM = Cloudflare Workers AI (@cf/moonshotai/kimi-k2.7-code) via @ax-llm/ax.

CURRENT STATE (orch.ts does NOT exist yet). Flow today:
  user msg -> sendAtom (src/atoms.ts) -> turn() (src/agent.ts) -> ONE gen.forward() call.
  The forward callsite looks like:
    gen.forward(llm, { message: msg }, { mem, sessionId, tracer, traceContext, maxSteps: MAX_STEPS, stream: false })
  'chat' generator is defined like:
    const chat = ax("message:string -> reply:string", { functions: tools })
  (Exact file:line MUST be re-confirmed at Scout time — line numbers drift. Do NOT hardcode line numbers from this spec.)

CORE = EXACTLY 5 orthogonal primitives. Nothing else is engine. Promise-native at the orch level;
Effect stays at the session boundary (turn) and in otel.ts, NOT inside the combinators.

  1. leaf<I,O>(gen, opts) => (ai, input) => gen.forward(ai, input, opts)
        The ONLY thing that calls ax. 'opts' (LeafOpts) MUST equal the real forward opts bag
        confirmed at Scout (mem, sessionId, tracer, traceContext, maxSteps, stream, plus any others present).
  2. parallel(thunks)  => Promise.all(thunks.map(t => t().catch(() => null)))
        The ONLY fan-out. Failed slots resolve to null (never reject). Callers .filter(Boolean).
  3. pipeline(items, ...stages)
        The ONLY sequence. NO barrier between stages (item A may be in stage 3 while B is in stage 1).
        Async-generator fan-through.
  4. emit(NodeEvent, opts): Effect<void>
        Thin hook over the EXISTING activity bus (src/activity.ts emitActivity/setActivitySink) + OTel span
        annotation. Do NOT invent a second event system. NodeEvent =
          | { type:'start'; nodeId; parentId?; phase }
          | { type:'delta'; nodeId; chunk }
          | { type:'done';  nodeId; result }
          | { type:'error'; nodeId; cause }
  5. allocate(total): Budget   where Budget = { total; spent(): Promise<number>; remaining(): Promise<number>; freeze(reason): void }
        Token gate. Reads usage via the existing usage reader in agent.ts.

CUT FROM CORE -> userland recipes (NEVER engine primitives; each writable in the 5 prims in <15 lines):
  - agent(prompt, opts)          = a named leaf wrapper.
  - judge / adversarialVerify    = parallel([...]) + a pure comparator function.
  - loopUntilDry                 = a while-loop over leaf().
  - workflow(name, args)         = a labeled parallel([...]); do not reify, just name the span.
  - multi-modal-sweep / completeness-critic = stacked parallel + pipeline.

ax2 SUPERPOWERS over a poll-based engine (exploit, do not just port):
  - PUSH UI: opentui live tree via activity bus; no polling.
  - Effect cancellation: parallel branches = a scoped fiber set; killing the run interrupts the scope;
    any resource cleanup (future worktrees) must use Effect.ensuring / finally.
  - Dynamic authoring (LATER): model emits orchestration JS into AxJSRuntime (Bun smol Worker).

MILESTONE 1 = WALKING SKELETON (this workflow's DEFAULT scope). Exactly:
  a. Create src/orch.ts exporting: leaf, parallel, pipeline (full bodies, Promise-native) +
     emit, allocate as signature-real STUBS (typed, bodies = minimal TODO that compiles and is type-correct).
  b. Refactor the single forward callsite in src/agent.ts to go through leaf:
        leaf(chat, opts)(llm, { message: msg })   // BEHAVIOR-IDENTICAL. This is the only invasive change.
     Preserve the exact opts bag and the exact returned value/awaiting semantics.
  c. NO behavior change. The app must run identically. No new runtime dependency.
  Types: import AxAIService, AxGen, and the gen output/opts types from '@ax-llm/ax'. If a needed type is
  not exported, define a minimal local structural type rather than 'any' where reasonable; mark unavoidable
  'any' with a 'ponytail:' comment + 'Upgrade:' trigger (repo convention; 'bun run debt' enforces it).

DEFERRED (NOT built unless args.scope explicitly requests; each waits for its triggering use case):
  emit-wire (emit -> emitActivity + span), budget-enforce (typed BudgetExhaustedError replacing the
  string-matched max-steps detection), dynamic '/run' saved scripts, resume journal (src/journal.ts),
  worktree isolation. Resume-by-journal + leaf/control split are proven (Temporal/Restate). Worktree-per-agent,
  token *enforcement* (ax taskBudget is advisory only), and /run are speculative for ax2 -> LATER, never core.

REPO CONVENTIONS:
  - 'bun run check'  = tsc --noEmit + Effect LS. MUST be green.
  - 'bun run lint'   = check + analyze + debt. analyze = dead exports / unused imports / circular deps /
                       cyclomatic+nesting+param budgets. debt = every 'ponytail:' marker needs an 'Upgrade:' trigger.
  - Match surrounding code style (comment density, naming, idiom). Read neighboring files first.
  - Deliberate shortcuts get a 'ponytail:' marker (ceiling + Upgrade trigger).
  - Local source deps live in ../ (effect-smol, opentui, motel, ax) — read those when beta types break, not npm docs.
`

// ---------------------------------------------------------------------------
// args (all optional). Pass as real JSON, e.g. { scope:"skeleton", maxFixRounds:4 }
// ---------------------------------------------------------------------------
const A = (args && typeof args === 'object') ? args : {}
const SCOPE = A.scope || 'skeleton'                       // 'skeleton' | 'skeleton+emit-wire' | 'skeleton+budget' | etc.
const MAX_FIX_ROUNDS = Number.isInteger(A.maxFixRounds) ? A.maxFixRounds : 4
const MAX_HARDEN_ROUNDS = Number.isInteger(A.maxHardenRounds) ? A.maxHardenRounds : 2
const BRANCH = A.branch || 'feat/orch-skeleton'
const CHECK_CMD = A.checkCmd || 'bun run check'
const LINT_CMD = A.lintCmd || 'bun run lint'

// ISOLATION. Default: a self-managed EXTERNAL git worktree (sibling of the repo)
// so triggering never moves the current checkout's branch. Sibling path keeps the
// relative source deps (../ax, ../opentui, ../motel, ../effect-smol) resolving, and
// node_modules is symlinked + .env copied (mirrors .worktreeinclude intent) so
// check/lint/chat run immediately. Pass worktree:false to edit the repo in place,
// or worktree:"/abs/path" to choose the location.
const WT = (A.worktree === false) ? null
  : (typeof A.worktree === 'string' ? A.worktree : '../ax2-orch-skeleton')
// Every file/command-touching agent is pinned to this dir. Pure-reasoning agents skip it.
const WD_NOTE = WT
  ? `WORKING DIRECTORY: all file reads, edits, and shell commands MUST run inside the worktree at \`${WT}\` (an external git worktree of this repo). cd there or pass the path explicitly. Do NOT touch the main checkout. The branch "${BRANCH}" is already checked out there.\n\n`
  : ''
// reviewer fleet scales with token budget when one is set, else fixed 3 (the 3 design lenses)
const REVIEW_LENSES = [
  { key: 'behavior', focus: 'BEHAVIOR PRESERVATION: does routing the forward() through leaf() change ANY observable behavior — the returned value, awaiting/Promise semantics, error propagation, streaming flag, OTel span parentage (one-trace-per-session must hold), or the activity-bus output? The skeleton MUST be a pure refactor.' },
  { key: 'opts-exact', focus: 'OPTS EXACTNESS: is LeafOpts EXACTLY the real forward opts bag (mem, sessionId, tracer, traceContext, maxSteps, stream, and anything else actually passed at the callsite)? Any dropped/renamed/added field, any widening to a loose type that hides a missing field, is a blocker. Cross-check leaf signature vs the actual callsite.' },
  { key: 'scope-creep', focus: 'SCOPE + ORTHOGONALITY: did the implementer keep CORE to exactly the 5 primitives? Flag any judge/adversarialVerify/loopUntilDry/agent helper smuggled into core, any new event bus duplicating activity.ts, any emit/allocate body that does more than a typed stub (unless args.scope requested it), any unrequested dependency, any unmarked any/ponytail.' },
]

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'facts', 'cites', 'risks'],
  properties: {
    area: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' }, description: 'exact, copy-from-source facts (signatures, opts fields, fn names)' },
    cites: { type: 'array', items: { type: 'string' }, description: 'file:line for every load-bearing fact' },
    risks: { type: 'array', items: { type: 'string' }, description: 'things that could make the refactor non-trivial' },
  },
}
const BASELINE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['checkGreen', 'lintGreen', 'preexistingErrors'],
  properties: {
    checkGreen: { type: 'boolean' },
    lintGreen: { type: 'boolean' },
    preexistingErrors: { type: 'array', items: { type: 'string' }, description: 'errors present BEFORE any edit — must not be blamed on this change' },
  },
}
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['leafOptsType', 'callsite', 'orchExports', 'edits', 'imports', 'notes'],
  properties: {
    leafOptsType: { type: 'string', description: 'the exact TS shape LeafOpts must have, derived from the real callsite' },
    callsite: { type: 'object', additionalProperties: false, required: ['file', 'line', 'currentCode', 'newCode'],
      properties: { file: { type: 'string' }, line: { type: 'integer' }, currentCode: { type: 'string' }, newCode: { type: 'string' } } },
    orchExports: { type: 'array', items: { type: 'string' }, description: 'exact export signatures for src/orch.ts' },
    edits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'action', 'what'],
      properties: { file: { type: 'string' }, action: { type: 'string', description: 'create|edit' }, what: { type: 'string' } } } },
    imports: { type: 'array', items: { type: 'string' }, description: 'exact import lines orch.ts needs + whether each type is exported by @ax-llm/ax' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}
const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'lintOutput', 'fixRoundsUsed', 'notes'],
  properties: {
    status: { type: 'string', description: 'green | red' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string', description: 'unified git diff of all changes' },
    checkOutput: { type: 'string', description: 'tail of the final check run (errors verbatim, or "clean")' },
    lintOutput: { type: 'string', description: 'tail of the final lint run (errors verbatim, or "clean")' },
    fixRoundsUsed: { type: 'integer' },
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
        severity: { type: 'string', description: 'blocker|major|minor|nit' },
        isBlocker: { type: 'boolean' },
        where: { type: 'string', description: 'file:line' },
        problem: { type: 'string' },
        fix: { type: 'string' },
      } } },
  },
}

// ===========================================================================
// PHASE 0 — SETUP. Create the external worktree (unless worktree:false).
// ===========================================================================
if (WT) {
  phase('Setup')
  const setup = await agent(
    `Create an EXTERNAL git worktree for an isolated implementation, WITHOUT changing the current checkout's branch. Steps, from the repo root:\n` +
    `1. If a worktree at \`${WT}\` already exists (\`git worktree list\`), reuse it; else create it on a NEW branch off the current HEAD:\n` +
    `   git worktree add -b ${BRANCH} ${WT} HEAD   (if branch ${BRANCH} already exists, use: git worktree add ${WT} ${BRANCH})\n` +
    `2. Make it runnable (mirrors .worktreeinclude): symlink node_modules and copy .env:\n` +
    `   ln -sfn "$(pwd)/node_modules" ${WT}/node_modules\n` +
    `   cp -n .env ${WT}/.env  2>/dev/null || true\n` +
    `3. Verify: from inside ${WT}, run \`git status\` (clean, on ${BRANCH}) and confirm \`${CHECK_CMD}\` STARTS (deps resolve). Report the absolute worktree path, the branch, and whether deps/.env are in place.\n\n` +
    `Do NOT edit any source yet. Do NOT touch the main checkout's branch.`,
    { label: 'setup-worktree', phase: 'Setup', agentType: 'general-purpose' })
  log(`worktree ready: ${WT} on ${BRANCH}`)
}

// ===========================================================================
// PHASE 1 — SCOUT (parallel, read-only). Pin exact current state + build baseline.
// ===========================================================================
phase('Scout')
const SCOUT_TARGETS = [
  { key: 'forward-callsite', prompt: `Read src/agent.ts. Find the EXACT single gen.forward() callsite (the one turn() runs) and the 'chat' generator definition (ax("message:string -> reply:string", {...})). Report: the precise file:line of the forward call, the EXACT opts object passed (every field name), how its result is awaited/returned, the 'chat'/gen variable name, and the names of any usage reader / max-steps detection helpers nearby (the budget/allocate primitive will reuse them).` },
  { key: 'activity-bus', prompt: `Read src/activity.ts and src/atoms.ts. Report the EXACT activity-bus contract: the Activity union variants, the emit function name + signature, the setActivitySink/sink mechanism, and how atoms consume activities into UI state. The orch 'emit' primitive must hook this, not replace it. Cite file:line.` },
  { key: 'types-style', prompt: `Read src/tools.ts, src/sessions.ts, and the top imports of src/agent.ts. Report: which types are imported from '@ax-llm/ax' today (AxFunction, AxMemory, AxAIService, AxGen, etc.), the code style (comment density, naming idiom, how 'ponytail:' markers are written), and the tsconfig module setup. Also check ../ax/src/ax/index.ts for whether AxGen + the forward opts type + gen-output type are EXPORTED (the new orch.ts must import real types, not any). Cite file:line.` },
]
const scoutThunks = SCOUT_TARGETS.map(t => () =>
  agent(`${WD_NOTE}${t.prompt}\n\nReturn structured facts. area="${t.key}". Copy signatures verbatim from source; cite file:line for every fact. Do not invent.\n\nCONTEXT SPEC (for orientation only — re-verify against live source):\n${SPEC}`,
    { label: t.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }))
// baseline build status in parallel with the readers
const baselineThunk = () =>
  agent(`${WD_NOTE}Run \`${CHECK_CMD}\` then \`${LINT_CMD}\` WITHOUT editing anything. Report whether each is currently green and list any PRE-EXISTING errors verbatim (so a later diff is not blamed for them). Read-only except running the commands.`,
    { label: 'baseline', phase: 'Scout', schema: BASELINE_SCHEMA, agentType: 'general-purpose' })

const scoutAll = (await parallel([...scoutThunks, baselineThunk]))
const scout = scoutAll.slice(0, SCOUT_TARGETS.length).filter(Boolean)
const baseline = scoutAll[scoutAll.length - 1]
log(`scouted ${scout.length}/${SCOUT_TARGETS.length} areas · baseline check=${baseline ? baseline.checkGreen : 'unknown'} lint=${baseline ? baseline.lintGreen : 'unknown'}`)

// ===========================================================================
// PHASE 2 — LOCK (single architect, read-only). Produce the exact edit plan.
// ===========================================================================
phase('Lock')
const plan = await agent(
  `You are locking the EXACT edit plan for ax2 milestone-1 (scope="${SCOPE}"). Use ONLY the scouted facts for line numbers / signatures — they are ground truth; the embedded spec is intent.\n\nProduce: (1) leafOptsType = the precise TS type LeafOpts must be, derived field-for-field from the REAL forward opts bag the scout found; (2) callsite = the current code + the new code (leaf(chat, opts)(llm, {message}) form, behavior-identical); (3) orchExports = exact export signatures for leaf/parallel/pipeline (full) + emit/allocate (typed stubs); (4) edits list; (5) imports (exact lines + whether each type is exported by @ax-llm/ax, per scout — if NOT exported, specify a minimal local structural type instead of any); (6) notes on anything tricky.\n\nThe plan MUST keep CORE to exactly the 5 primitives. emit/allocate are typed STUBS unless scope explicitly requests wiring.\n\nSPEC:\n${SPEC}\n\nSCOUTED FACTS (JSON):\n${JSON.stringify(scout, null, 1)}\n\nBASELINE (JSON):\n${JSON.stringify(baseline, null, 1)}`,
  { label: 'lock-plan', phase: 'Lock', schema: PLAN_SCHEMA })

// ===========================================================================
// PHASE 3 — IMPLEMENT (real tree, sequential, self-healing). NO worktree
// isolation: edit + verify + fix agents must share the live working tree so
// the heal loop sees prior edits.
// ===========================================================================
phase('Implement')
let impl = await agent(
  `${WD_NOTE}IMPLEMENT ax2 milestone-1.${WT ? ' The worktree is already on branch "' + BRANCH + '" — do NOT create a branch, just edit there. Do not commit.' : ' First create/switch to git branch "' + BRANCH + '" (branch off the current branch; do not commit).'} Apply the locked plan precisely:\n${JSON.stringify(plan, null, 1)}\n\nRules:\n- Create src/orch.ts (leaf/parallel/pipeline full bodies; emit/allocate typed stubs) and refactor the single agent.ts forward callsite to go through leaf — BEHAVIOR-IDENTICAL.\n- Match surrounding code style. Real types from @ax-llm/ax where exported; minimal local structural types otherwise; any unavoidable 'any' gets a 'ponytail:' comment with an 'Upgrade:' trigger.\n- Then run \`${CHECK_CMD}\` and \`${LINT_CMD}\`. If either is RED, FIX and re-run, looping until BOTH are green or you have made ${MAX_FIX_ROUNDS} fix attempts. Do NOT introduce behavior changes to make lint pass — fix properly.\n- Ignore pre-existing errors the baseline already reported: ${JSON.stringify(baseline && baseline.preexistingErrors || [])}.\n\nReturn the unified git diff, final check/lint output (verbatim errors or "clean"), status (green only if BOTH pass modulo pre-existing), files changed, fix rounds used, and notes.\n\nSPEC:\n${SPEC}`,
  { label: 'implement', phase: 'Implement', schema: IMPL_SCHEMA, agentType: 'general-purpose' })

// workflow-level heal backstop (beyond the agent-internal loop), budget-aware
let round = 0
while (impl && impl.status !== 'green' && round < MAX_FIX_ROUNDS && (!budget.total || budget.remaining() > 60000)) {
  round++
  log(`heal round ${round}: check/lint still red, dispatching fixer`)
  impl = await agent(
    `${WD_NOTE}The orch-skeleton edits are applied but \`${CHECK_CMD}\`/\`${LINT_CMD}\` are RED. Diagnose and FIX in the working tree, then re-run both. Do NOT revert the skeleton; fix the cause. Behavior must stay identical to pre-refactor.\n\nFAILING OUTPUT:\ncheck: ${impl.checkOutput}\nlint: ${impl.lintOutput}\n\nPRE-EXISTING (ignore): ${JSON.stringify(baseline && baseline.preexistingErrors || [])}\n\nReturn the same structured result (diff, outputs, status, files, fixRoundsUsed, notes).\n\nSPEC:\n${SPEC}`,
    { label: `heal:${round}`, phase: 'Implement', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
}

// ===========================================================================
// PHASE 4 — REVIEW (parallel adversarial skeptics on the applied change).
// ===========================================================================
phase('Review')
const reviews = (await parallel(REVIEW_LENSES.map(l => () =>
  agent(`${WD_NOTE}Adversarially review the APPLIED orch-skeleton change in the working tree (read src/orch.ts and the refactored src/agent.ts callsite directly, plus the diff below). Default skeptical.\n\nLENS — ${l.focus}\n\nReturn findings; mark isBlocker=true only for things that break behavior, drop an opts field, or violate the 5-primitive core. Cite file:line. No praise, no scope creep into deferred features.\n\nDIFF:\n${impl ? impl.diff : '(implementation failed)'}\n\nSPEC:\n${SPEC}`,
    { label: `review:${l.key}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'Explore' })
))).filter(Boolean)
const blockers = reviews.flatMap(r => (r.findings || []).filter(f => f.isBlocker))
log(`review: ${reviews.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)} findings, ${blockers.length} blockers`)

// ===========================================================================
// PHASE 5 — HARDEN (fix blockers, re-verify). Loop until clean or budget out.
// ===========================================================================
phase('Harden')
let hardenRound = 0
let openBlockers = blockers
while (impl && openBlockers.length > 0 && hardenRound < MAX_HARDEN_ROUNDS && (!budget.total || budget.remaining() > 60000)) {
  hardenRound++
  log(`harden round ${hardenRound}: fixing ${openBlockers.length} blocker(s)`)
  impl = await agent(
    `${WD_NOTE}Review found BLOCKERS in the applied orch-skeleton. Fix each in the working tree, preserving the 5-primitive core and behavior-identical refactor, then re-run \`${CHECK_CMD}\` and \`${LINT_CMD}\`.\n\nBLOCKERS:\n${JSON.stringify(openBlockers, null, 1)}\n\nReturn the updated structured result.\n\nSPEC:\n${SPEC}`,
    { label: `harden:${hardenRound}`, phase: 'Harden', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  // re-review only the lenses that had blockers, to confirm closure
  const reReview = (await parallel(REVIEW_LENSES.map(l => () =>
    agent(`${WD_NOTE}Re-review the now-fixed orch-skeleton for your lens ONLY. Confirm prior blockers are resolved and no new ones introduced.\n\nLENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : ''}\n\nSPEC:\n${SPEC}`,
      { label: `reverify:${l.key}:${hardenRound}`, phase: 'Harden', schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  openBlockers = reReview.flatMap(r => (r.findings || []).filter(f => f.isBlocker))
}

// ===========================================================================
// PHASE 6 — REPORT (synthesize for the human).
// ===========================================================================
phase('Report')
const report = await agent(
  `Write the final implementation report for the ax2 author (blunt, terse, full technical substance, markdown).\n\nCover: (1) STATUS — green/red, check+lint clean? branch "${BRANCH}"${WT ? ' in external worktree `' + WT + '` (main checkout untouched; review/merge from there)' : ' (edited in place)'}. (2) WHAT CHANGED — files + the leaf-refactor, with the exact new callsite. (3) THE 5-PRIMITIVE CORE as shipped (signatures). (4) RESIDUAL RISK — any open blocker, any 'ponytail:'/any introduced, anything the reviews flagged non-blocking. (5) NEXT DEFERRED ITEM — name the single next step (budget-enforce / emit-wire / dynamic /run / resume journal / worktree) and its triggering use case. (6) the unified diff in a fenced block.\n\nIf status is red or blockers remain open, SAY SO plainly at the top — do not declare success.\n\nIMPLEMENTATION RESULT (JSON):\n${JSON.stringify(impl, null, 1)}\n\nFINAL OPEN BLOCKERS (JSON):\n${JSON.stringify(openBlockers, null, 1)}\n\nALL REVIEW FINDINGS (JSON):\n${JSON.stringify(reviews, null, 1)}`,
  { label: 'report', phase: 'Report' })

return {
  status: impl ? impl.status : 'failed',
  branch: BRANCH,
  worktree: WT || '(in-place)',
  scope: SCOPE,
  filesChanged: impl ? impl.filesChanged : [],
  openBlockers,
  fixRounds: impl ? impl.fixRoundsUsed : 0,
  report,
}
