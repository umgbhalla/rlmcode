export const meta = {
  name: 'headless-test-harness',
  description: 'Re-grounded for ax2 @ d014b5d. orch-core.test.ts + orch.test.ts ALREADY cover the 5 prims (leaf/parallel/pipeline/allocate + emit indirectly) and recipes agent/adversarialVerify headless — DO NOT re-do that. This build adds the missing layer: a reusable no-LLM collector/driver (scripts/headless-harness.ts) the test files share, a runTurn() TurnEvent-stream golden/snapshot test (scripts/turn-stream.test.ts — NOT yet buildable, runTurn ships in core-tui-split), and CLOSES the recipe gaps the existing tests leave (judge, loopUntilDry, emit→Activity mapping). Matches ax2 assert-fixture no-framework style (scripts/*.test.ts), wires into `bun run test`, lands green under `bun run lint`. Sequential on main, self-heal to green + adversarial review per deliverable, commit each as a checkpoint. runTurn DEPENDS ON core-tui-split — until it lands, the golden test is a skip-with-reason stub.',
  phases: [
    { title: 'Preflight',  detail: 'confirm current reality: runTurn(sessionId,message):AsyncGenerator<TurnEvent> does NOT yet exist (turn() is still the Effect.fn span in src/agent.ts); orch-core.test.ts + orch.test.ts already pass. Decide PROCEED-PARTIAL (build harness + recipe-gap tests now, golden test as skip-stub) vs PROCEED (runTurn since landed).' },
    { title: 'Scout',      detail: 'parallel read-only: pin what orch-core.test.ts + orch.test.ts ALREADY cover (to avoid duplication), the judge/loopUntilDry/emit signatures (the real gaps), the runTurn/TurnEvent contract if present, and the assert-fixture template + test-runner wiring' },
    { title: 'harness',    detail: 'scripts/headless-harness.ts — reusable no-framework substrate: makeAsserter, fakeGen, fakeAI, fakeOpts, collectEvents — factored from the inline helpers already duplicated across orch-core.test.ts + orch.test.ts. Plus the runTurn driver (drainTurn/normalizeStream) OR a guarded stub if runTurn is absent.' },
    { title: 'turn-golden', detail: 'scripts/turn-stream.test.ts — golden/snapshot of the per-turn TurnEvent stream shape/order (deterministic, no real LLM). NOT YET BUILDABLE: runTurn is absent → land it as a skip-with-reason stub that activates the moment runTurn ships.' },
    { title: 'recipe-gaps', detail: 'scripts/orch-recipes.test.ts — ONLY the recipes the existing tests miss: judge (single-leaf pick + toInput shaping), loopUntilDry (convergence + max), and emit() → Activity mapping. Do NOT re-test leaf/parallel/pipeline/allocate/agent/adversarialVerify — orch-core.test.ts + orch.test.ts own those.' },
    { title: 'wire-gate',  detail: 'add the new tests to `bun run test` (after the existing orch-core/orch tests); confirm whole gate (check + test + analyze + debt) green' },
    { title: 'Report',     detail: 'final status, per-deliverable commit, what is NOW covered beyond the existing orch tests, residual risk, next test to add (activate the golden snapshot once runTurn lands)' },
  ],
}

const CHECK = 'bun run check'   // tsc --noEmit + Effect LS — the hard green gate
const TEST = 'bun run test'     // runs scripts/*.test.ts (plain-assert, exit 1 on fail)
const LINT = 'bun run lint'     // check + test + analyze + debt — full gate, must be green
const MAX_HEAL = 4
const MAX_HARDEN = 2

