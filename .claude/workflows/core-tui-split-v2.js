export const meta = {
  name: 'core-tui-split-v2',
  description: 'Split ax2 src/ into a headless src/core/ and a UI src/tui/ around a serializable AsyncGenerator turn boundary. Land runTurn(sessionId, message): AsyncGenerator<TurnEvent> in NEW src/core/run.ts — Effect stays INSIDE on appRuntime, the outside contract is plain for-await. Reuse the existing activity.ts Activity union + agent.ts TurnResult; invent no new event vocab. Kill the module-global activity sink (setActivitySink/emitActivity) and the module-load liveLogger binding, replacing both with a per-turn closure emit pushing into the turn AsyncGenerator queue. HARD INVARIANT: final reply prose is carried ONLY by the reply arm, yielded EXACTLY ONCE at the end, ALWAYS yielded even on error/abort (turn() failure maps to a reply with a warning text). Sequential pipeline of 6 dependent steps on ONE shared worktree/branch, each gated on bun run check; step 4 (flip sendAtom) is a STOP GATE verified for final-reply-once before proceeding to delete the global sink. Phase 0 regrounds the file manifest against the live src/ tree rather than trusting any embedded list.',
  phases: [
    { title: 'Reground', detail: 'Re-glob src/ live, re-derive the headless->src/core/ and UI->src/tui/ split, confirm atoms.ts exports and tui/orch-tree.ts reducer state, diff against the verdict inventory, and return a corrected file manifest that the move step consumes' },
    { title: 'Split', detail: 'Six sequential dependent steps on one shared branch: (1) pure per-turn makeLiveLogger(emit) factory, (2) git mv headless->src/core + UI->src/tui with import-path fixes (otel.ts stays root), (3) add src/core/run.ts runTurn generator alongside existing path, (4) STOP GATE flip sendAtom to consume runTurn and verify final-reply-once, (5) delete global sink and reroute the three producers to the per-turn closure, (6) deferred TraceContext cleanup. bun run check after every step' },
    { title: 'Verify', detail: 'Final bun run lint plus a reviewer agent asserting every invariant: core/ headless (no @opentui/react/@effect/atom), grep emitActivity|setActivitySink is zero, exactly 5 orch prims, Effect only at session boundary + otel.ts, TurnEvent fully serializable, file-size budget under 500 lines. Return a structured report' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'

const VERDICT = `
LOCKED VERDICT (app-server SHAPE only, claude_code model — NO codex server/protocol/transport ceremony):

- runTurn signature: \`export async function* runTurn(sessionId: string, message: string): AsyncGenerator<TurnEvent>\`
  in NEW src/core/run.ts. PLAIN AsyncGenerator, NOT an Effect Stream. Effect stays INSIDE (it runs turn() on
  appRuntime); the OUTSIDE contract is for-await-of.

- TurnEvent = { kind: 'activity'; activity: Activity } | { kind: 'reply'; result: TurnResult }.
  Reuse the EXISTING activity.ts Activity union (text | tool | result | node) and agent.ts TurnResult VERBATIM.
  Invent NO new event vocab. NO submission-id correlation — single in-flight turn guarded by busyAtom.

- HARD INVARIANT (final-reply-once): the final reply prose is carried ONLY by the 'reply' arm, yielded
  EXACTLY ONCE at the end, and ALWAYS yielded even on error/abort. A turn() failure must map to a reply whose
  text is a warning ('⚠ ...') via catchCause — that mapping MOVES out of atoms.ts:267-275 INTO runTurn.
  liveLogger must NEVER emit the final reply as activity text — this is preserved today by the existing
  calls.length > 0 && content gate at activity.ts:54. Keep that gate intact.

- sink replacement: KILL the activity.ts module-global sinkState.sink (setActivitySink / emitActivity).
  Replace with a PER-TURN closure emit: (a: Activity) => void created INSIDE runTurn, pushing into THAT turn's
  push/pull async queue. Thread emit into (1) a per-turn makeLiveLogger(emit) — liveLogger is currently bound
  ONCE at module load via agent.ts:138 llm.setOptions, which is THE last true global; and (2) the
  orch.emit()/onEvent path so a NodeEvent -> Activity{kind:'node'} lands in the SAME buffer. After: a
  grep -rn 'emitActivity|setActivitySink' src MUST return zero, and activity.ts keeps ONLY 'export type Activity'.
  Per-node makeNodeLogger already rides NodeOpts.logger (orch.ts:62), closing over its own nodeId — so parallel
  nodes stay correct against one shared per-turn queue.

CURRENT src/ INVENTORY (the verdict's snapshot — DO NOT trust blindly; Phase 0 RE-GLOBS and CORRECTS this.
orch-run.ts / orch-load.ts are DELETED and must not reappear):
- Headless -> move to src/core/: agent.ts, runtime.ts, models.ts, orch.ts, orch-recipes.ts, orch-plan.ts,
  orch-resilience.ts, orch-spans.ts, rlm-node.ts, rlm-workflow.ts, activity.ts, sessions.ts, tools.ts, toolui.ts.
  ADD src/core/run.ts.
- UI -> move to src/tui/ (ALREADY EXISTS, holds orch-tree.ts): atoms.ts, chat.tsx, clipboard.ts, history.ts.
- SHARED: otel.ts STAYS at src/ root (it owns appRuntime = Atom.runtime used by the TUI; imported by core only
  via OtelTracerProvider). Do NOT push the Atom dependency into core/.
- atoms.ts exports (confirmed): newSessionAtom, deleteSessionAtom, sendAtom, appAtom, busyAtom,
  busySessionsAtom + types. orchestrateAtom / runScriptAtom are GONE.
- tui/orch-tree.ts ALREADY holds the node -> OrchTree reducer (flatten + reducer). Steps 4/5 WIRE the generator
  into the EXISTING reducer; they do NOT extract a fresh one.

INVARIANTS (non-negotiable):
- core/ stays headless: NO @opentui, react, or @effect/atom imports (verify by grep).
- exactly 5 orch primitives.
- Effect ONLY at the session boundary + otel.ts.
- TurnEvent is FULLY serializable: NO AxMemory / AxSpan inside it — those stay in sessions.ts behind a
  sessionId lookup.
- file-size budget < 500 lines per file; strict tsconfig.

FILE:LINE ANCHORS to cite verbatim in step prompts:
- agent.ts:138        module-load llm.setOptions binding of liveLogger (the last true global).
- activity.ts:54      the calls.length > 0 && content gate that prevents final reply leaking as activity text.
- orch.ts:62          NodeOpts.logger seam carrying the per-node makeNodeLogger.
- orch.ts:166         orch.emit() — producer #1 to reroute in step 5.
- runtime.ts:88       onEvent — producer #2 to reroute in step 5.
- atoms.ts:267-275    the current turn-failure -> '⚠' mapping that MOVES into runTurn.
- sessions.ts:14      sessionId-keyed session store (AxMemory/AxSpan live here, behind the lookup).

FUTURE SEAM (build NOTHING for it now): the AsyncGenerator IS the seam. A future remote client bolts a thin
OUTSIDE adapter (TurnEvent -> NDJSON socket + inbound prompt -> runTurn), claude_code sdkMessageAdapter style.
The rule that keeps it free: only TurnEvent (serializable) crosses the boundary, and the only input is
(sessionId, message). Do not add transport/protocol code now.
`

const DSL_NOTE = `
You are a coding subagent working in the ax2 repo (a Bun + TypeScript project: opentui React TUI on @ax-llm/ax).
You have full tools (Read / Edit / Write / Bash / Grep / Glob) and you run inside a shared git worktree on a
dedicated branch — every step in this pipeline runs on the SAME branch IN ORDER, so your changes build on the
prior step's committed work. Use ABSOLUTE paths. Do real edits, not descriptions. After your changes, you MUST
run '${CHECK}' and only declare success if it is GREEN. If it is red, fix it before returning. Do NOT run
'git checkout'/'git reset' on files you did not create in this step. Do NOT create new worktrees. Keep every
file under 500 lines.
`

const manifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['toCore', 'toTui', 'staysRoot', 'newFiles', 'atomsExports', 'orchTreeReducerConfirmed', 'orchPrimCount', 'diffsFromInventory', 'anchorsVerified'],
  properties: {
    toCore: { type: 'array', items: { type: 'string' }, description: 'Existing src/ files that move to src/core/ (basenames)' },
    toTui: { type: 'array', items: { type: 'string' }, description: 'Existing src/ files that move to src/tui/ (basenames)' },
    staysRoot: { type: 'array', items: { type: 'string' }, description: 'Files that stay at src/ root (expect otel.ts)' },
    newFiles: { type: 'array', items: { type: 'string' }, description: 'Files to be created (expect src/core/run.ts)' },
    atomsExports: { type: 'array', items: { type: 'string' }, description: 'Actual exported names from atoms.ts' },
    orchTreeReducerConfirmed: { type: 'boolean', description: 'tui/orch-tree.ts holds the node->OrchTree reducer (flatten + reducer)' },
    orchPrimCount: { type: 'integer', description: 'Number of orch primitives found (must be 5)' },
    diffsFromInventory: { type: 'array', items: { type: 'string' }, description: 'Every place the live tree differs from the verdict snapshot' },
    anchorsVerified: {
      type: 'object',
      additionalProperties: false,
      required: ['agentLiveLogger', 'activityGate', 'orchEmit', 'runtimeOnEvent', 'atomsFailureMap', 'orchNodeLogger', 'sessionsStore'],
      description: 'For each anchor: the actual file:line where it now lives (lines may have drifted)',
      properties: {
        agentLiveLogger: { type: 'string' },
        activityGate: { type: 'string' },
        orchEmit: { type: 'string' },
        runtimeOnEvent: { type: 'string' },
        atomsFailureMap: { type: 'string' },
        orchNodeLogger: { type: 'string' },
        sessionsStore: { type: 'string' },
      },
    },
  },
}

const stopGateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'evidence', 'violations'],
  properties: {
    passed: { type: 'boolean', description: 'true ONLY if final-reply-once holds: reply yielded exactly once at end, ALWAYS yielded even on error/abort, and no activity arm carries final reply prose' },
    evidence: { type: 'string', description: 'Concrete code citations (file:line + quoted lines) proving the reply arm yields once, the catchCause/error path also yields a reply, and the activity.ts gate is intact' },
    violations: { type: 'array', items: { type: 'string' }, description: 'Any way the invariant could be broken: a path that returns without a reply, a second reply, or final prose leaking through an activity event. Empty iff passed.' },
  },
}

const finalReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['allInvariantsPass', 'coreHeadless', 'sinkGrepZero', 'orchPrimCount', 'effectAtBoundary', 'turnEventSerializable', 'fileSizeBudget', 'lintGreen', 'checkGreen', 'remainingRisks'],
  properties: {
    allInvariantsPass: { type: 'boolean' },
    coreHeadless: { type: 'object', additionalProperties: false, required: ['pass', 'detail'], properties: { pass: { type: 'boolean' }, detail: { type: 'string', description: 'grep result for @opentui|react|@effect/atom under src/core' } } },
    sinkGrepZero: { type: 'object', additionalProperties: false, required: ['pass', 'detail'], properties: { pass: { type: 'boolean' }, detail: { type: 'string', description: 'grep -rn emitActivity|setActivitySink src — must be empty' } } },
    orchPrimCount: { type: 'object', additionalProperties: false, required: ['pass', 'count'], properties: { pass: { type: 'boolean' }, count: { type: 'integer' } } },
    effectAtBoundary: { type: 'object', additionalProperties: false, required: ['pass', 'detail'], properties: { pass: { type: 'boolean' }, detail: { type: 'string' } } },
    turnEventSerializable: { type: 'object', additionalProperties: false, required: ['pass', 'detail'], properties: { pass: { type: 'boolean' }, detail: { type: 'string', description: 'confirm no AxMemory/AxSpan in TurnEvent' } } },
    fileSizeBudget: { type: 'object', additionalProperties: false, required: ['pass', 'offenders'], properties: { pass: { type: 'boolean' }, offenders: { type: 'array', items: { type: 'string' } } } },
    lintGreen: { type: 'boolean' },
    checkGreen: { type: 'boolean' },
    remainingRisks: { type: 'array', items: { type: 'string' } },
  },
}

