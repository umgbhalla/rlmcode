export const meta = {
  name: 'orch-tree-ui',
  description: 'RE-ROUTE the orchestration node-tree off the legacy global Activity side-channel and onto the runTurn() TurnEvent stream. The live node-tree render (chat.tsx NodeView), the OrchTree store reduce, and the orchestrate() multi-node wiring ALL ALREADY EXIST (commits a809a38/922b458/64a70fe) — fed today by orch.emit -> Effect.runSync -> emitActivity -> global setActivitySink -> atoms patch. The ONLY remaining work: once core-tui-split ships runTurn(sessionId,message):AsyncGenerator<TurnEvent>, add a TurnEvent kind:\'node\' variant, make orch.emit push it into the in-flight per-turn buffer instead of the global sink, fold it in the PURE store reduce (port the existing parentId-preserving OrchTree logic), and retire the node-event path from the global sink. Gate on a headless runTurn snapshot test. Sequential on main, self-heal to bun-run-check green + 2-lens adversarial review, commit each step. core-tui-split (runTurn + per-turn buffer + tui/core split) is a HARD DEPENDENCY — if the scout finds it has not landed, this workflow STOPS rather than re-doing already-working Activity-bus UI.',
  phases: [
    { title: 'Scout',        detail: 'parallel read-only: confirm core-tui-split landed (runTurn + TurnEvent + per-turn emitter + tui/store reduce); pin the EXACT post-split symbols, and pin the EXISTING legacy node path (orch.emit -> emitActivity -> setActivitySink -> atoms OrchTree reduce -> chat.tsx NodeView) we are migrating OFF' },
    { title: 'node-event',   detail: 'add TurnEvent kind:\'node\' + make orch.emit / the per-turn emitter push node events into the in-flight runTurn buffer; retire the global setActivitySink path for node events. Then port the EXISTING OrchTree reduce into the post-split pure reduce(state,TurnEvent), and repoint chat.tsx NodeView at the split store if the split moved it' },
    { title: 'headless-test', detail: 'tui/orch-tree.test.ts: hand-build a node TurnEvent sequence (incl. out-of-order child resolve), fold through the REAL pure store reduce, snapshot the OrchTree shape (no TUI, no live LLM). Plain-assert, exit 1 on fail.' },
    { title: 'Report',       detail: 'final status, per-step commit, what now flows through the TurnEvent stream vs the retired sink, residual risk, next' },
  ],
}

const CHECK = 'bun run check'   // tsc --noEmit + Effect LS — the hard green gate
const LINT = 'bun run lint'     // check + analyze + debt — informational (red only on pre-existing user dead exports)
const MAX_HEAL = 4
const MAX_HARDEN = 2