// ---------------------------------------------------------------------------
// GROUND TRUTH — the settled ax2 architecture this harness tests, RE-GROUNDED to
// the actual source at /Users/umang/hub/ax2 (commit ~d014b5d). Do NOT contradict
// it; do NOT re-do what the two existing orch tests already cover.
// ---------------------------------------------------------------------------
const CORE_SPEC = `
ax2 headless test harness. The codebase under test lives at /Users/umang/hub/ax2.

CURRENT REALITY (verified at re-grounding — honor it, do not relitigate):
- src/ is FLAT today: no src/core/, no src/tui/. The folders-not-packages move (src/core/* + src/tui/*)
  is core-tui-split's job and has NOT happened. Import the prims from ../src/orch.ts and recipes from
  ../src/orch-recipes.ts (the paths the existing tests use).
- runTurn(sessionId, message): AsyncGenerator<TurnEvent> does NOT exist yet. The closest live entry is
  turn() in src/agent.ts — an Effect.fn("chat.turn") span returning Effect<TurnResult>, NOT a per-turn
  AsyncGenerator. NodeEvents currently travel the LEGACY side-channel: orch.emit() → Effect.runSync →
  activity.ts emitActivity() → the per-turn setActivitySink (installed by atoms.ts). The TurnEvent
  per-turn-buffer stream is core-tui-split's deliverable. So the turn-golden snapshot test is NOT
  buildable yet — it lands as a skip-with-reason stub, NEVER faked with a live LLM call.
- src/orch.ts is the orchestration CORE: EXACTLY 5 primitives.
    leaf<I,O>(gen,opts) => (ai,input) => gen.forward(ai,input,opts)   // the ONLY ax callsite; opts=LeafOpts
    parallel(thunks) => Promise.all(t().catch(()=>null))             // fan-out; failed slot => null; never rejects
    pipeline(items, ...stages)                                       // no-barrier async-generator sequence
    emit(NodeEvent, opts?): Effect<void>                            // thin hook over activity bus + active OTel span
    allocate(total): Budget                                         // token gate; charge/spent/remaining/freeze; throws BudgetExhaustedError
  LeafOpts = { mem:AxMemory, sessionId, tracer, traceContext, maxSteps, stream, abortSignal }.
  NodeEvent = {type:'start',nodeId,parentId?,phase} | {type:'delta',nodeId,chunk} | {type:'done',nodeId,result} | {type:'error',nodeId,cause}.
  Budget = {total; charge(usage:BudgetUsage|undefined):void; spent():Promise<number>; remaining():Promise<number>; freeze(reason):void}.
  BudgetExhaustedError(reason,spent,total) — typed, has _tag and .name.
- src/orch-recipes.ts is USERLAND (not core), each recipe <15 lines, composed only from the 5 prims + the NodeEvent sink:
    agent(node, ai, input): emits start, runs leaf, charges budget (if usageOf+budget given), emits done|error, returns O.
    judge(ai, candidates, judgeGen, judgeOpts, toInput): ONE leaf picks best; toInput shapes candidates → judge input.
    loopUntilDry(body, isDry, max=8): repeat until isDry(prev,next) converges (or max).
    adversarialVerify(produce, skeptics, accept?): produce once, parallel() the skeptics, majority vote.
  EmitSink = (event:NodeEvent)=>void; default noopSink so recipes run standalone (in TESTS) with NO Effect boundary.
- Promise-native at the combinator/recipe level; Effect ONLY at the session boundary (turn()/orchestrate()) and otel.ts.

WHAT THE TWO EXISTING TESTS ALREADY COVER — DO NOT DUPLICATE:
- scripts/orch-core.test.ts pins the SHAPES: leaf (via agent), agent start→done & start→error & budget-charge,
  allocate over-budget→BudgetExhaustedError + freeze(), parallel null-coercion + survivors filter, pipeline value
  map, adversarialVerify majority + tie-reject + crashed-skeptic-dropped. It has an inline fakeGen + recorder().
- scripts/orch.test.ts pins the CONCURRENCY INVARIANT: parallel() forks AxMemory per leaf (no cross-branch bleed),
  leaf forwards over its own mem, pipeline two-stage map, agent over a mem-writing fake. It has an inline
  memWritingGen + optsFor() + recorder().
- THE GAPS those two leave (and the ONLY recipe behaviors this build's recipe test should add): judge() (untested),
  loopUntilDry() (untested), and emit()'s Effect→Activity mapping (untested — orch-core asserts NodeEvent shapes
  via the recipe sink, but NOT that orch.emit() Effect.runSync maps a NodeEvent to the {kind:'node',...} Activity).
- THE NEW LAYER this build adds: (a) a SHARED harness factoring the helpers the two tests currently duplicate
  (makeAsserter, fakeGen, fakeAI/fakeOpts, collectEvents) so future tests stop re-declaring them; (b) the runTurn
  golden/snapshot test (stubbed until runTurn lands).

TEST STYLE (MANDATORY — match scripts/orch-core.test.ts + scripts/orch.test.ts EXACTLY, they are the canon):
- Plain Bun script. NO test framework (no describe/it/expect/vitest/bun:test). Shebang '#!/usr/bin/env bun'.
- let failed = 0; const assert = (cond, msg) => { if (!cond) { console.error(\`  FAIL: \${msg}\`); failed++ } }.
  (The shared harness exports makeAsserter() returning exactly this {assert, done} — byte-for-byte same FAIL prefix,
   same exit code, same '<name>: all pass ✓' line as the two existing tests' footers.)
- One fixture per behavior in a top-level await (async()=>{ ... })(); synchronous asserts on the captured value.
- End: if (failed > 0) { console.error(\`<name>: \${failed} failure(s).\`); process.exit(1) }; console.log('<name>: all pass ✓').
- Golden/snapshot = serialize the captured TurnEvent stream to a stable JSON string (drop timestamps, redact provider
  ids, KEEP type/nodeId/parentId/phase/kind + order) and assert string-equality against an INLINE expected literal
  (no external .snap files, no snapshot lib). Keep snapshots SMALL + readable + DETERMINISTIC (double-run check).
- Tests MUST be HERMETIC: NO network, NO real LLM, NO Cloudflare creds, NO opentui mount, NO OTel exporter. The fake
  AxAIService + fake AxGen are structural+minimal, exactly like the inline fakeGen the existing tests already use
  (cast through unknown with a single 'ponytail:' + 'Upgrade:' line — NOT a bare any). For emit()'s Activity mapping
  use setActivitySink/emitActivity from ../src/activity.ts to capture, mirroring how agent.ts runs onEvent.

GREEN GATE: \`${CHECK}\` clean AND \`${TEST}\` green (all scripts/*.test.ts pass, exit 0). \`${LINT}\` (check+test+analyze+debt)
must be green — EXCEPT it may stay red ONLY on PRE-EXISTING user dead exports (history/clipboard/toolui x3/agent.ts abortTurn);
never blame those on this work, never delete the user's in-flight files. Every NEW export YOU add must be CONSUMED (a test
file is consumed by the runner; a harness helper is consumed by the tests — if a harness export is only used by ONE test,
inline it instead, lazy-senior). 'bun run debt' fails on any 'ponytail:' marker lacking an 'Upgrade:' line.
LAZY-SENIOR ETHOS: smallest harness that earns its keep. The shared helpers must be used by ≥2 callers (the new tests, and
ideally the existing ones could later migrate — but DO NOT rewrite orch-core.test.ts / orch.test.ts in this run unless a
helper move is trivially safe and keeps them green). No speculative test framework, no mock library, no abstraction the
tests don't use twice. Reuse the existing assert pattern verbatim.
Local deps live in ../ (ax, opentui, motel, effect-smol) — read there when @ax-llm/ax types are unclear, not npm docs.
`