// ----------------------------------------------------------------------
phase('Reground')
  // ----------------------------------------------------------------------
  const manifest = await agent(
    `Re-ground the file manifest for the ax2 core/tui split against the LIVE repo. Do NOT trust any embedded
list — DERIVE everything from the actual tree right now.

${VERDICT}

DO THIS:
1. Run \`ls -1 /Users/umang/hub/ax2/src\` and \`ls -1 /Users/umang/hub/ax2/src/tui\` (and \`git -C /Users/umang/hub/ax2 status\`).
   List every .ts/.tsx file that actually exists. Note any file in the verdict's inventory that is MISSING
   (e.g. orch-run.ts / orch-load.ts must be ABSENT) or any file present that the verdict does not mention.
2. Classify each existing src/ root file as headless (-> src/core/) or UI (-> src/tui/). Headless = no
   @opentui / react / @effect/atom import. UI = imports those. otel.ts is SHARED and STAYS at src/ root
   (it owns appRuntime = Atom.runtime). Verify your classification by grepping the imports of each file, do
   not guess.
3. Open src/atoms.ts and list its ACTUAL exported names. Confirm orchestrateAtom / runScriptAtom are gone.
4. Open src/tui/orch-tree.ts and confirm it holds the node -> OrchTree reducer (a flatten helper + a reducer).
   Quote the reducer's entry function name.
5. Count the orch primitives in src/orch.ts (must be exactly 5) and name them.
6. Verify each FILE:LINE anchor from the verdict and report where it ACTUALLY lives now (line numbers may have
   drifted): agent.ts liveLogger setOptions binding, activity.ts calls.length>0 && content gate,
   orch.ts orch.emit(), runtime.ts onEvent, atoms.ts turn-failure '⚠' mapping, orch.ts NodeOpts.logger seam,
   sessions.ts sessionId store.

This is READ-ONLY reconnaissance. Make NO edits. Return the corrected manifest as the schema.`,
    { label: 'reground', phase: 'Reground', schema: manifestSchema, effort: 'high', agentType: 'general-purpose' },
  )

  const MANIFEST_JSON = JSON.stringify(manifest, null, 2)
  log(`Reground manifest: ${manifest.toCore.length} -> core, ${manifest.toTui.length} -> tui, ${manifest.orchPrimCount} orch prims; diffs from inventory: ${manifest.diffsFromInventory.length}`)
  if (manifest.orchPrimCount !== 5) {
    log(`WARNING: orch primitive count is ${manifest.orchPrimCount}, expected 5. Steps will treat this as a hard invariant and must reconcile.`)
  }

  const THREAD = `
CORRECTED MANIFEST FROM PHASE 0 (this is GROUND TRUTH for file locations — use it, not the verdict's snapshot):
${MANIFEST_JSON}
`

  // ----------------------------------------------------------------------
  phase('Split')
  // ----------------------------------------------------------------------

  // STEP 1 — pure per-turn liveLogger factory.
  await agent(
    `${DSL_NOTE}

STEP 1 of 6 — pure-liveLogger. Make liveLogger creation a PER-TURN pure factory, decoupled from module load.

${VERDICT}
${THREAD}

GOAL: introduce \`makeLiveLogger(emit)\` — a factory that takes a per-turn \`emit: (a: Activity) => void\` and
returns the live logger object, closing over emit instead of the module-global sink. This is the FIRST move
toward killing the agent.ts module-load llm.setOptions binding (anchor: agentLiveLogger in the manifest), which
is THE last true global.

DO:
1. Locate the current liveLogger definition and the module-load \`llm.setOptions(...)\` call (manifest anchor
   agentLiveLogger). Refactor liveLogger into \`makeLiveLogger(emit)\` returning the same shape it has today.
2. Keep activity.ts's calls.length>0 && content gate (manifest anchor activityGate) INTACT and on the
   makeLiveLogger path — the final reply must never leak as activity text.
3. Confirm makeNodeLogger ALREADY takes its own emit/logger via NodeOpts.logger (manifest anchor
   orchNodeLogger) — if it already closes over a passed emit, leave it; just note it in your summary.
4. You do NOT have to remove the module-global sink yet (that is step 5) and you do NOT have to wire
   makeLiveLogger into a real per-turn emit yet (step 3). For now, the module-load binding MAY call
   makeLiveLogger with the existing emitActivity as the emit argument so nothing breaks. The point of THIS
   step is purely to make the factory exist and be pure.
5. Run '${CHECK}' until green. Commit with a clear message on the current branch.

Return a 4-line summary: what you renamed/added, the makeLiveLogger signature, whether makeNodeLogger already
took its own emit, and the final '${CHECK}' status.`,
    { label: 'step1-pure-livelogger', phase: 'Split', effort: 'high', agentType: 'general-purpose' },
  )

  // STEP 2 — folder move (mechanical, re-glob at runtime).
  await agent(
    `${DSL_NOTE}

STEP 2 of 6 — folder-move. Mechanically relocate files into src/core/ and src/tui/ and fix ALL import paths.

${VERDICT}
${THREAD}

CRITICAL: RE-GLOB src/ at the START of this step (\`ls -1 /Users/umang/hub/ax2/src\`) — the prior step may have
added files. Use the manifest's toCore / toTui / staysRoot / newFiles as the plan, but reconcile against the
live tree. Do NOT move otel.ts (it stays at src/ root). Do NOT create src/core/run.ts yet (that is step 3).

DO:
1. \`git mv\` each headless file from src/ -> src/core/ (manifest.toCore). src/core/ may not exist yet — create it.
2. \`git mv\` each UI file from src/ -> src/tui/ (manifest.toTui). src/tui/ ALREADY exists (holds orch-tree.ts).
3. Fix EVERY import path across the whole repo (src/, scripts/, tests, package.json bin entries, any tsconfig
   path aliases). Use grep to find every importer of every moved file. otel.ts stays root; core/ imports it
   only via OtelTracerProvider — do NOT pull the Atom dependency into core/.
4. Do NOT change any logic. This step is purely structural.
5. Run '${CHECK}' until green (this catches broken import paths). Commit on the current branch.

Return a 4-line summary: count moved to core, count moved to tui, what stayed at root, and '${CHECK}' status.`,
    { label: 'step2-folder-move', phase: 'Split', effort: 'high', agentType: 'general-purpose' },
  )

  // STEP 3 — runTurn alongside (not wired).
  await agent(
    `${DSL_NOTE}

STEP 3 of 6 — runTurn-alongside. Add src/core/run.ts with the runTurn AsyncGenerator. Build it ALONGSIDE the
existing sendAtom path — do NOT wire it in yet.

${VERDICT}
${THREAD}

CREATE src/core/run.ts exporting:
- \`export type TurnEvent = { kind: 'activity'; activity: Activity } | { kind: 'reply'; result: TurnResult }\`
  importing Activity from the (now relocated) activity.ts and TurnResult from agent.ts VERBATIM. Invent NO new
  fields. TurnEvent MUST be fully serializable — NO AxMemory / AxSpan inside it (those stay in sessions.ts
  behind the sessionId lookup, manifest anchor sessionsStore).
- \`export async function* runTurn(sessionId: string, message: string): AsyncGenerator<TurnEvent>\`

runTurn internals:
1. Create a per-turn push/pull async queue (a simple unbounded queue with push(value) and an async pull()/done
   signal — implement it inline, no external dep). Create \`const emit = (a: Activity) => queue.push({ kind:
   'activity', activity: a })\`.
2. Build a per-turn liveLogger via makeLiveLogger(emit) from step 1, and wire it for THIS turn's turn() call.
3. Run the Effect turn() on appRuntime INSIDE runTurn (Effect stays inside; the outside is for-await). As turn()
   produces activities they flow through emit into the queue. Drain the queue: yield each queued activity event.
4. On success: yield EXACTLY ONE { kind: 'reply', result } at the END.
5. On failure/abort: MOVE the turn-failure mapping from atoms.ts (manifest anchor atomsFailureMap, the '⚠ ...'
   text) into runTurn via catchCause — yield EXACTLY ONE { kind: 'reply', result } whose text is the warning.
   The reply MUST ALWAYS be yielded, even on error/abort. There must be no code path that returns without a
   reply, and never two replies.
6. Do NOT yield the final reply prose as an activity event — rely on the activity.ts gate (manifest anchor
   activityGate) to keep liveLogger from emitting it.

Do NOT modify atoms.ts/sendAtom in this step (the '⚠' mapping is COPIED into run.ts here; it is DELETED from
atoms.ts in step 4). Keep run.ts under 500 lines. Run '${CHECK}' until green. Commit on the current branch.

Return a 5-line summary: the TurnEvent type, runTurn signature, how the queue drains, where the error->reply
mapping lives, and '${CHECK}' status.`,
    { label: 'step3-runturn', phase: 'Split', effort: 'high', agentType: 'general-purpose' },
  )

  // STEP 4 — flip sendAtom (STOP GATE).
  await agent(
    `${DSL_NOTE}

STEP 4 of 6 — flip-sendAtom. THIS IS THE STOP GATE. Make sendAtom consume runTurn via for-await and wire the
events into the EXISTING tui/orch-tree.ts reducer.

${VERDICT}
${THREAD}

DO:
1. In src/tui/atoms.ts, change sendAtom to drive the turn through
   \`for await (const ev of runTurn(sessionId, message)) { ... }\` instead of the old direct turn()/emitActivity
   path. For ev.kind === 'activity', route activity into the state the TUI already renders, feeding node
   activities (kind:'node') into the EXISTING tui/orch-tree.ts reducer (manifest.orchTreeReducerConfirmed —
   use the reducer's existing entry function, do NOT extract a fresh reducer). For ev.kind === 'reply', set the
   final reply ONCE.
2. DELETE the now-duplicated turn-failure -> '⚠' mapping from atoms.ts (manifest anchor atomsFailureMap) — it
   now lives in runTurn (step 3). The error reply must arrive via the 'reply' arm only.
3. Keep busyAtom as the single in-flight-turn guard (no submission-id correlation).
4. Do NOT delete emitActivity/setActivitySink yet — that is step 5. The global sink may still exist; just make
   sendAtom no longer the one creating final reply prose outside the reply arm.
5. Run '${CHECK}' until green. Commit on the current branch.

LOAD-BEARING: after this step, final-reply-once must hold — the final reply prose is produced ONLY by the
reply arm, exactly once, always (even on error/abort). A separate VERIFY agent will assert this before the
pipeline may proceed.

Return a 4-line summary: how sendAtom now consumes runTurn, that the '⚠' mapping was removed from atoms.ts,
how node events reach the orch-tree reducer, and '${CHECK}' status.`,
    { label: 'step4-flip-sendatom', phase: 'Split', effort: 'high', agentType: 'general-purpose' },
  )

  // STEP 4 VERIFY — final-reply-once stop gate.
  const gate = await agent(
    `STOP-GATE VERIFICATION. Assert the HARD INVARIANT final-reply-once on the current code. READ-ONLY: make NO
edits.

${VERDICT}
${THREAD}

Read src/core/run.ts and src/tui/atoms.ts (sendAtom) carefully. The invariant holds iff ALL of these are true:
A. runTurn yields a { kind: 'reply', ... } EXACTLY ONCE, at the END of a turn.
B. EVERY exit path of runTurn yields a reply — success AND error/abort (the catchCause path). There is NO path
   that returns without a reply, and NEVER two replies.
C. The final reply prose is carried ONLY by the 'reply' arm. No 'activity' event (and no liveLogger emission)
   carries the final reply text — the activity.ts calls.length>0 && content gate (manifest anchor activityGate)
   is intact and prevents it.
D. The turn-failure '⚠ ...' mapping was REMOVED from atoms.ts and now lives in runTurn.

Quote the exact file:line evidence for A-D. If any are uncertain or broken, list them as violations. Set
passed=true ONLY if all four hold with no violations. Return the stop-gate schema.`,
    { label: 'step4-verify-final-reply-once', phase: 'Split', schema: stopGateSchema, effort: 'high', agentType: 'general-purpose' },
  )

  if (!gate.passed) {
    log('STOP GATE FAILED: final-reply-once not satisfied after step 4. Halting before step 5 (delete-global-sink).')
    log(`Violations: ${gate.violations.join(' | ')}`)
    log(`Evidence: ${gate.evidence}`)
    return {
      stopped: true,
      stoppedAt: 'step4-stop-gate',
      reason: 'final-reply-once invariant not satisfied; refusing to delete the global sink on an unsafe turn boundary',
      gate,
      manifest,
    }
  }
  log(`STOP GATE PASSED: final-reply-once holds. ${gate.evidence.slice(0, 200)}`)

  // STEP 5 — delete global sink + reroute three producers.
  await agent(
    `${DSL_NOTE}

STEP 5 of 6 — delete-global-sink + reroute. Remove the module-global activity sink and reroute the THREE real
producers into the per-turn closure emit.

${VERDICT}
${THREAD}

The step-4 stop gate has PASSED (final-reply-once holds), so it is safe to delete the global sink now.

DO:
1. DELETE \`emitActivity\` and \`setActivitySink\` (and sinkState.sink) from activity.ts. After this, activity.ts
   keeps ONLY \`export type Activity\` (plus the calls.length>0 && content gate logic if that lives here — keep
   the gate, just remove the global sink). \`grep -rn 'emitActivity|setActivitySink' src\` MUST return ZERO.
2. Reroute the THREE real producers to the per-turn emit threaded from runTurn (step 3):
   (a) orch.emit() (manifest anchor orchEmit) — its NodeEvent must become Activity{kind:'node'} pushed into the
       SAME per-turn queue, via the per-turn emit (NodeOpts.logger / makeNodeLogger seam, manifest anchor
       orchNodeLogger). Parallel nodes share one per-turn queue and each makeNodeLogger closes over its own
       nodeId — keep that correct.
   (b) runtime.ts onEvent (manifest anchor runtimeOnEvent) — route into the per-turn emit.
   (c) the rlm-workflow.ts orchestration path — route into the per-turn emit.
3. Remove the agent.ts module-load llm.setOptions binding of liveLogger (the last true global) if it still
   exists — liveLogger is now created per turn via makeLiveLogger(emit) inside runTurn.
4. Verify core/ stays headless: \`grep -rn '@opentui|from .react|@effect/atom' src/core\` MUST be empty.
5. Run '${CHECK}' until green. Commit on the current branch.

Return a 5-line summary: confirmation that grep emitActivity|setActivitySink src is zero, how each of the three
producers now reaches the per-turn emit, that the agent.ts module-load binding is gone, the core-headless grep
result, and '${CHECK}' status.`,
    { label: 'step5-delete-global-sink', phase: 'Split', effort: 'high', agentType: 'general-purpose' },
  )

  // STEP 6 — deferred TraceContext cleanup (lowest risk last).
  await agent(
    `${DSL_NOTE}

STEP 6 of 6 — deferred-TraceContext. Lowest-risk final cleanup.

${VERDICT}
${THREAD}

DO:
1. Now that the turn boundary is a serializable AsyncGenerator, clean up any deferred/leftover TraceContext
   plumbing so that Effect/OTel concerns stay at the session boundary + otel.ts (which remains at src/ root and
   owns appRuntime). Ensure core/ does not depend on @effect/atom and that TurnEvent carries NO AxSpan /
   AxMemory (those stay in sessions.ts behind the sessionId lookup, manifest anchor sessionsStore).
2. Do the minimal cleanup only — do NOT add transport/protocol/remote code (the AsyncGenerator is the future
   seam; build nothing for it now).
3. Confirm no file exceeds 500 lines (\`find src -name '*.ts' -o -name '*.tsx' | xargs wc -l\` and check the
   tail). Split a file only if it busts the budget AND the split is clean.
4. Run '${CHECK}' until green. Commit on the current branch.

Return a 3-line summary: what TraceContext cleanup you did, confirmation Effect/OTel stays at the boundary +
otel.ts, and '${CHECK}' status.`,
    { label: 'step6-trace-context', phase: 'Split', effort: 'medium', agentType: 'general-purpose' },
  )

  // ----------------------------------------------------------------------
  phase('Verify')
  // ----------------------------------------------------------------------
  const report = await agent(
    `FINAL VERIFICATION + REVIEW of the ax2 core/tui split. Run the full gate and assert EVERY invariant. You
MAY run commands but make NO source edits — if something is broken, report it as a failing invariant rather
than fixing it.

${VERDICT}
${THREAD}

DO and report each as a structured field:
1. Run '${LINT}' and '${CHECK}'. Record green/red for each (lintGreen, checkGreen).
2. coreHeadless: \`grep -rn '@opentui\\|from .react\\|@effect/atom' src/core\` — must be EMPTY. Quote the result.
3. sinkGrepZero: \`grep -rn 'emitActivity\\|setActivitySink' src\` — must be EMPTY. Quote the result.
4. orchPrimCount: count + name the orch primitives in src/core/orch.ts — must be EXACTLY 5.
5. effectAtBoundary: confirm Effect appears ONLY at the session boundary (runTurn / sessions) and otel.ts;
   core/ has no @effect/atom import.
6. turnEventSerializable: open src/core/run.ts, confirm TurnEvent has NO AxMemory / AxSpan and reuses the
   existing Activity union + TurnResult verbatim.
7. fileSizeBudget: \`find src -name '*.ts' -o -name '*.tsx' | xargs wc -l\` — list any file >= 500 lines as an
   offender.
8. Spot-check final-reply-once once more in src/core/run.ts: reply yielded exactly once, always, even on
   error/abort.

Set allInvariantsPass=true ONLY if every check passes. Return the final report schema.`,
    { label: 'final-review', phase: 'Verify', schema: finalReportSchema, effort: 'high', agentType: 'general-purpose' },
  )

log(`Final report: allInvariantsPass=${report.allInvariantsPass}, lint=${report.lintGreen}, check=${report.checkGreen}, orchPrims=${report.orchPrimCount.count}`)
return { stopped: false, manifest, stopGate: gate, report }