// ---------------------------------------------------------------------------
// Shared spec context — the SETTLED architecture + the EXACT current reality.
//
// CURRENT STATE (authoritative, ~commit d014b5d): the orch CORE (EXACTLY 5
// prims: leaf/parallel/pipeline/emit/allocate), the recipes (agent/judge/
// loopUntilDry/adversarialVerify), orch-run.orchestrate(), the OrchNode/OrchTree
// types, the chat.tsx NodeView tree, AND the orchestrate() end-to-end wiring
// ALL EXIST and render LIVE today. The node-tree is fed by the LEGACY path:
//   orch.emit(NodeEvent) -> Effect.runSync(emit()) [agent.ts onEvent]
//   -> emitActivity({kind:'node',...}) -> the GLOBAL setActivitySink
//   -> atoms.ts installSink patches OrchTree -> chat.tsx NodeView renders.
//
// core-tui-split is this workflow's HARD DEPENDENCY and is NOT YET LANDED as of
// authoring: runTurn()/TurnEvent/the per-turn closure buffer/the tui-vs-core
// folder split + pure reduce DO NOT EXIST YET (src/atoms.ts + src/chat.tsx are
// still flat; activity.ts still exports the single global setActivitySink/
// emitActivity). The Scout MUST verify whether the split has landed. If it has
// NOT, this workflow STOPS at Scout — there is nothing to re-route yet, and the
// Activity-bus tree already works; do NOT rebuild working UI.
//
// THE ONLY REMAINING WORK (the re-route), once the split is in:
//   move node events off the retired global sink and onto the per-turn
//   TurnEvent stream's 'node' variant, fold them in the pure reduce, render from
//   the split store. The render component + the orchestrate() demo are DONE.
// ---------------------------------------------------------------------------
const CORE_SPEC = `
ax2 orchestration UX — RE-ROUTE the node-tree onto the runTurn TurnEvent stream. The tree + orchestrate() demo ALREADY render live via the legacy Activity bus; this is a migration, not a greenfield build.

WHAT ALREADY EXISTS AND WORKS — DO NOT REBUILD (only re-wire the data path):
  • orch.ts CORE = EXACTLY 5 primitives: leaf, parallel, pipeline, emit, allocate. emit(event:NodeEvent,_opts?):Effect<void> annotates the active OTel span AND today routes the node row to the UI via the global Activity sink. NodeEvent union: {type:'start',nodeId,parentId?,phase} | {type:'delta',nodeId,chunk} | {type:'done',nodeId,result} | {type:'error',nodeId,cause}. NEVER add a 6th core prim; NEVER invent a 2nd event system.
  • orch-recipes.ts (USERLAND): agent/judge/loopUntilDry/adversarialVerify, each <15 lines, composed ONLY from the 5 prims + an EmitSink ((event:NodeEvent)=>void). Promise-native.
  • orch-run.ts: orchestrate(parent,sessionId,message): Effect.fn under ONE chat.orchestrate span — parallel() fan-out of candidate agent() leaves over FORKED AxMemory, judge picks best, adversarialVerify votes. Emits NodeEvents via agent.ts onEvent throughout. This is the LIVE demo that drives the tree — it is already wired end-to-end (orchestrateAtom + a chat.tsx ctrl+o trigger exist). Do NOT re-wire orchestrate; only ensure its emitted node events now ride the TurnEvent stream.
  • agent.ts: onEvent(event:NodeEvent)=Effect.runSync(emit(event)) — the boundary sink that runs emit() IN the live chat.turn/chat.orchestrate span context. readUsageOf, limits, llm, MODEL exported.
  • OrchNode = {id, parentId?, label, phase, status:'running'|'done'|'error', result?}. OrchTree = {nodes:Record<id,OrchNode>, roots:string[]}. SessionView carries orch?:OrchTree. The reduce of the old 'node' Activity into OrchTree (parentId-preserving, first-seen roots) ALREADY EXISTS in atoms.ts — port it, do not reinvent it.
  • chat.tsx: NodeView (recursive, INDENT per depth, status glyph ◌/✓/✗, collapsible — running auto-expands, settled subtrees collapse on click), childrenIndex(parent->children, first-seen order), rendered inline in the transcript scrollbox under an 'orchestration' header when orch.roots.length>0. This render is DONE and correct — at most it needs its DATA SOURCE repointed at the split store if core-tui-split moved the field.

THE CORE-TUI-SPLIT DEPENDENCY (NOT yet landed at authoring — Scout MUST verify):
  • Expected: activity.ts's single GLOBAL setActivitySink/emitActivity sink REPLACED by a PER-TURN closure buffer (no module-global currentNodeId race; each turn owns its emitter closure).
  • Expected: runTurn(sessionId, message): AsyncGenerator<TurnEvent> as the headless core entrypoint; TurnEvent a typed union of the per-turn events (the old Activity variants, now yielded). atoms/actions consume it via for-await + a PURE reduce(state, event:TurnEvent).
  • IF NOT LANDED: there is no TurnEvent stream to re-route onto, and the legacy Activity-bus tree already works — STOP. Report the block; do not duplicate or downgrade the working UI.

WHAT THIS WORKFLOW DOES (the ONLY remaining work — a re-route, gated on the split):
  1. Add a TurnEvent variant kind:'node' carrying {nodeId, event:'start'|'delta'|'done'|'error', parentId?, detail?} — the SAME projection orch.emit already builds for the old 'node' Activity (start carries parentId+phase->detail; delta/done/error carry undefined parentId + a clipped detail). Make orch.emit / the per-turn emitter PUSH this into the in-flight runTurn buffer instead of the retired global sink. emit() stays Effect<void> and still annotates the OTel span (keep that half untouched).
  2. Port the EXISTING OrchTree reduce (from atoms.ts) into the post-split PURE reduce(state, TurnEvent) for kind==='node'. Keep it parentId-preserving on out-of-order resolve (carry forward prev?.parentId). Pure + total + exhaustive over the TurnEvent union.
  3. Repoint chat.tsx NodeView's data source at the split store's SessionView.orch IF the split moved it (else no chat.tsx change — the render is done).
  4. Retire node events from the global setActivitySink path (don't run both buses).

PRINCIPLES (locked):
  • Core stays EXACTLY 5 prims; recipes are userland; orchestrate() is the demo. No second event system — node events ride the existing per-turn TurnEvent buffer.
  • Promise-native at the combinator level; Effect ONLY at the session boundary (turn()/orchestrate() Effect.fn) + otel.ts. reduce() is PURE — no Effect, no IO.
  • One trace per session: chat.session -> chat.turn / chat.orchestrate -> ax gen_ai. Don't regress it.
  • NEVER share a mutating AxMemory across concurrent leaves — orch-run already forks; don't regress.
  • Real @ax-llm/ax / @opentelemetry/api / effect types where exported; minimal local structural types else. Any UNAVOIDABLE 'any' gets a 'ponytail:' comment WITH an 'Upgrade:' trigger line (bun run debt enforces). Local deps in ../ (ax, opentui, motel, effect-smol, effect-solutions) — read source there when beta types break, not npm docs.

GREEN GATE = ${CHECK} clean. ${LINT} may stay RED ONLY on PRE-EXISTING user dead exports (history/clipboard/toolui x3/agent.ts abortTurn) — never blame those on this work, never delete the user's in-flight files. Every NEW export YOU add MUST be consumed.
`