// ---------------------------------------------------------------------------
// SCHEMAS — real JSON-Schema for every structured agent() call.
// ---------------------------------------------------------------------------
const PREFLIGHT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['runTurnExists', 'runTurnSignature', 'turnEventShape', 'injectionSeam', 'existingCoverage', 'gaps', 'where', 'verdict', 'notes'],
  properties: {
    runTurnExists: { type: 'boolean', description: 'true iff a runTurn(...):AsyncGenerator<TurnEvent> (per-turn event-stream entry) is exported from src/ today (expected FALSE — turn() is still the Effect.fn span)' },
    runTurnSignature: { type: 'string', description: 'verbatim signature + file:line, or "absent" if not found' },
    turnEventShape: { type: 'string', description: 'the TurnEvent union variants + fields verbatim, or "absent"' },
    injectionSeam: { type: 'string', description: 'if runTurn exists: how a fake AxAIService can be injected for hermetic tests; else "n/a — runTurn absent"' },
    existingCoverage: { type: 'array', items: { type: 'string' }, description: 'what scripts/orch-core.test.ts + scripts/orch.test.ts ALREADY assert (so we do not duplicate) — file:line per claim' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'recipe/prim behaviors NOT covered by those two tests (expected: judge, loopUntilDry, emit→Activity mapping)' },
    where: { type: 'array', items: { type: 'string' }, description: 'file:line cites for each claim' },
    verdict: { type: 'string', description: 'PROCEED (runTurn exists → build the live golden test) | PROCEED-PARTIAL (runTurn absent → build harness + recipe-gap tests now, golden test as skip-stub) | STOP (nothing testable, should never happen — the existing tests already pass)' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}
const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'facts', 'cites'],
  properties: {
    area: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' }, description: 'verbatim signatures / shapes / patterns — copy, do not paraphrase' },
    cites: { type: 'array', items: { type: 'string' }, description: 'file:line for each fact' },
  },
}
const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'testOutput', 'assertionsAdded', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string', description: 'green | red (green = check clean AND new test passes AND the two existing orch tests still pass, modulo pre-existing dead exports)' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string', description: 'unified git diff of THIS deliverable' },
    checkOutput: { type: 'string', description: 'final `bun run check` tail: "clean" or verbatim tsc errors' },
    testOutput: { type: 'string', description: 'final test run tail: the "all pass ✓" line(s) or verbatim failures' },
    assertionsAdded: { type: 'number', description: 'count of assert(...) calls in the new/changed test file' },
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
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'deliverables', 'coverage', 'gateState', 'residualRisk', 'nextTest'],
  properties: {
    headline: { type: 'string', description: 'one blunt line: how many deliverables landed green, what was skipped (golden test) / failed' },
    deliverables: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'status', 'commit', 'assertions', 'covers'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', description: 'green | skipped | failed' },
          commit: { type: 'string' },
          assertions: { type: 'number' },
          covers: { type: 'string', description: 'what behavior this now pins BEYOND the existing orch tests' },
        },
      },
    },
    coverage: { type: 'array', items: { type: 'string' }, description: 'behaviors NEWLY pinned by this build (judge single-leaf, loopUntilDry convergence/max, emit→Activity mapping, shared harness reuse, golden-stub readiness) — NOT the prim/recipe behaviors the two existing tests already own' },
    gateState: { type: 'string', description: 'is `bun run lint` green? if red, exactly which pre-existing dead-export lines and why they are not ours' },
    residualRisk: { type: 'array', items: { type: 'string' }, description: 'new ponytails (with Upgrade triggers), the skipped golden test, any non-determinism risk, any structural cast on the fake AxGen' },
    nextTest: { type: 'string', description: 'the single most valuable next test to add (almost certainly: activate the golden snapshot once core-tui-split ships runTurn)' },
  },
}