// ---------------------------------------------------------------------------
// Schemas — every structured agent() call validates against one of these.
// ---------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'splitLanded', 'facts', 'cites', 'splitNames'],
  properties: {
    area: { type: 'string', description: 'the scout key' },
    splitLanded: { type: 'string', description: 'yes | no | partial — has core-tui-split landed the symbols THIS scout was asked to pin? blunt verdict.' },
    facts: { type: 'array', items: { type: 'string' }, description: 'verbatim signatures / shapes / contracts — copy, do not paraphrase' },
    cites: { type: 'array', items: { type: 'string' }, description: 'file:line for every fact' },
    splitNames: {
      type: 'array', items: { type: 'string' },
      description: 'the EXACT post-split symbol names found (runTurn, TurnEvent, the per-turn emitter fn, reduce, tui/store.ts path) — or "NOT FOUND: <name>" for each expected symbol the split has NOT landed, so the build can STOP rather than rebuild working UI.',
    },
  },
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string', description: 'green | red (green = check clean modulo pre-existing user dead exports)' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string', description: 'unified git diff of THIS step only' },
    checkOutput: { type: 'string', description: 'final check tail: "clean" or verbatim tsc/Effect-LS errors' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    newPonytails: { type: 'array', items: { type: 'string' }, description: 'any ponytail: markers added, each WITH its Upgrade: trigger' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'findings'],
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
        properties: {
          severity: { type: 'string', description: 'blocker | major | minor | nit' },
          isBlocker: { type: 'boolean' },
          where: { type: 'string', description: 'file:line' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const TEST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'testFile', 'assertions', 'snapshotShape', 'runOutput', 'committed', 'commitSha', 'notes'],
  properties: {
    status: { type: 'string', description: 'pass | fail' },
    testFile: { type: 'string', description: 'path under /Users/umang/hub/ax2' },
    assertions: { type: 'number', description: 'count of assert() calls' },
    snapshotShape: { type: 'string', description: 'the asserted OrchTree shape: node count, root count, the parent->child edges proven, the out-of-order edge preserved' },
    runOutput: { type: 'string', description: 'tail of the test run: "all passed" or the failing assertion lines' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'splitStatus', 'perStep', 'nowObservable', 'residualRisk', 'next'],
  properties: {
    headline: { type: 'string', description: 'one blunt line: did the re-route land green, or was it blocked on core-tui-split not having landed' },
    splitStatus: { type: 'string', description: 'did the scout find runTurn/TurnEvent/per-turn buffer landed? if not, say the workflow stopped and why.' },
    perStep: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['step', 'status', 'commit', 'enables', 'openBlocker'],
        properties: {
          step: { type: 'string' }, status: { type: 'string' }, commit: { type: 'string' },
          enables: { type: 'string' }, openBlocker: { type: 'string' },
        },
      },
    },
    nowObservable: { type: 'string', description: 'concretely: do orchestrate node events now flow through the runTurn TurnEvent node stream (NOT the retired global setActivitySink)? does the existing collapsible tree still render correctly from the split store? still live + out-of-order-safe?' },
    residualRisk: { type: 'array', items: { type: 'string' }, description: 'new ponytails (with Upgrade triggers), known pre-existing lint-red dead exports (NOT ours), any unsound cast, whether the old global sink path is fully retired for node events' },
    next: { type: 'string', description: 'the single most valuable follow-up' },
  },
}

// ---------------------------------------------------------------------------
// SCOUT — first, confirm core-tui-split actually landed; second, pin BOTH the
// new TurnEvent/runTurn stream we re-route ONTO and the existing legacy node
// path (orch.emit -> emitActivity -> setActivitySink -> atoms OrchTree reduce ->
// chat.tsx NodeView) we re-route OFF. BARRIER (parallel): three independent
// read-only reads, all needed before any decision; no writers, safe to fan out.
// ---------------------------------------------------------------------------
phase('Scout')
const SCOUT = [
  {
    key: 'split-landed',
    prompt: `DECISIVE GATE READ. Determine whether core-tui-split has landed. Look for: src/core/ and src/tui/ folders, a runTurn(sessionId,message):AsyncGenerator<TurnEvent> export, a TurnEvent union type, and whether activity.ts still exports the GLOBAL setActivitySink/emitActivity (if it does and there is no per-turn buffer, the split has NOT landed). At authoring, src/atoms.ts and src/chat.tsx are still FLAT (no tui/ folder) and activity.ts still has the global sink — confirm whether that is still true. Report VERBATIM: the TurnEvent union if it exists (every kind + fields; is there a 'node' kind already?); the runTurn signature if it exists; the per-turn emitter closure name if it exists. splitLanded = blunt yes/no/partial. splitNames MUST list runTurn, TurnEvent, the per-turn emitter fn, the store path — or "NOT FOUND: <x>" for each. If splitLanded=no, the whole workflow STOPS — be unambiguous.`,
  },
  {
    key: 'turn-stream-and-store',
    prompt: `Read the POST-SPLIT headless core entrypoint + TUI store IF THEY EXIST (src/core/*, src/tui/store.ts). Report VERBATIM: (1) the TurnEvent union — every kind + fields (the closest 'text'/'tool'/'result'/'activity' variants so a 'node' kind can be added alongside); (2) how runTurn yields events + the per-turn emitter closure that replaced the global setActivitySink (its name, how an event is pushed into the stream); (3) the pure reduce(state,event:TurnEvent) signature + how it folds each kind into state; (4) the immutable state shape (AppState/SessionView), and whether SessionView still carries orch?:OrchTree, plus where OrchNode/OrchTree types live post-split. IF these files do NOT exist yet, say so plainly (splitLanded=no) and report what is still flat (src/atoms.ts, src/activity.ts). splitNames MUST list runTurn, TurnEvent, the emitter fn, the reduce fn, the store path, OrchTree/OrchNode locations — or "NOT FOUND: <x>".`,
  },
  {
    key: 'legacy-node-path',
    prompt: `Pin the EXISTING, WORKING legacy node path that this workflow migrates OFF — this exists TODAY regardless of the split. Read src/orch.ts emit(), src/agent.ts onEvent, src/activity.ts, src/atoms.ts (the installSink / OrchTree reducer), and src/chat.tsx (NodeView + the orchestration render + the ctrl+o orchestrate trigger). Report VERBATIM: (1) orch.emit's NodeEvent->row projection — the exact {nodeId,event,parentId?,detail} shape it builds and where it calls emitActivity/the sink; (2) agent.ts onEvent=Effect.runSync(emit(...)); (3) the EXISTING atoms.ts reduce of the 'node' Activity into OrchTree — the parentId-preserving, first-seen-roots logic VERBATIM (this is what gets PORTED to the new pure reduce); (4) the chat.tsx NodeView signature/props (id, nodes, childrenOf, depth, expNodes, onToggle), childrenIndex(), the inline 'orchestration' render block, and how it SOURCES OrchTree today (which atom field) — so we know what to repoint; (5) the existing orchestrateAtom + ctrl+o trigger (confirm orchestrate() is already wired end-to-end so we do NOT re-wire it). Cite file:line for everything.`,
  },
]