// ---------------------------------------------------------------------------
// PREFLIGHT — confirm the CURRENT reality (runTurn absent, two orch tests pass)
// before building. This is NOT a hard dependency gate that STOPs — the harness +
// recipe-gap tests are buildable TODAY regardless of runTurn; only the golden
// snapshot test is gated (skip-stub vs live). BARRIER: one focused read-only probe.
// ---------------------------------------------------------------------------
phase('Preflight')
const pre = await agent(
  `You are re-grounding a test-harness build against the CURRENT ax2 source at /Users/umang/hub/ax2.\n\nRead src/agent.ts, src/atoms.ts, src/activity.ts, src/orch.ts, src/orch-recipes.ts, scripts/orch-core.test.ts, scripts/orch.test.ts, package.json. Determine, with file:line evidence:\n 1. Does an exported runTurn(...): AsyncGenerator<TurnEvent> EXIST in src/ today? (Expected: NO — turn() in src/agent.ts is still an Effect.fn span; NodeEvents flow via orch.emit → activity.ts emitActivity → atoms setActivitySink. The TurnEvent per-turn-buffer is core-tui-split's deliverable, not yet landed. Confirm or refute.)\n 2. If runTurn exists: its exact signature + the TurnEvent union shape + the injection seam for a fake AxAIService.\n 3. EXISTING COVERAGE: exactly what scripts/orch-core.test.ts + scripts/orch.test.ts already assert — so this build does NOT duplicate them.\n 4. GAPS: which recipe/prim behaviors those two tests do NOT cover. (Expected gaps: judge(), loopUntilDry(), and emit()'s Effect→Activity {kind:'node'} mapping.)\n\nVERDICT: PROCEED if runTurn exists (build the live golden test); PROCEED-PARTIAL if runTurn is absent (build the shared harness + the recipe-gap test now, land the golden test as a skip-with-reason stub); STOP only if literally nothing is testable (should not happen — the two orch tests already pass).\n\n${CORE_SPEC}`,
  { label: 'preflight', phase: 'Preflight', schema: PREFLIGHT_SCHEMA, agentType: 'Explore' },
)
log(`preflight: runTurn ${pre.runTurnExists ? 'present' : 'ABSENT'} — verdict ${pre.verdict} — ${(pre.gaps || []).length} recipe gaps`)
if (pre.verdict === 'STOP') {
  return { stopped: true, reason: 'nothing testable (unexpected — orch-core.test + orch.test already pass)', preflight: pre }
}
const RUN_TURN_PRESENT = pre.runTurnExists === true && pre.verdict !== 'PROCEED-PARTIAL'