const scout = (await parallel(SCOUT.map((s) => () =>
  agent(
    `${s.prompt}\n\nReturn structured facts. area="${s.key}". Copy signatures VERBATIM; cite file:line for every fact; do not invent symbols. Be brutally honest about whether core-tui-split has landed — this workflow STOPS if it has not.\n\n${CORE_SPEC}`,
    { label: s.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' },
  ),
))).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)

// GATE: core-tui-split is a hard dependency. If runTurn/TurnEvent/per-turn buffer
// have NOT landed, there is no stream to re-route onto and the Activity-bus tree
// already works — STOP rather than rebuild working UI.
const splitVerdicts = scout.map((s) => (s.splitLanded || '').toLowerCase())
const allMissing = scout.flatMap((s) => (s.splitNames || []).filter((n) => /^NOT FOUND/i.test(n)))
const runTurnMissing = allMissing.some((n) => /runTurn|TurnEvent|per-turn|emitter|reduce/i.test(n))
const splitDown = splitVerdicts.some((v) => v === 'no') || (runTurnMissing && !splitVerdicts.some((v) => v === 'yes'))
log(`scouted ${scout.length}/3; split verdicts: ${splitVerdicts.join(' / ')}; ${allMissing.length} symbols NOT FOUND`)
if (allMissing.length > 0) log(`split gaps: ${allMissing.join(' | ')}`)

let results = []
let test = null

if (splitDown) {
  log('STOP: core-tui-split has NOT landed (no runTurn/TurnEvent/per-turn buffer). The orch node-tree already renders live via the Activity bus — there is nothing to re-route yet. Not rebuilding working UI.')
} else {
  // -------------------------------------------------------------------------
  // RE-ROUTE — the ONLY remaining work, as ONE coherent step: add the
  // TurnEvent 'node' variant + push from orch.emit/the per-turn emitter, PORT
  // the existing OrchTree reduce into the pure post-split reduce, repoint the
  // chat.tsx data source if moved, retire the global sink path for node events.
  // Sequential on main; self-heals to green then adversarially reviewed.
  // -------------------------------------------------------------------------
  const STEP = {
    key: 'node-event',
    title: 'node-event',
    spec: `RE-ROUTE orchestration node events off the retired global Activity sink and onto the per-turn runTurn TurnEvent stream — preserving the EXISTING, WORKING tree behavior. This is a migration of the DATA PATH only; the NodeView render and the orchestrate() demo already work.
1. ADD a TurnEvent variant kind:'node' carrying {nodeId:string, event:'start'|'delta'|'done'|'error', parentId?:string, detail?:string} — the SAME projection orch.emit already builds for the old 'node' Activity (start: parentId + phase->detail; delta/done/error: undefined parentId + clipped detail). Put it in the post-split TurnEvent union file the scout pinned.
2. WIRE orch.emit (src/orch.ts) — or the per-turn emitter closure it calls — to PUSH this 'node' TurnEvent into the IN-FLIGHT runTurn buffer instead of emitActivity/the global setActivitySink. emit() stays Effect<void> and still annotates the active OTel span (keep that half untouched). Resolve the CURRENT per-turn emitter via the split's named mechanism (scout pinned it). Do NOT reintroduce a module-global currentNodeId. agent.ts onEvent=Effect.runSync(emit(...)) keeps working in the live span context.
3. PORT the EXISTING atoms.ts OrchTree reducer (scout quoted it VERBATIM) into the post-split PURE reduce(state,event:TurnEvent) for kind==='node', folding into SessionView.orch:OrchTree EXACTLY as today: nodes:Record<nodeId,OrchNode>; 'start' creates/refreshes {id,parentId,label:detail??nodeId,phase:detail??'',status:prev?.status??'running',result:prev?.result} and appends to roots (first-seen) when parentId===undefined; 'done'/'error' update in place -> status+result=detail, ignore unknown ids; 'delta' preserves. ALWAYS carry forward prev?.parentId on delta/done/error so an out-of-order child keeps its edge. PURE (no Effect/IO), total (default {nodes:{},roots:[]}), exhaustive over the TurnEvent union.
4. If core-tui-split moved chat.tsx / the OrchTree field, REPOINT NodeView's data source at the split store's SessionView.orch. Otherwise leave chat.tsx untouched — the render is DONE; do NOT duplicate NodeView/childrenIndex.
5. RETIRE node events from the global setActivitySink path — don't run both buses for node events. (Leave non-node Activity variants alone if the split still uses the sink for them; touch only the node path.)
Do NOT change the 5-primitive core shape, the NodeEvent union, or re-wire orchestrate() (already wired end-to-end via orchestrateAtom + ctrl+o). ${CHECK} MUST stay green.`,
  }

  phase(STEP.title)
  let impl = await agent(
    `Implement the re-route step "${STEP.key}" in the ax2 main working tree at /Users/umang/hub/ax2, ON TOP of the landed core-tui-split (runTurn/TurnEvent/per-turn buffer/tui split). This is a DATA-PATH migration: the node-tree render + orchestrate() demo already work via the legacy Activity bus — port the data path, do not rebuild UI.\n\nSTEP SPEC:\n${STEP.spec}\n\nRules: ${CHECK} MUST end green (modulo pre-existing user dead exports: history/clipboard/toolui x3/agent.ts abortTurn — never blame or touch those). Self-heal: if check is red, fix and re-run, up to ${MAX_HEAL} attempts. Mark any deliberate shortcut with a 'ponytail:' comment AND an 'Upgrade:' trigger line. When green, COMMIT with --no-verify and a conventional message 'feat(orch-ui): route node events through runTurn TurnEvent stream'. Report commit sha, unified diff, check tail, any new ponytails.\n\nSCOUTED POST-SPLIT + LEGACY CONTRACTS (ground truth):\n${CONTRACTS}\n\n${CORE_SPEC}`,
    { label: `impl:${STEP.key}`, phase: STEP.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
  )

  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++
    log(`${STEP.key}: heal ${heal} (check red)`)
    impl = await agent(
      `The re-route step left ${CHECK} RED. Diagnose + fix in the working tree, re-run until green (modulo pre-existing user dead exports), then commit with --no-verify.\n\nFAILING:\n${impl.checkOutput}\n\nReturn the structured result.\n\n${CORE_SPEC}`,
      { label: `heal:${STEP.key}:${heal}`, phase: STEP.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
  }

  // adversarial review — 2 lenses, BARRIER (parallel): both read-only + independent.
  const LENSES = [
    {
      k: 'correctness',
      focus: `CORRECTNESS + BEHAVIOR: does the 'node' TurnEvent carry the SAME projection the legacy 'node' Activity did? Does the ported pure reduce match the OLD atoms reducer EXACTLY — including parentId carry-forward on out-of-order resolve and first-seen roots? Does the tree still render only when nodes exist (no single-turn regression)? Does orchestrate's node flow now land in the TurnEvent stream under one session trace, forked memory intact? Any hidden any / unsound cast masking a behavior change vs the legacy path? Cite file:line.`,
    },
    {
      k: 'orthogonality',
      focus: `ORTHOGONALITY + DEBT: is the orch CORE still EXACTLY 5 primitives (no recipe smuggled in, NO second event system — node events ride the existing per-turn TurnEvent buffer, not a new side sink)? Was the OLD global setActivitySink path for node events RETIRED (not running both buses)? Was NodeView re-pointed (not duplicated)? Any NEW dead export, UNMARKED any, or ponytail-without-Upgrade? Is the reduce still exhaustive over TurnEvent? Cite file:line.`,
    },
  ]
  const reviews = (await parallel(LENSES.map((l) => () =>
    agent(
      `Adversarially review the just-committed re-route "${STEP.key}" change (read the touched files + the diff). Default skeptical — this is a migration that must preserve EXACTLY the legacy tree behavior. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : '(impl failed)'}\n\n${CORE_SPEC}`,
      { label: `review:${STEP.key}:${l.k}`, phase: STEP.title, schema: REVIEW_SCHEMA, agentType: 'Explore' },
    ),
  ))).filter(Boolean)
  let blockers = reviews.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
  log(`${STEP.key}: ${reviews.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)} findings, ${blockers.length} blockers`)

  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++
    log(`${STEP.key}: harden ${hr} (${blockers.length} blockers)`)
    impl = await agent(
      `Review found BLOCKERS in the re-route "${STEP.key}". Fix each in the working tree, keep the orch core at 5 primitives + the legacy tree behavior EXACTLY (no second event system, node events on the per-turn TurnEvent stream, reduce pure + matching the old atoms reducer), re-run ${CHECK} to green, then AMEND the commit (--no-verify).\n\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\nReturn the structured result.\n\n${CORE_SPEC}`,
      { label: `harden:${STEP.key}:${hr}`, phase: STEP.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
    const rr = (await parallel(LENSES.map((l) => () =>
      agent(
        `Re-review the re-route "${STEP.key}" for your lens, confirm blockers closed, no new ones. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : ''}\n\n${CORE_SPEC}`,
        { label: `reverify:${STEP.key}:${l.k}:${hr}`, phase: STEP.title, schema: REVIEW_SCHEMA, agentType: 'Explore' },
      ),
    ))).filter(Boolean)
    blockers = rr.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
  }

  results.push({
    step: STEP.key,
    status: impl ? impl.status : 'failed',
    commit: impl ? impl.commitSha : null,
    openBlockers: blockers,
    newPonytails: impl ? impl.newPonytails : [],
    healUsed: heal,
    files: impl ? impl.filesChanged : [],
  })

  // -------------------------------------------------------------------------
  // HEADLESS TEST — the behavior gate. Hand-build a node TurnEvent sequence
  // (incl. an out-of-order child resolve), fold through the REAL pure store
  // reduce, snapshot the OrchTree shape. No TUI, no live LLM. Plain-assert,
  // exit 1 on fail. Single write step — plain sequential agent(), no barrier.
  // -------------------------------------------------------------------------
  phase('headless-test')
  if (results.some((r) => r.status === 'green')) {
    test = await agent(
      `Write a HEADLESS golden test proving the orchestration tree is fed by the runTurn TurnEvent 'node' stream via the REAL pure store reduce — NO TUI, NO live LLM.\n\nCreate /Users/umang/hub/ax2/src/tui/orch-tree.test.ts (or src/orch-tree.test.ts if the split kept things flat) in the ax2 plain-assert style (see scripts/design-check.test.ts: 'let failed=0; const assert=(c,m)=>{if(!c){console.error("FAIL: "+m);failed++}}'; finally 'if(failed>0)process.exit(1)'). It MUST:\n1. Build a SEQUENCE of TurnEvent kind:'node' events by hand mirroring an orchestrate fan-out: start root 'orch:s1'(no parent) -> start 'orch:s1/cand-0'(parent root) -> start 'orch:s1/cand-1'(parent root) -> done cand-0 -> done cand-1 -> start 'orch:s1/judge'(parent root) -> done judge -> done root. INCLUDE one OUT-OF-ORDER case: a child 'done' (or 'done' with undefined parentId) arriving BEFORE its 'start', to prove parentId carry-forward never drops the edge.\n2. Fold them through the ACTUAL pure store reduce() imported from the split store — do NOT reimplement the reducer; import and call the real one. Construct minimal valid TurnEvent/state values as needed.\n3. assert on the resulting OrchTree: node count, roots===['orch:s1'] (single first-seen root), parent->child edges (cand-0/cand-1/judge all parentId==='orch:s1'), final statuses ('done'), and that the out-of-order child kept its parentId edge.\n4. Add/extend a test script in package.json to run it; run it; it must pass.\n${CHECK} must stay green. Commit with --no-verify 'test(orch-ui): headless runTurn node-tree snapshot'. Report assertions count, asserted shape, run output, commit sha.\n\nSCOUTED CONTRACTS:\n${CONTRACTS}\n\n${CORE_SPEC}`,
      { label: 'headless-test', phase: 'headless-test', schema: TEST_SCHEMA, agentType: 'general-purpose' },
    )
    log(`headless test: ${test ? test.status : 'failed'} (${test ? test.assertions : 0} assertions)`)
  } else {
    log('skipping headless-test — re-route did not land green')
  }
}

// ---------------------------------------------------------------------------
// REPORT — actionable synthesis. Returns the structured status the harness
// surfaces to the author. Honest about the core-tui-split gate.
// ---------------------------------------------------------------------------
phase('Report')
const report = await agent(
  `Write the final build report for the ax2 author (blunt, terse, full technical substance). The task was to RE-ROUTE the orchestration node-tree off the legacy global Activity sink onto the runTurn TurnEvent stream — a DATA-PATH migration; the tree render + orchestrate() demo already work. core-tui-split (runTurn/TurnEvent/per-turn buffer) is a hard dependency.\n\nGround it in these results.\n\nSPLIT GATE: splitDown=${splitDown} (true means the workflow STOPPED at Scout because core-tui-split had not landed — there was no TurnEvent stream to re-route onto, and the Activity-bus tree already works).\nSCOUT (JSON):\n${CONTRACTS}\nSTEP RESULTS (JSON):\n${JSON.stringify(results, null, 1)}\nHEADLESS TEST RESULT (JSON):\n${JSON.stringify(test, null, 1)}\n\nCover: (1) HEADLINE — did the re-route land green, or was it blocked on core-tui-split. Say it plainly. (2) SPLIT-STATUS — what the scout found re: runTurn/TurnEvent/per-turn buffer; if absent, state the workflow stopped and that the existing Activity-bus tree was left untouched (correctly). (3) PER-STEP — status, commit sha, what it enables, any open blocker. (4) NOW-OBSERVABLE — concretely: do orchestrate node events now flow through the runTurn TurnEvent 'node' stream (NOT the retired global setActivitySink)? does the existing collapsible parentId->nodeId tree still render correctly from the split store, still live (running auto-expands), still out-of-order-safe? OR is this still pending the split? (5) RESIDUAL RISK — new ponytails WITH Upgrade triggers, whether the old global sink path is fully retired for node events, the known pre-existing lint-red user dead exports (history/clipboard/toolui x3/agent.ts abortTurn — NOT ours), any unsound cast. (6) NEXT — the single most valuable follow-up (if blocked: 'run core-tui-split first'). Do not oversell.`,
  { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, agentType: 'general-purpose' },
)

return { splitDown, steps: results, test, report }