// ---------------------------------------------------------------------------
// SCOUT — pin every contract the new tests assert against, verbatim, AND pin
// exactly what the two existing tests already own (so we narrow, not duplicate).
// BARRIER: parallel read-only fan-out; all must land before any test is written.
// ---------------------------------------------------------------------------
phase('Scout')
const SCOUT = [
  { key: 'existing-coverage', prompt: `Read scripts/orch-core.test.ts and scripts/orch.test.ts in FULL. Report VERBATIM, per fixture, exactly what each asserts (leaf shape, agent start/done/error/budget, allocate over-budget+freeze, parallel null-coercion+survivors, pipeline value-map, adversarialVerify majority/tie/crashed-skeptic, fork-isolation/forked-mem, mem-writing agent). ALSO copy verbatim their inline helpers — the fakeGen, memWritingGen, optsFor, recorder, and the let failed=0 / assert / footer block — because the shared harness will FACTOR these. CRITICALLY: list which recipes/prims are NOT exercised at all (expected: judge, loopUntilDry; and that emit()'s Effect→Activity mapping is never asserted). This is the anti-duplication map. Cite file:line.` },
  { key: 'recipe-gaps', prompt: `Read src/orch-recipes.ts and src/orch.ts in full. Report VERBATIM the signatures of the UNTESTED recipes the new recipe-gap test must cover: judge<C,I,O>(ai, candidates, judgeGen, judgeOpts, toInput) — note it runs ONE leaf and how toInput shapes the candidates into the judge input; loopUntilDry<T>(body, isDry, max=8) — note the loop/convergence/max semantics (when it stops, what it returns, how many times body runs in the never-dry case). ALSO emit(event, opts?): the EXACT Effect<void> body — what Activity object it produces (the {kind:'node',...} shape: nodeId, event, parentId?, detail?) and how it reaches activity.ts emitActivity. Read src/activity.ts for the Activity union + setActivitySink/emitActivity signatures (the capture seam the emit test uses). Cite file:line.` },
  { key: 'runturn-stream', prompt: `Determine whether runTurn / TurnEvent exists. Read src/agent.ts (turn() Effect.fn), src/atoms.ts (sendAtom/orchestrateAtom + how activity flows to OrchTree), src/activity.ts, and grep src/ for 'runTurn'/'TurnEvent'. If PRESENT: report runTurn's exact signature, the TurnEvent union (every variant + field), the yield order for a normal turn, how the final reply is delivered, and the fake-AxAIService injection seam — verbatim. If ABSENT (expected): report the closest existing entry (turn() Effect.fn signature + TurnResult shape) and state plainly what a hermetic golden test would need that does not exist yet (runTurn + a per-turn TurnEvent buffer + an AxAIService injection seam). Cite file:line.` },
  { key: 'test-style', prompt: `Read scripts/orch-core.test.ts and scripts/orch.test.ts (footers) and package.json. Report VERBATIM: the exact assert-fixture template (shebang, let failed=0, the assert fn, the if(failed>0){...process.exit(1)} + console.log('<name>: all pass ✓') footer), how 'bun run test' is wired (it currently chains design-check.test.ts && ponytail-debt.test.ts && orch-core.test.ts && orch.test.ts with &&), and how 'bun run lint' composes check+test+analyze+debt. New tests must slot into 'bun run test' the SAME way, AFTER orch-core/orch. Confirm there is NO test framework in devDependencies. Cite file:line.` },
]
const scout = (await parallel(SCOUT.map(s => () =>
  agent(`${s.prompt}\n\nReturn structured facts. area="${s.key}". Copy signatures/shapes VERBATIM; cite file:line; do not invent or paraphrase.\n\n${CORE_SPEC}`,
    { label: s.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
))).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
const PREFLIGHT_JSON = JSON.stringify(pre, null, 1)
log(`scouted ${scout.length}/4 contracts`)

// ---------------------------------------------------------------------------
// DELIVERABLES — built strictly in order; each builds on the prior. SEQUENTIAL
// (shared working tree on main — no parallel writers). The harness ships first;
// the test files consume it. The recipe-gap test ONLY covers what the two
// existing orch tests miss (judge, loopUntilDry, emit→Activity). The golden test
// is gated: live when runTurn is present, a skip-with-reason stub otherwise.
// ---------------------------------------------------------------------------
const DELIVERABLES = [
  {
    key: 'harness', title: 'harness',
    spec: `Create scripts/headless-harness.ts — the reusable, no-framework substrate the new test files import. FACTOR it from the helpers scripts/orch-core.test.ts + scripts/orch.test.ts already duplicate inline (read those verbatim — the harness must be byte-compatible with their fakeGen/recorder/assert/footer so a future migration is trivial). Exports (each CONSUMED by the test files below — if an export ends up used by only one test, INLINE it there instead, lazy-senior):\n` +
      `  • makeAsserter: \`export const makeAsserter = () => { let failed = 0; const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('  FAIL: ' + msg); failed++ } }; const done = (name: string) => { if (failed > 0) { console.error(name + ': ' + failed + ' failure(s).'); process.exit(1) } console.log(name + ': all pass ✓') }; return { assert, done } }\` — byte-for-byte the same FAIL prefix / exit code / '<name>: all pass ✓' line the two existing tests emit.\n` +
      `  • fakeGen: \`export const fakeGen = <O>(reply: O, opts?: { fail?: boolean; usageTokens?: number }) => AxGen<any, O>\` — structurally identical to the inline fakeGen in orch-core.test.ts (forward() resolves the canned reply or throws if fail; getUsage() returns the canned usage so budget charging is testable). Cast through unknown with a SINGLE 'ponytail:' + 'Upgrade: a typed double over the full AxGen interface if the engine calls more methods' (NOT a bare any) — copy the exact ponytail wording already in orch-core.test.ts so the debt ledger stays consistent.\n` +
      `  • collectEvents: \`export const collectEvents = () => { events: NodeEvent[]; sink: EmitSink }\` — the recorder() the two tests duplicate, exported once. Recipe/emit tests pass collector.sink and assert on collector.events.\n` +
      `  • fakeAI + fakeOpts: \`export const fakeAI = () => AxAIService\` (the {} as AxAIService stub) and \`export const fakeOpts = (sessionId?: string): LeafOpts\` returning a hermetic opts bag (new AxMemory(), inert tracer/traceContext, maxSteps, stream:false, fresh AbortController().signal) — mirroring orch.test.ts optsFor(). No real OTel SDK, no network.\n` +
      (RUN_TURN_PRESENT
        ? `  • drainTurn: \`export const drainTurn = async (sessionId: string, message: string): Promise<TurnEvent[]>\` — for-await-collects the whole runTurn() stream into an array, injecting the fake AxAIService through the seam scout pinned (hermetic, NO real LLM). Plus \`export const normalizeStream = (events: TurnEvent[]): string\` — serialize to a STABLE JSON string for snapshotting: strip/redact non-deterministic fields (timestamps, durations, provider/response ids, varying token counts) but KEEP type/nodeId/parentId/phase/kind + order. The snapshot oracle.\n`
        : `  • runTurn is ABSENT (preflight PROCEED-PARTIAL). DO NOT add a drainTurn that calls a live LLM. Export \`export const RUN_TURN_AVAILABLE = false\` and a \`drainTurn\` stub that throws "runTurn not shipped (core-tui-split pending)". The golden test reads RUN_TURN_AVAILABLE and skips-with-reason. Mark the stub with 'ponytail:' + 'Upgrade: implement drainTurn over runTurn once core-tui-split lands runTurn(): AsyncGenerator<TurnEvent>'.\n`) +
      `\nKeep the file lazy-senior small — only what the tests below actually consume. ${CHECK} must end clean. The two existing orch tests MUST still pass (you are ADDING a shared module, not editing them in this deliverable). This file has no runner of its own; the .test.ts files import it.`,
  },
  {
    key: 'turn-golden', title: 'turn-golden',
    spec: RUN_TURN_PRESENT
      ? `Create scripts/turn-stream.test.ts — a GOLDEN/SNAPSHOT test of the per-turn TurnEvent stream. Import makeAsserter, fakeAI/fakeGen/fakeOpts, drainTurn, normalizeStream from ./headless-harness.ts. Drive a deterministic turn (a fake gen returning a fixed reply, NO tools) via drainTurn(sessionId, message), normalizeStream() it, and assert STRING-EQUALITY against an INLINE expected snapshot literal capturing event ORDER + SHAPE (e.g. node start phase 'chat' → reply terminal event), plus targeted asserts: first event is the turn-start, LAST event carries the final reply, parentId edges preserved, and order is stable across two runs (call drainTurn twice, assert the two normalized strings identical → determinism). Second fixture with a fake tool step: assert the tool call row precedes its result row and correlates by id. Footer via makeAsserter's done('turn-stream.test'). Keep the inline snapshot SMALL + readable. tsc green; \`bun scripts/turn-stream.test.ts\` exits 0.`
      : `runTurn is ABSENT (preflight PROCEED-PARTIAL). Create scripts/turn-stream.test.ts as a SKIP-WITH-REASON stub that RUNS CLEAN (exit 0): import RUN_TURN_AVAILABLE + makeAsserter from ./headless-harness.ts; if (!RUN_TURN_AVAILABLE) { console.log('turn-stream.test: SKIPPED — runTurn() not shipped yet (core-tui-split pending)'); process.exit(0) }. BELOW the guard, write the FULL intended snapshot test (drainTurn → normalizeStream → inline-snapshot string-equality, determinism double-run, tool-row-before-result) so it ACTIVATES automatically the moment runTurn lands — dead-coded behind the guard for now, NO live call. Mark the guarded section with 'ponytail:' + 'Upgrade: drop the RUN_TURN_AVAILABLE guard once core-tui-split ships runTurn'. tsc green (the dead-coded section must still typecheck against the harness stub types); the file exits 0.`,
  },
  {
    key: 'recipe-gaps', title: 'recipe-gaps',
    spec: `Create scripts/orch-recipes.test.ts — ONLY the recipe/prim behaviors scripts/orch-core.test.ts + scripts/orch.test.ts do NOT already cover. DO NOT re-test leaf, parallel, pipeline, allocate, agent, or adversarialVerify — those two files own them (re-testing is wasted debt and a review blocker). Import makeAsserter, fakeAI, fakeGen, fakeOpts, collectEvents from ./headless-harness.ts; judge + loopUntilDry from ../src/orch-recipes.ts; emit + a NodeEvent from ../src/orch.ts; setActivitySink + emitActivity (and the Activity type) from ../src/activity.ts. Cover EXACTLY these gaps:\n` +
      `  • judge(): given N candidate strings + a fake judge gen returning a fixed pick, assert it runs ONE leaf (the fakeGen.forward is called exactly once) and returns the chosen result, and that toInput shaped the candidates into the gen input (capture the input the fake forward received and assert toInput's mapping landed).\n` +
      `  • loopUntilDry(): a body whose output stabilizes after k calls → converges and returns the stable value (assert call count and the returned value); a never-dry body → runs exactly max times and returns the last value (assert the call count equals max).\n` +
      `  • emit() → Activity mapping (the genuinely-untested Effect touch): install a capturing sink via setActivitySink((a)=>captured.push(a)); Effect.runSync(emit({type:'start',nodeId,parentId,phase})) and assert the captured Activity is the expected {kind:'node', nodeId, event:'start', parentId, ...} shape; do the same for a 'done' event (assert the result is carried/clipped as activity.ts maps it). Restore setActivitySink(null) after. This is the ONLY Effect import in the file (import { Effect } from 'effect'), mirroring how src/agent.ts onEvent runs emit via Effect.runSync.\n` +
      `Use makeAsserter() for the assert/done pair; footer done('orch-recipes.test'). NO opentui, NO OTel exporter, NO real LLM. tsc green; \`bun scripts/orch-recipes.test.ts\` exits 0.`,
  },
  {
    key: 'wire-gate', title: 'wire-gate',
    spec: `Wire the new tests into the project gate. In package.json, extend the "test" script to chain the new files the SAME way the existing four are chained (&&), AFTER orch-core.test.ts && orch.test.ts (so the canon prim/recipe tests run first). The current string is:\n  "test": "bun scripts/design-check.test.ts && bun scripts/ponytail-debt.test.ts && bun scripts/orch-core.test.ts && bun scripts/orch.test.ts"\nTarget after this change:\n  "test": "bun scripts/design-check.test.ts && bun scripts/ponytail-debt.test.ts && bun scripts/orch-core.test.ts && bun scripts/orch.test.ts && bun scripts/turn-stream.test.ts && bun scripts/orch-recipes.test.ts"\n(adjust to the verbatim existing string scout pinned). Do NOT add any test framework to devDependencies — the runner is plain bun. Then run the FULL gate: \`${CHECK}\` clean, \`${TEST}\` all-green (every .test.ts exits 0 incl. the golden skip-stub), \`bun run analyze\` (no NEW dead exports — harness exports consumed by the tests, tests by the runner), \`bun run debt\` (every new ponytail: has an Upgrade:). \`${LINT}\` green except the documented PRE-EXISTING user dead exports (history/clipboard/toolui x3/agent.ts abortTurn) — never blame those on this work. Report the verbatim final gate output.`,
  },
]

const results = []
for (let i = 0; i < DELIVERABLES.length; i++) {
  const d = DELIVERABLES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low (${Math.round(budget.remaining() / 1000)}k) — stopping before ${d.key}`); break }
  phase(d.title)

  // implement — edits main, self-heals to check+test green, commits when green.
  let impl = await agent(
    `Implement deliverable "${d.key}" in the ax2 main working tree (current branch), at /Users/umang/hub/ax2. Earlier deliverables in this run are already committed — build on them.\n\nDELIVERABLE SPEC:\n${d.spec}\n\nHARD RULES: ${CHECK} MUST end clean AND the relevant \`bun scripts/<file>.test.ts\` MUST exit 0 AND the two EXISTING orch tests (orch-core.test.ts, orch.test.ts) MUST still pass unchanged (once wired, run \`${TEST}\`). Self-heal: if check or test is red, fix and re-run, up to ${MAX_HEAL} attempts. Match scripts/orch-core.test.ts + scripts/orch.test.ts assert-fixture style VERBATIM — do NOT introduce a test framework, do NOT duplicate behaviors those two files already cover. Any deliberate shortcut gets a 'ponytail:' marker WITH an 'Upgrade:' trigger (bun run debt enforces). When green, COMMIT this deliverable alone with --no-verify and a conventional message 'test(harness): ${d.key} ...'. Report commitSha, diff, check tail, test tail, assertion count, any new ponytails.\n\nPREFLIGHT (runTurn availability + existing-coverage + gaps — honor it; do NOT fake a live LLM call, do NOT re-test covered behaviors):\n${PREFLIGHT_JSON}\n\nSCOUTED CONTRACTS (ground truth — copy signatures from here, do not re-derive):\n${CONTRACTS}\n\n${CORE_SPEC}`,
    { label: `impl:${d.key}`, phase: d.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
  )

  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++
    log(`${d.key}: heal ${heal} (gate red)`)
    impl = await agent(
      `Deliverable "${d.key}" left the gate RED.\n\nCHECK OUTPUT:\n${impl.checkOutput}\n\nTEST OUTPUT:\n${impl.testOutput}\n\nDiagnose + fix in the working tree, re-run \`${CHECK}\` and the test until BOTH are green AND orch-core.test.ts + orch.test.ts still pass (modulo pre-existing user dead exports), then commit with --no-verify. Keep the assert-fixture style; no test framework; no duplication of the existing orch tests. Return the structured result.\n\n${CORE_SPEC}`,
      { label: `heal:${d.key}:${heal}`, phase: d.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
  }

  // adversarial review — 2 lenses, parallel (read-only, safe to fan out).
  const LENSES = [
    { k: 'test-rigor', focus: `TEST RIGOR + DETERMINISM + NON-DUPLICATION: do the assertions actually pin the SPECIFIED gap behavior (judge single-leaf + toInput, loopUntilDry convergence/max, emit→Activity mapping) — not tautologies, not asserting the fake echoes itself, and NOT re-testing what orch-core.test.ts / orch.test.ts already cover (re-testing is a blocker — flag it)? Is every test HERMETIC — no network, no real LLM, no opentui mount, no OTel exporter, no Cloudflare creds? If a golden snapshot exists, is it DETERMINISTIC (no timestamps/ids/varying token counts in the inline literal; the double-run determinism check present)? Does a deliberately-broken impl actually make an assert FAIL (no false-green)? If runTurn was absent, is turn-stream.test.ts a clean skip-with-reason (exit 0) and NOT a faked live call? Cite file:line.` },
    { k: 'style-debt', focus: `STYLE + DEBT + GATE + REUSE: does it match scripts/orch-core.test.ts assert-fixture template verbatim (FAIL prefix, exit 1, '<name>: all pass ✓')? NO test framework added to devDependencies? Is the shared harness actually REUSED by ≥2 callers (else a helper should be inlined — lazy-senior)? Every NEW export consumed (harness by tests, tests by 'bun run test')? Any UNMARKED any or a ponytail: without an Upgrade: (the fakeGen cast must carry the same ponytail wording as orch-core.test.ts)? Does it honor the settled architecture — core stays 5 prims, recipes stay userland, Effect only at the boundary (the single emit() Effect.runSync is the only Effect touch in the recipe-gap test)? Cite file:line.` },
  ]
  const reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review the just-committed "${d.key}" deliverable (read the touched files + the diff). Default skeptical.\nLENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : '(impl failed)'}\n\n${CORE_SPEC}`,
      { label: `review:${d.key}:${l.k}`, phase: d.title, schema: REVIEW_SCHEMA, agentType: 'Explore' }),
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${d.key}: ${reviews.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)} findings, ${blockers.length} blockers`)

  // harden blockers — fix, re-check, re-verify both lenses.
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++
    log(`${d.key}: harden ${hr} (${blockers.length} blockers)`)
    impl = await agent(
      `Review found BLOCKERS in "${d.key}". Fix each in the working tree, keep the harness lazy-senior small + hermetic + non-duplicative, re-run \`${CHECK}\` and the test to green (incl. orch-core/orch unchanged), then AMEND the deliverable commit (--no-verify).\n\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\nReturn the structured result.\n\n${CORE_SPEC}`,
      { label: `harden:${d.key}:${hr}`, phase: d.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${d.key}" for your lens: confirm the blockers are closed and no new ones opened.\nLENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : ''}\n\n${CORE_SPEC}`,
        { label: `reverify:${d.key}:${l.k}:${hr}`, phase: d.title, schema: REVIEW_SCHEMA, agentType: 'Explore' }),
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }

  results.push({
    deliverable: d.key,
    status: impl ? impl.status : 'failed',
    commit: impl ? impl.commitSha : null,
    assertions: impl ? impl.assertionsAdded : 0,
    openBlockers: blockers,
    newPonytails: impl ? impl.newPonytails : [],
    healUsed: heal,
    files: impl ? impl.filesChanged : [],
  })
}

// ---------------------------------------------------------------------------
// REPORT / PLAN — synthesis phase: returns an actionable result. BARRIER on
// the full results array; one structured plan the author can act on.
// ---------------------------------------------------------------------------
phase('Report')
const plan = await agent(
  `Write the final, actionable report for the ax2 author (blunt, terse, full technical substance). A headless test harness layer was added on top of the EXISTING scripts/orch-core.test.ts + scripts/orch.test.ts (which already cover the 5 prims + agent/adversarialVerify), deliverable-by-deliverable on main, each committed.\n\n` +
    `Produce the structured plan. Cover honestly:\n` +
    `  • HEADLINE: how many of the ${DELIVERABLES.length} deliverables landed green; the golden test status (live vs skip-with-reason stub because runTurn is absent) — say it plainly.\n` +
    `  • PER-DELIVERABLE: name, status (green|skipped|failed), commit sha, assertion count, exactly what behavior it now pins BEYOND the two existing orch tests.\n` +
    `  • COVERAGE: the concrete NEW behaviors guarded — shared harness reuse (makeAsserter/fakeGen/collectEvents/fakeOpts factored), judge single-leaf + toInput shaping, loopUntilDry convergence + max, emit()→Activity {kind:'node'} mapping, and the golden-stub readiness. Do NOT claim the prim/recipe behaviors the existing tests already own as new.\n` +
    `  • GATE STATE: is \`${LINT}\` green? If red, name the EXACT pre-existing user dead-export lines (history/clipboard/toolui x3/agent.ts abortTurn) and confirm none are ours.\n` +
    `  • RESIDUAL RISK: new ponytails (with Upgrade triggers), the skipped golden test (and its activation trigger: core-tui-split shipping runTurn), any non-determinism that could flake a future snapshot, any structural cast on the fake AxGen.\n` +
    `  • NEXT TEST: the single highest-value test to add next — almost certainly activating the turn-golden snapshot the moment core-tui-split lands runTurn(): AsyncGenerator<TurnEvent> (drop the RUN_TURN_AVAILABLE guard + wire drainTurn through the real seam).\n\n` +
    `PREFLIGHT:\n${PREFLIGHT_JSON}\n\nRESULTS (JSON):\n${JSON.stringify(results, null, 1)}`,
  { label: 'plan', phase: 'Report', schema: PLAN_SCHEMA, agentType: 'general-purpose' },
)

return { preflight: pre, deliverables: results, plan }
