export const meta = {
  name: 'core-tui-split',
  description: 'Behavior-preserving core/tui layering migration for ax2: split the headless agent core away from the opentui UI in 6 settled, independently-shippable steps — (1) pure liveLogger (closure emit, no global), (2) folder move (core/ + tui/, INCLUDING the now-present orch-run.ts + orch-load.ts), (3) runTurn() AsyncGenerator alongside turn() (TurnEvent stream that carries liveLogger rows AND NodeEvent node-tree events), (4) flip sendAtom onto runTurn [STOP gate: final-reply-once invariant], (5) delete the global activity sink AND re-route the live node-tree consumer (orch.emit + agent.onEvent + atoms installSink/orchPatch) onto the per-turn buffer, (6) deferred TraceContext service. Each step lands on main as its own commit, green under `bun run lint`, verified by a diff-review lens + the lint gate + (for the flip) a final-reply-once invariant check before the next step starts.',
  phases: [
    { title: 'Scout',         detail: 'parallel read-only: pin liveLogger/emitActivity, the activity sink + live node-tree consumer (installSink/orchPatch -> OrchTree), atoms sendAtom + the final-reply-once contract, turn()/orchestrate()/loadAndRunOrch boundary + onEvent NodeEvent path, otel TraceContext seam' },
    { title: 'pure-livelogger', detail: 'liveLogger takes an emit closure (no module-global emitActivity); turn() threads a per-turn emit; behavior identical' },
    { title: 'folder-move',     detail: 'mechanical move: src/{agent,orch,orch-recipes,orch-run,orch-load,activity,sessions,tools,toolui}.ts -> src/core/, src/{atoms,chat}.tsx + clipboard/history -> src/tui/; fix imports only' },
    { title: 'runturn-along',   detail: 'core/run.ts runTurn(sessionId,message): AsyncGenerator<TurnEvent> built ALONGSIDE turn() (turn still live); a per-turn closure buffer yields liveLogger rows AND node-tree events; sendAtom NOT yet flipped' },
    { title: 'flip-sendatom',   detail: 'STOP GATE: flip tui sendAtom to consume runTurn(); the final reply must append EXACTLY ONCE (liveLogger suppresses final-step narration, runTurn yields one final reply event). Verified by the final-reply-once invariant check BEFORE proceeding' },
    { title: 'delete-sink',     detail: 'remove the global sink (setActivitySink/emitActivity/let sink) from activity.ts AND re-route every node-tree producer (orch.emit, agent.onEvent, orch-run, orch-load) + the atoms installSink/orchPatch consumer onto the per-turn buffer; the live OrchTree must still render via runTurn' },
    { title: 'deferred-tracectx', detail: 'introduce a TraceContext service so traceContext/tracer are obtained at the boundary, not hand-threaded through LeafOpts at every call site (turn/orchestrate/loadAndRunOrch/runTurn)' },
    { title: 'Report',          detail: 'final status, per-step commit shas, the final-reply-once verdict, residual ponytails, what is now cleanly headless-reusable, the single best follow-up' },
  ],
}

// ---------------------------------------------------------------------------
// Constants — gates, loop ceilings, the green/lint commands (ground truth from CLAUDE.md).
// ---------------------------------------------------------------------------
const CHECK = 'bun run check'   // tsc --noEmit + Effect LS — the tight inner loop
const LINT = 'bun run lint'     // check + analyze + debt — the HARD per-step ship gate here
const MAX_HEAL = 4              // self-heal attempts to drive a step green
const MAX_HARDEN = 2            // blocker-fix rounds after adversarial review
const BUDGET_FLOOR = 80000      // stop before a new step under this many tokens remaining
const HEAL_FLOOR = 60000        // stop healing/hardening under this

// ---------------------------------------------------------------------------
// Shared spec — the settled architecture every agent must honor. Pasted into
// every implementer/reviewer prompt so no step drifts from the recap.
// IMPORTANT current-state note: the orchestration stack is already SHIPPED and the
// live node-tree renders today via the Activity bus. This migration is purely the
// headless-core / opentui-tui SPLIT plus the runTurn TurnEvent stream — NOT a rebuild
// of the orchestration features (orch-run, orch-load, NodeView all already exist).
// ---------------------------------------------------------------------------
const ARCH = `
ax2 core/tui SPLIT — settled architecture (do NOT redesign; this is a behavior-PRESERVING migration on an ALREADY-PRODUCTION orchestration stack).

CURRENT LAYOUT (all under src/, single flat folder today):
  agent.ts        turn() = Effect.fn span (chat.turn -> ax gen_ai); the shared llm = ai({...cloudflare kimi, MODEL=@cf/moonshotai/kimi-k2.7-code}); liveLogger (ax native AxLoggerFunction) -> emitActivity; readUsage/readUsageOf; allocate budget; onEvent = (e: NodeEvent): void => Effect.runSync(emit(e)); captureFetch finish_reason latch; limits={maxSteps,tokenBudget}; abortTurn.
  orch.ts         the 5 core primitives (leaf/parallel/pipeline/emit/allocate) + LeafOpts/NodeEvent/EmitOpts/Budget/BudgetUsage/BudgetExhaustedError. emit(event,opts): Effect<void> maps each NodeEvent variant to an Activity (kind:'node') pushed via emitActivity AND annotates the active OTel span. orch.ts imports emitActivity from ./activity.ts.
  orch-recipes.ts agent()/judge/loopUntilDry/adversarialVerify + type EmitSink = (e: NodeEvent) => void — userland, <15 lines each, composed only from the 5 prims + EmitSink.
  orch-run.ts     orchestrate(parent,sessionId,message): Effect.fn 'chat.orchestrate' demo (loopUntilDry fan-out -> judge -> adversarialVerify) under one span; forks AxMemory per parallel branch; emits NodeEvents via agent.ts onEvent() (start/done/error for root + judge + verify + per-candidate agent() nodes). Returns OrchestrateResult {reply,candidates,accepted,votes}. HEADLESS (imports agent.ts/orch.ts/orch-recipes.ts only).
  orch-load.ts    loadAndRunOrch(parent,sessionId,scriptRef,message): Effect.fn 'chat.orchestrate.load' — runtime dyn-import of a trusted script from ORCH_SCRIPTS_DIR (.ax/orch); injects OrchPrims {leaf,parallel,pipeline,emit,allocate,agent,judge,loopUntilDry,adversarialVerify} + OrchLoadCtx {sessionId,message,rootId,ai,model,budget,onEvent,optsFor,usageOf}; brackets the script root node via onEvent(); returns OrchLoadResult {reply,detail?}. HEADLESS.
  activity.ts     the live activity bus: type Activity = text|tool|result|node; a SINGLE GLOBAL sink (let sink; setActivitySink; emitActivity). The 'node' Activity variant {kind:'node',nodeId,event,parentId?,detail?} is what the node-tree renders from. ponytail in-file: "single global sink — assumes one in-flight turn".
  atoms.ts        appAtom view state (SessionView has optional orch?: OrchTree; OrchTree={nodes,roots}; OrchNode={id,parentId?,label,phase,status,result?}); newSessionAtom; sendAtom/orchestrateAtom/runScriptAtom (appRuntime.fn). Each: append 'you' -> installSink(patch, orchPatch) -> turn()/orchestrate()/loadAndRunOrch() -> append final 'agent' reply ONCE -> setActivitySink(null). installSink maps text/tool/result Activity -> Msg patches AND node Activity -> OrchTree patches (the LIVE node-tree consumer). UI (Atom/effect).
  sessions.ts     per-session AxMemory + root ExternalSpan (module Map, not serializable). HEADLESS.
  tools.ts        AxFunctions. toolui.ts per-tool label/summary/preview. HEADLESS-ish (toolui has no opentui? verify). chat.tsx opentui UI (useKeyboard, scrollbox, NodeView — the recursive collapsible orchestration tree rendering OrchTree). clipboard.ts/history.ts UI helpers.
  otel.ts         NodeSdk 3-signal -> motel; OtelTracerProvider (Context.Service); currentOtelSpan; appRuntime = Atom.runtime(TracingLive).

THE 6 SETTLED STEPS (each independently shippable + green under ${LINT}; land each as its own commit on main, IN ORDER):
  1. pure liveLogger        — liveLogger currently closes over the module-global emitActivity. Make it take an emit closure: makeLiveLogger(emit: (a: Activity) => void): AxLoggerFunction (or thread an emit param). turn() supplies the emit (still emitActivity for now). BEHAVIOR IDENTICAL — same rows, same order. This removes liveLogger's hidden dependency on the global sink, the prerequisite for the per-turn buffer.
  2. folder move            — MECHANICAL only. Move HEADLESS files into src/core/ (agent, orch, orch-recipes, orch-run, orch-load, activity, sessions, tools, toolui) and UI files into src/tui/ (atoms.ts kept as ONE file this step; chat.tsx; clipboard.ts; history.ts). FOLDERS, NOT PACKAGES — relative imports only, no package.json/exports map changes. Use git mv to preserve history. Fix import paths and nothing else. Zero behavior change; the diff is pure moves + path rewrites. Update package.json scripts whose entrypoint path moved (chat -> src/tui/chat.tsx; emit smoke if it imports moved files). orch-run.ts + orch-load.ts are HEADLESS (no opentui) -> core/.
  3. runTurn alongside      — Add core/run.ts exporting runTurn(sessionId: string, message: string): AsyncGenerator<TurnEvent>. TurnEvent is a typed union projecting the per-turn event stream: {kind:'activity', activity: Activity} for liveLogger rows AND node-tree events (the 'node' Activity variant from orch.emit/onEvent travels here too), and {kind:'reply', result: TurnResult} for the final reply ONCE at the end. Implementation: a per-turn CLOSURE BUFFER (async push/pull queue): runTurn sets up an emit closure that pushes {kind:'activity', activity} into the buffer, passes that emit into makeLiveLogger (step 1) and threads it so liveLogger rows AND orch.emit/onEvent NodeEvents land in THIS buffer, looks up the session mem+parent (sessions.ts), runs turn(mem, parent, sessionId)(message) on appRuntime (Effect boundary lives HERE), yields buffered events as they arrive, finally yields the single 'reply' event. turn() STAYS LIVE and unchanged — runTurn wraps it. sendAtom is NOT flipped yet (the old global-sink path still drives the UI; it's acceptable this step to ALSO keep emitActivity working so the live path is untouched, while the buffer captures the same events). CRITICAL: runTurn must NOT yield the final reply prose as an 'activity' text event. Purely additive; analyze WILL flag runTurn dead until step 4 — that is the ONE expected dead export; record it, do not delete or suppress.
  4. flip sendAtom [STOP]   — Flip tui sendAtom to consume runTurn(): for await (const ev of runTurn(id, text)) { ev.kind==='activity' -> the existing installSink text/tool/result/node patch logic applied to ev.activity (Msg patches + OrchTree node patches); ev.kind==='reply' -> append the final 'agent' message with TurnMeta }. Remove the installSink/setActivitySink wiring from sendAtom (it now reads the generator). NOTE: orchestrateAtom + runScriptAtom still use the old installSink path THIS step — only sendAtom flips; the others flip later or stay on the (still-present) sink until step 5. HARD INVARIANT — FINAL-REPLY-ONCE: the user's final answer appends EXACTLY ONCE (normal success, budget/max-steps recovery via answerGen, error/abort '⚠ ...' reply). Guarantee: liveLogger emits 'text' activities ONLY for intermediate steps that ALSO call tools (calls.length>0 && content) and NEVER the final step's prose; the final reply is carried solely by the 'reply' TurnEvent and appended once. Do NOT append on both an 'activity' text and the 'reply'. THIS STEP DOES NOT PROCEED until the final-reply-once invariant check returns holds=true.
  5. delete sink + re-route node-tree — Now that runTurn owns the per-turn buffer and sendAtom reads it, DELETE the global sink from core/activity.ts: remove 'let sink', setActivitySink, emitActivity, and the ponytail. Keep ONLY 'export type Activity'. Then RE-ROUTE every remaining producer AND the live node-tree consumer onto the per-turn buffer's emit:
       - orch.emit() (core/orch.ts) currently calls emitActivity -> must push the 'node' Activity through the boundary's per-turn emit instead (thread the sink in: emit() is Effect<void> at the boundary).
       - agent.onEvent() (core/agent.ts) currently = Effect.runSync(emit(...)) which lands in the global sink -> route to the buffer.
       - orch-run.ts (orchestrate) + orch-load.ts (loadAndRunOrch) emit NodeEvents via onEvent -> these are NOT yet wrapped by runTurn; either (a) give orchestrate/loadAndRunOrch their own runTurn-style buffer wrapper so orchestrateAtom/runScriptAtom can consume a generator, OR (b) flip orchestrateAtom + runScriptAtom to drive the same per-turn buffer this step. The LIVE node-tree (chat.tsx NodeView reading OrchTree) MUST still render — the OrchTree patches that today flow installSink<-node Activity must now flow runTurn-buffer<-node TurnEvent. Pick the smallest correct re-route; do NOT regress the live orchestration tree.
       - tui atoms installSink: the node->OrchTree patch logic moves to the generator consumer (it already moved for sendAtom in step 4; do the same for orchestrate/runScript here).
     After this step: grep -rn "emitActivity|setActivitySink" src MUST return ZERO. activity.ts keeps ONLY the Activity type. The orchestration tree still renders live in chat.tsx. ${LINT} green; behavior-identical.
  6. deferred TraceContext  — DEFERRED cleanup: today turn(), orchestrate(), AND loadAndRunOrch() each rebuild traceContext via otelTrace.setSpan(otelContext.active(), currentOtelSpan) and pass tracer+traceContext into LeafOpts at every call site. Introduce a small boundary helper in core (an Effect that yields {tracer, traceContext} from OtelTracerProvider + currentOtelSpan; or a Context.Service if it composes cleaner with appRuntime). Replace the hand-rolled construction in turn(), orchestrate(), loadAndRunOrch(), and runTurn(). LeafOpts MAY still carry tracer/traceContext (leaf.forward needs them) — the win is the boundary obtains them ONCE. KEEP Effect ONLY at the session boundary + otel.ts (NEVER inside the 5 combinators). Behavior identical; one trace per session preserved (chat.session -> chat.turn/chat.orchestrate -> ax gen_ai).

NON-NEGOTIABLE INVARIANTS (every step):
  - Behavior-preserving: same transcript, same trace shape (chat.session -> chat.turn -> ax gen_ai), same tool rows, same LIVE orchestration node-tree, same budget/recovery behavior. No UX or telemetry regressions.
  - core/ stays headless: NO opentui / React / Atom imports leak into src/core/. tui/ may import core/, NEVER the reverse. (After the move, a core/ file importing from ../tui/ is a layering violation = blocker.)
  - The 5 orchestration primitives stay EXACTLY 5; recipes stay userland (<15 lines). orch-run.ts + orch-load.ts are demos/loaders, NOT new primitives — do not refactor their feature behavior, only their wiring/home.
  - Effect lives ONLY at the session boundary (turn/orchestrate/loadAndRunOrch/runTurn wrapper) and otel.ts; combinators + recipes stay Promise-native.
  - Concurrent leaves NEVER share a mutating AxMemory — fork per parallel branch (orch-run.ts already does this; don't regress it).
  - The live node-tree (NodeEvent -> Activity 'node' -> OrchTree -> chat.tsx NodeView) keeps rendering at every step; step 5 RE-ROUTES it onto the buffer, never deletes the feature.
  - Real @ax-llm/ax types; minimal local structural types; any unavoidable 'any' gets a 'ponytail:' comment WITH an 'Upgrade:' trigger (bun run debt enforces). Local deps live in ../ (ax, opentui, motel, effect-smol) — read source there, not npm.

GREEN GATE for THIS workflow = ${LINT} clean (check + analyze + debt). STRICTER than the orch builds BECAUSE the whole point of a layering migration is to NOT leave debt. EXCEPTION: step 3 (runTurn alongside) may leave runTurn as a momentarily-unconsumed export (analyze 'dead export') ONLY until step 4 consumes it — note it explicitly. No OTHER new dead exports, no new unmarked any, ever. Pre-existing user dead exports (history/clipboard/toolui/abortTurn) are not yours to fix or blame.
`

// ---------------------------------------------------------------------------
// Schemas — every structured agent() call validates against one of these.
// ---------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'facts', 'cites'],
  properties: {
    area: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' }, description: 'verbatim signatures / contract facts, copied not paraphrased' },
    cites: { type: 'array', items: { type: 'string' }, description: 'file:line citations backing each fact' },
  },
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['step', 'status', 'behaviorPreserved', 'filesChanged', 'diff', 'lintOutput', 'committed', 'commitSha', 'newPonytails', 'expectedDeadExports', 'notes'],
  properties: {
    step: { type: 'string', description: 'the step key being implemented' },
    status: { type: 'string', enum: ['green', 'red'], description: 'green = `bun run lint` clean (modulo the explicitly-expected step-3 runTurn dead export)' },
    behaviorPreserved: { type: 'boolean', description: 'true if this step is behavior-identical (transcript/trace/tool rows/live node-tree unchanged); false only if the step intentionally changes wiring (steps 4/5) but preserves observable behavior' },
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'absolute or src/-relative paths touched' },
    diff: { type: 'string', description: 'unified git diff of THIS step only' },
    lintOutput: { type: 'string', description: 'final `bun run lint` tail: "clean" or verbatim errors' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    newPonytails: { type: 'array', items: { type: 'string' }, description: 'any ponytail: markers added, each WITH its Upgrade: trigger' },
    expectedDeadExports: { type: 'array', items: { type: 'string' }, description: 'exports analyze flags dead that are EXPECTED for this step (e.g. runTurn before step 4); empty otherwise' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'block'], description: 'pass = ship it; block = at least one blocker' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          isBlocker: { type: 'boolean' },
          where: { type: 'string', description: 'file:line' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

// The final-reply-once invariant check (step 4 STOP gate) gets its own schema —
// it is the load-bearing safety check of this migration.
const INVARIANT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['invariant', 'holds', 'evidence', 'doubleAppendRisk', 'lostReplyRisk', 'notes'],
  properties: {
    invariant: { type: 'string', description: 'restate: the final reply is appended to the transcript EXACTLY ONCE' },
    holds: { type: 'boolean', description: 'true ONLY if the reply is appended exactly once on every path (success, budget-recovery, error)' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'file:line trace: who emits the reply, who appends it, why liveLogger never re-emits the final prose, why no activity-text path also appends' },
    doubleAppendRisk: { type: 'string', description: 'concrete description of any path that could append the reply twice, or "none found"' },
    lostReplyRisk: { type: 'string', description: 'concrete description of any path (abort/error/budget recovery) where the reply could be DROPPED, or "none found"' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
// SCOUT — pin the exact contracts the migration rewires. Read-only, parallel
// (no writers; safe to fan out). These facts ground every later step.
// ---------------------------------------------------------------------------
phase('Scout')
const SCOUT = [
  {
    key: 'livelogger-bus',
    prompt: `Read src/agent.ts (focus liveLogger, captureFetch, onEvent) and src/activity.ts in full. Report VERBATIM: the AxLoggerFunction liveLogger signature + body (which ax message names it switches on: ChatResponseResults / ChatResponseStreamingDoneResult / FunctionResults, and EXACTLY which conditions gate a 'text' emit vs a 'tool'/'result' emit — especially the calls.length>0 && content gate that suppresses final-step prose), the emitActivity/setActivitySink signatures, the Activity union (INCLUDING the 'node' variant {kind:'node',nodeId,event,parentId?,detail?}), the onEvent = (e: NodeEvent): void => Effect.runSync(emit(e)) wiring, and the llm.setOptions({logger}) wiring. Step 1 makes liveLogger take an emit closure; step 5 deletes the global sink AND re-routes onEvent + the 'node' Activity path — all build on this exact contract.`,
  },
  {
    key: 'sendatom-final-reply',
    prompt: `Read src/atoms.ts in full. Report VERBATIM: the installSink(patch, orchPatch) helper (how it maps text/tool/result Activity -> Msg patches AND node Activity -> OrchTree patches — this is the LIVE node-tree consumer), the OrchTree/OrchNode types, and for EACH of sendAtom / orchestrateAtom / runScriptAtom: where it appends the 'you' message, where it calls installSink + setActivitySink(null), where it invokes turn()/orchestrate()(...)/loadAndRunOrch()(...), and — CRITICAL — where the FINAL 'agent' reply is appended (the patch append { kind:'agent', text: res.reply, meta }) and how that is distinct from any intermediate 'text' activity row. This IS the final-reply-once contract step 4 must preserve, and the node->OrchTree path step 5 must re-route. Cite file:line. Report the ACTUAL current state truthfully (no idealization).`,
  },
  {
    key: 'turn-orch-boundary',
    prompt: `Read src/agent.ts turn(), src/orch-run.ts (orchestrate), and src/orch-load.ts (loadAndRunOrch) in full. Report: turn()'s signature ((mem, parent, sessionId) => Effect.fn -> (message) => Effect<TurnResult>) and the TurnResult shape {reply,tokens?,finishReason?,budget}; how each of the three builds LeafOpts (tracer/traceContext from OtelTracerProvider + currentOtelSpan + otelTrace.setSpan); how agentNode()/agent()/judge are invoked; the budget/recovery (isMaxSteps -> answerGen) path in turn(); how onEvent() emits NodeEvents in orchestrate + loadAndRunOrch (root/judge/verify/script-root brackets); the OrchPrims + OrchLoadCtx shapes; and how appRuntime runs them (atoms: turn(...)(text) / orchestrate(...)() / loadAndRunOrch(...)()). runTurn() (step 3) wraps turn(); step 5 re-routes the orch onEvent path; step 6 factors out traceContext from all three. Cite file:line.`,
  },
  {
    key: 'tracectx-otel',
    prompt: `Read src/otel.ts in full and the otel imports in src/agent.ts + src/orch-run.ts + src/orch-load.ts. Report: the OtelTracerProvider Context.Service definition, currentOtelSpan, SERVICE_NAME/SERVICE_VERSION, appRuntime = Atom.runtime(TracingLive), and EVERY site that builds traceContext via otelTrace.setSpan(otelContext.active(), otelSpan) (agent.ts turn, orch-run.ts orchestrate, orch-load.ts loadAndRunOrch optsFor). Step 6 introduces a TraceContext helper/service to obtain {tracer, traceContext} once at the boundary instead of repeating this at all three call sites. Cite file:line.`,
  },
  {
    key: 'layout-imports',
    prompt: `Read package.json (scripts: chat/check/lint/test/analyze/debt/emit) and list src/ (bun run: ls src). Report: the current src/ file list, which files are HEADLESS (no @opentui/react / React / effect .../Atom import) vs UI, with SPECIAL attention to orch-run.ts + orch-load.ts (confirm both are headless -> core/) and toolui.ts/clipboard.ts/history.ts classification. Dump every cross-file relative import among agent/orch/orch-recipes/orch-run/orch-load/activity/sessions/tools/toolui/atoms/chat/clipboard/history, and the package.json script paths that reference src/chat.tsx or other entrypoints. Step 2 (folder move) needs this exact import graph + entrypoint paths for a pure mechanical move. Run: grep -rn "from \\"\\./" src to dump the relative-import graph. Cite file:line.`,
  },
]

const scout = (await parallel(SCOUT.map((s) => () =>
  agent(
    `${s.prompt}\n\nReturn structured facts. area="${s.key}". Copy signatures + conditions VERBATIM; cite file:line for every fact. Do NOT invent or idealize — report the code as it actually is today.\n\n${ARCH}`,
    { label: s.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' },
  ),
))).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/${SCOUT.length} contracts`)

// ---------------------------------------------------------------------------
// STEPS — strictly sequential (shared working tree on main; each step builds on
// the prior committed state). No parallel writers. Per-step: implement -> heal to
// lint-green -> adversarial review (parallel lenses) -> harden blockers. Step 4
// (flip-sendatom) additionally runs the final-reply-once INVARIANT CHECK as a STOP
// GATE before the step is allowed to count as done.
// ---------------------------------------------------------------------------
const STEPS = [
  {
    key: 'pure-livelogger', title: 'pure-livelogger',
    spec: `STEP 1 — pure liveLogger (no global). Change src/agent.ts so liveLogger no longer closes over the module-global emitActivity. Make it accept an emit closure — preferred shape: const makeLiveLogger = (emit: (a: Activity) => void): AxLoggerFunction => (m) => { ... emit(...) ... }. Wire turn() to build the logger with emit = emitActivity for now (so behavior is IDENTICAL this step). llm.setOptions({logger}) currently installs ONE logger at module load — keep a default logger bound to emitActivity so existing behavior holds, OR thread the per-turn logger if the wiring allows without changing observable order; choose the SMALLEST diff that removes liveLogger's hidden global dependency. CRITICAL: preserve the exact emit conditions (final-step prose is NOT emitted as a 'text' activity; only intermediate-step narration with tool calls is — the calls.length>0 && content gate). Do NOT touch the onEvent/NodeEvent path this step (that's step 5). This is the prerequisite for the per-turn buffer (step 3) and the sink deletion (step 5). Behavior-identical; ${LINT} green.`,
  },
  {
    key: 'folder-move', title: 'folder-move',
    spec: `STEP 2 — folder move (MECHANICAL ONLY, zero logic change). Create src/core/ and src/tui/. Move HEADLESS files to src/core/: agent.ts, orch.ts, orch-recipes.ts, orch-run.ts, orch-load.ts, activity.ts, sessions.ts, tools.ts, toolui.ts (verify toolui is headless; if it imports opentui, it goes to tui/ instead — use scout's classification). Move UI files to src/tui/: atoms.ts (keep as ONE file this step — NO store/actions split), chat.tsx, clipboard.ts, history.ts. Use git mv so history is preserved. Then fix ONLY import paths: relative imports between moved files, plus otel.ts (otel.ts stays in src/ root as shared infra OR moves to core/ if it has no UI deps — verify via scout's headless/UI classification and pick the layering-correct home; if imported by BOTH core and tui, src/ root or core/ is fine as long as tui->core direction holds, never the reverse). FOLDERS NOT PACKAGES: no new package.json, no exports map, relative imports only. Update package.json scripts that point at moved entrypoints (chat: src/chat.tsx -> src/tui/chat.tsx; the emit/smoke script if it imports moved files). Enforce layering: NO src/core/ file may import from ../tui/. orch-run.ts + orch-load.ts are HEADLESS demos/loaders -> core/. The diff must be PURE moves + path rewrites — if you find yourself changing any logic, stop. ${LINT} green; behavior-identical.`,
  },
  {
    key: 'runturn-along', title: 'runturn-along',
    spec: `STEP 3 — runTurn() AsyncGenerator ALONGSIDE turn(). Add src/core/run.ts exporting:
  export type TurnEvent = { kind: 'activity'; activity: Activity } | { kind: 'reply'; result: TurnResult }
  export async function* runTurn(sessionId: string, message: string): AsyncGenerator<TurnEvent>
Implementation — a PER-TURN CLOSURE BUFFER (push/pull async queue; a tiny hand-rolled queue with a pending-resolver, or Effect's Queue if it stays at the boundary): runTurn sets up an emit closure that PUSHES { kind:'activity', activity } into the buffer; passes that emit into makeLiveLogger (step 1) AND threads it so liveLogger rows AND the orch.emit/agent.onEvent NodeEvent->'node' Activity events land in THIS buffer (this turn's node-tree events too — runTurn must be the per-turn home for BOTH liveLogger rows and node-tree events). Look up the session's mem+parent from sessions.ts, run turn(mem, parent, sessionId)(message) on appRuntime (Effect boundary lives HERE), yield buffered events as they arrive, and when it resolves yield exactly one { kind:'reply', result } at the end. turn() STAYS UNCHANGED and LIVE; sendAtom is NOT flipped this step (it's acceptable to ALSO keep emitActivity live so the old UI path is untouched while the buffer captures the same events). CRITICAL: runTurn must NOT yield the final reply prose as an 'activity' text event — the final reply is carried solely by the 'reply' event (this makes step 4's final-reply-once invariant hold). Purely additive. NOTE: runTurn will be an unconsumed export until step 4 — analyze WILL flag it dead; that is the ONE expected dead export. Record it in expectedDeadExports; do NOT suppress analyze or delete the export. Everything else ${LINT} green; behavior-identical (old UI path + live node-tree untouched).`,
  },
  {
    key: 'flip-sendatom', title: 'flip-sendatom', stop: true,
    spec: `STEP 4 — flip sendAtom onto runTurn() [STOP GATE]. In src/tui/atoms.ts, change ONLY sendAtom to consume runTurn() instead of the global sink:
  patch append 'you'; busy=true; for await (const ev of runTurn(id, text)) { if (ev.kind==='activity') <apply the existing installSink text/tool/result/node patch logic to ev.activity — both the Msg patches AND the node->OrchTree patches>; else if (ev.kind==='reply') <append the final 'agent' message with TurnMeta built from ev.result> }; busy=false.
Remove the installSink/setActivitySink wiring from sendAtom (it now reads the generator). LEAVE orchestrateAtom + runScriptAtom on the old installSink path for now — they flip/re-route in step 5; do NOT break them. You may extract the text/tool/result/node patch logic into a shared reducer so sendAtom (generator) and the still-sink-driven orchestrate/runScript paths can both use it.
HARD INVARIANT — FINAL-REPLY-ONCE: the user's final answer appends EXACTLY ONCE on every path (normal success, budget/max-steps recovery via answerGen, and error/abort which yields a '⚠ ...' reply). The guarantee: liveLogger emits 'text' activities ONLY for intermediate steps that ALSO call tools (calls.length>0 && content) and NEVER the final step's prose; the final reply is delivered solely by the 'reply' TurnEvent and appended once. Do NOT append on both an 'activity' text and the 'reply'; do NOT let runTurn emit the final prose as a 'text' activity. Preserve the existing error mapping (abort -> "Interrupted.", max-steps -> the step-limit nudge) by keeping turn()'s catchCause OR ensuring the 'reply' event still carries a TurnResult on failure (a reply must ALWAYS be yielded, even on failure, so it can't be dropped). The live node-tree must still render for sendAtom turns (node activities flow through the generator now). ${LINT} green. THIS STEP IS NOT DONE until the final-reply-once invariant check (run automatically after impl+review) returns holds=true.`,
  },
  {
    key: 'delete-sink', title: 'delete-sink',
    spec: `STEP 5 — delete the global sink AND re-route the live node-tree. In src/core/activity.ts remove: 'let sink', setActivitySink, emitActivity, and the "single global sink" ponytail comment. Keep ONLY 'export type Activity'. Then RE-ROUTE every remaining producer + the node-tree consumer onto the per-turn buffer:
  PRODUCERS (must stop calling emitActivity):
    - orch.emit() in src/core/orch.ts maps NodeEvent -> 'node' Activity and pushed it via emitActivity; thread the per-turn buffer's emit in via the boundary (emit() is Effect<void> — give it the sink) so 'node' activities land in the buffer.
    - agent.onEvent() (= Effect.runSync(emit(...))) in src/core/agent.ts must route to the buffer, not the deleted global.
    - orch-run.ts (orchestrate) + orch-load.ts (loadAndRunOrch) emit NodeEvents via onEvent — these are NOT wrapped by runTurn yet. Either (a) add a runTurn-style buffer wrapper for orchestrate/loadAndRunOrch (preferred: a small runOrch()/runScript() generator in core/run.ts mirroring runTurn) and flip orchestrateAtom + runScriptAtom in src/tui/atoms.ts to consume it, OR (b) give them the same per-turn emit so the buffer captures their node events. Pick the smallest correct re-route.
  CONSUMER (the LIVE node-tree):
    - src/tui/atoms.ts installSink's node->OrchTree patch logic: sendAtom already consumes it via the generator (step 4). Move orchestrateAtom + runScriptAtom onto the same generator-driven reducer so their node Activities -> OrchTree patches still flow. chat.tsx NodeView is UNCHANGED — it reads OrchTree; only the path that fills OrchTree changes.
  After this step: grep -rn "emitActivity|setActivitySink" src MUST return ZERO. activity.ts keeps ONLY 'export type Activity'. The orchestration node-tree (chat.tsx NodeView) STILL renders live for turn AND orchestrate AND /run script. ${LINT} green; behavior-identical (transcript + live orch tree still render via the per-turn buffer).`,
  },
  {
    key: 'deferred-tracectx', title: 'deferred-tracectx',
    spec: `STEP 6 — deferred TraceContext. Today turn(), orchestrate(), AND loadAndRunOrch() each rebuild traceContext via otelTrace.setSpan(otelContext.active(), currentOtelSpan) and pass tracer+traceContext into LeafOpts at every call site. Introduce a small boundary helper in core (preferred: an Effect that yields { tracer, traceContext } from OtelTracerProvider + currentOtelSpan, e.g. const useTraceContext = Effect.gen(...) returning the pair; or a Context.Service if it composes more cleanly with appRuntime). Replace the hand-rolled construction in turn(), orchestrate(), loadAndRunOrch(), and runTurn() with this one helper. LeafOpts MAY still carry tracer/traceContext (leaf.forward needs them) — the win is the boundary obtains them ONCE in one place, not copy-pasted across all sites. Keep Effect ONLY at the boundary + otel.ts; combinators stay Promise-native. One trace per session preserved (chat.session -> chat.turn/chat.orchestrate -> ax gen_ai) — verify the trace shape is unchanged. ${LINT} green; behavior-identical. This is the deliberately-LAST, lowest-risk cleanup.`,
  },
]

const results = []
for (let i = 0; i < STEPS.length; i++) {
  const st = STEPS[i]
  if (budget.total && budget.remaining() < BUDGET_FLOOR) {
    log(`budget low (${Math.round(budget.remaining() / 1000)}k) — stopping before ${st.key}`)
    break
  }
  phase(st.title)

  // --- implement: edit main, self-heal to lint-green, commit the step alone ---
  let impl = await agent(
    `Implement migration STEP "${st.key}" in the ax2 main working tree (current branch). Earlier steps in THIS run are already committed — build on that committed state, not on an idealized tree.\n\nSTEP SPEC:\n${st.spec}\n\nRules: ${LINT} MUST end green (the ONLY tolerated analyze finding is the step-3 runTurn dead export, until step 4 consumes it — and only for step 3). Self-heal: if lint is red, diagnose + fix + re-run, up to ${MAX_HEAL} attempts. Mark any deliberate shortcut with 'ponytail:' + an 'Upgrade:' trigger (bun run debt enforces). This is BEHAVIOR-PRESERVING: do not change the transcript, the trace shape, tool rows, the LIVE orchestration node-tree, or budget/recovery behavior. When green, COMMIT this step alone with --no-verify and a conventional message 'refactor(core-tui): ${st.key} ...'. Report the commit sha, the unified diff of THIS step, the lint tail, any new ponytails, and any expected dead exports.\n\nSCOUTED CONTRACTS (ground truth):\n${CONTRACTS}\n\n${ARCH}`,
    { label: `impl:${st.key}`, phase: st.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
  )

  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > HEAL_FLOOR)) {
    heal++
    log(`${st.key}: heal ${heal} (lint red)`)
    impl = await agent(
      `STEP "${st.key}" left ${LINT} RED. Diagnose + fix in the working tree, re-run until green (the only tolerated analyze finding is the step-3 runTurn dead export, and only for step 3), then commit with --no-verify. Stay behavior-preserving and inside the settled architecture.\n\nFAILING LINT:\n${impl.lintOutput}\n\nReturn the structured result.\n\n${ARCH}`,
      { label: `heal:${st.key}:${heal}`, phase: st.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
  }

  // --- adversarial review: 2 lenses in parallel (read-only, safe to fan out) ---
  const LENSES = [
    {
      k: 'diff-review',
      focus: `DIFF REVIEW + BEHAVIOR PRESERVATION: read the committed diff and the touched files. Is "${st.key}" actually behavior-preserving — same transcript rows in the same order, same trace shape (chat.session -> chat.turn/chat.orchestrate -> ax gen_ai), same tool/budget/recovery behavior, and (CRITICAL for steps 3-5) the same LIVE orchestration node-tree still rendering in chat.tsx? For the folder-move step: is it a PURE move + path rewrite with NO logic change hidden in the diff (incl. orch-run.ts + orch-load.ts)? For the delete-sink step: are ALL node-tree producers (orch.emit, agent.onEvent, orch-run, orch-load) re-routed onto the per-turn buffer, and does the OrchTree still fill for turn AND orchestrate AND /run? For any step: did logic sneak in where only a mechanical change was specified? Are imports correct post-move? Cite file:line.`,
    },
    {
      k: 'layering-debt',
      focus: `LAYERING + DEBT: does src/core/ stay HEADLESS (no @opentui/react, no React, no effect .../Atom import; no import from ../tui/)? Are orch-run.ts + orch-load.ts in core/ and still headless? tui/ -> core/ only, never the reverse. Did the 5 orchestration primitives stay exactly 5, recipes stay <15-line userland, Effect stay at the boundary only (turn/orchestrate/loadAndRunOrch/runTurn + otel.ts)? Any NEW unmarked 'any'? Any NEW dead export OTHER than the explicitly-expected step-3 runTurn (allowed only until step 4)? After step 5: does grep -rn "emitActivity|setActivitySink" src return ZERO? Any concurrent-leaf AxMemory sharing regressed? Cite file:line.`,
    },
  ]
  const reviews = (await parallel(LENSES.map((l) => () =>
    agent(
      `Adversarially review the just-committed "${st.key}" migration step (read the touched files + the diff). Default skeptical. LENS — ${l.focus}\n\nSTEP SPEC (what it was supposed to do):\n${st.spec}\n\nDIFF:\n${impl ? impl.diff : '(impl failed)'}\n\n${ARCH}`,
      { label: `review:${st.key}:${l.k}`, phase: st.title, schema: REVIEW_SCHEMA, agentType: 'Explore' },
    ),
  ))).filter(Boolean)
  let blockers = reviews.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
  log(`${st.key}: ${reviews.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)} findings, ${blockers.length} blockers`)

  // --- STOP GATE: final-reply-once invariant check (step 4 only) ---
  // The load-bearing safety check of the whole migration. Runs after the flip,
  // before the step is allowed to count as done; a failing invariant is a blocker.
  let invariant = null
  if (st.stop) {
    invariant = await agent(
      `STOP GATE for "${st.key}". Verify the FINAL-REPLY-ONCE INVARIANT on the just-committed flip: the user's final answer is appended to the transcript EXACTLY ONCE on EVERY path — normal success, budget/max-steps recovery (answerGen), and error/abort (the "⚠ ..." reply). Trace it concretely:\n  - WHO emits the final reply (runTurn's { kind:'reply' } event from turn()'s TurnResult).\n  - WHO appends it (sendAtom's reply-branch -> patch append 'agent').\n  - WHY liveLogger NEVER re-emits the final step's prose as a 'text' activity (the calls.length>0 && content gate — final step has no tool calls, so no narration row).\n  - WHY no 'activity' text path ALSO appends the final reply (no double-append).\n  - WHETHER any path can DROP the reply (error/abort/budget — a reply event must always be yielded so it can't be lost).\nRead src/tui/atoms.ts (sendAtom), src/core/run.ts (runTurn), src/core/agent.ts (makeLiveLogger + turn). Be exhaustive and skeptical. If holds is false, name the exact double-append or lost-reply path. Cite file:line.\n\n${ARCH}`,
      { label: `invariant:${st.key}`, phase: st.title, schema: INVARIANT_SCHEMA, agentType: 'Explore' },
    )
    log(`${st.key}: final-reply-once holds=${invariant ? invariant.holds : 'unknown'}`)
    // A failed invariant is a synthetic blocker so the harden loop fixes it.
    if (invariant && !invariant.holds) {
      blockers = [
        ...blockers,
        {
          severity: 'blocker', isBlocker: true, where: 'src/tui/atoms.ts + src/core/run.ts',
          problem: `FINAL-REPLY-ONCE VIOLATED. double-append: ${invariant.doubleAppendRisk}. lost-reply: ${invariant.lostReplyRisk}.`,
          fix: 'Ensure the final reply is carried solely by the runTurn reply event and appended exactly once; never also via an activity text; always yield a reply event even on error/abort.',
        },
      ]
    }
  }

  // --- harden: fix blockers, re-run lint-green, amend; re-review (+ re-check invariant) ---
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > HEAL_FLOOR)) {
    hr++
    log(`${st.key}: harden ${hr} (${blockers.length} blockers)`)
    impl = await agent(
      `Review found BLOCKERS in migration step "${st.key}". Fix each in the working tree, keep it behavior-preserving and inside the settled architecture (core headless, 5 prims, Effect only at the boundary, live node-tree intact), re-run ${LINT} to green, then AMEND the step commit (--no-verify).\n\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\nReturn the structured result.\n\n${ARCH}`,
      { label: `harden:${st.key}:${hr}`, phase: st.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
    const rr = (await parallel(LENSES.map((l) => () =>
      agent(
        `Re-review "${st.key}" for your lens; confirm blockers closed and no new ones. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : ''}\n\n${ARCH}`,
        { label: `reverify:${st.key}:${l.k}:${hr}`, phase: st.title, schema: REVIEW_SCHEMA, agentType: 'Explore' },
      ),
    ))).filter(Boolean)
    blockers = rr.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
    // Re-run the STOP gate invariant after a harden round on step 4.
    if (st.stop) {
      invariant = await agent(
        `Re-verify the FINAL-REPLY-ONCE invariant on the amended "${st.key}" (success, budget-recovery, error/abort paths). Read src/tui/atoms.ts, src/core/run.ts, src/core/agent.ts. Cite file:line.\n\n${ARCH}`,
        { label: `invariant:${st.key}:${hr}`, phase: st.title, schema: INVARIANT_SCHEMA, agentType: 'Explore' },
      )
      log(`${st.key}: final-reply-once (after harden ${hr}) holds=${invariant ? invariant.holds : 'unknown'}`)
      if (invariant && !invariant.holds) {
        blockers = [
          ...blockers,
          {
            severity: 'blocker', isBlocker: true, where: 'src/tui/atoms.ts + src/core/run.ts',
            problem: `FINAL-REPLY-ONCE STILL VIOLATED. double-append: ${invariant.doubleAppendRisk}. lost-reply: ${invariant.lostReplyRisk}.`,
            fix: 'Carry the final reply solely on the runTurn reply event; append exactly once; always yield a reply even on failure.',
          },
        ]
      }
    }
  }

  results.push({
    step: st.key,
    status: impl ? impl.status : 'failed',
    behaviorPreserved: impl ? impl.behaviorPreserved : false,
    commit: impl ? impl.commitSha : null,
    openBlockers: blockers,
    newPonytails: impl ? impl.newPonytails : [],
    expectedDeadExports: impl ? impl.expectedDeadExports : [],
    healUsed: heal,
    hardenUsed: hr,
    files: impl ? impl.filesChanged : [],
    finalReplyOnce: st.stop ? (invariant ? invariant.holds : null) : 'n/a',
  })

  // Hard stop: if the step-4 invariant could not be made to hold, do NOT proceed to
  // sink deletion (step 5) — a double/lost reply is a user-visible regression and
  // step 5 removes the fallback global-sink path entirely.
  if (st.stop && invariant && invariant.holds === false) {
    log(`${st.key}: STOP GATE FAILED — final-reply-once does not hold; halting before delete-sink to avoid shipping a reply regression`)
    break
  }
}

// ---------------------------------------------------------------------------
// REPORT — actionable synthesis: per-step status + shas, the invariant verdict,
// residual debt, what is now cleanly headless-reusable, the single best follow-up.
// ---------------------------------------------------------------------------
phase('Report')
const report = await agent(
  `Write the final migration report for the ax2 author (blunt, terse, full technical substance, markdown). The core/tui split ran as 6 behavior-preserving steps on main, each its own commit, each green under \`${LINT}\`.\n\nCover:\n(1) HEADLINE — how many of the 6 steps landed green and behavior-preserved; if any step is red, partial, or the STOP gate failed, say it FIRST and plainly.\n(2) PER-STEP — one tight line each (pure-livelogger, folder-move, runturn-along, flip-sendatom, delete-sink, deferred-tracectx): status, commit sha, what it changed, any open blocker. Call out that folder-move relocated orch-run.ts + orch-load.ts into core/ and that delete-sink re-routed the live node-tree producers/consumer onto the per-turn buffer.\n(3) FINAL-REPLY-ONCE — the STOP-gate verdict on the flip step: does the final reply append exactly once on success / budget-recovery / error-abort? Quote the evidence path. Safety-critical — do not gloss it.\n(4) HEADLESS REUSE — is core/ now cleanly importable without opentui/React/Atom (incl. orch-run/orch-load)? Can a non-TUI caller drive runTurn(sessionId,message) as an AsyncGenerator<TurnEvent> and get BOTH liveLogger rows and node-tree events? Is the global activity sink gone (grep emitActivity = 0) and the live node-tree still rendering via the buffer?\n(5) RESIDUAL — new ponytails (with Upgrade triggers), any expected-but-unresolved dead export, the deferred-TraceContext outcome, whether orchestrateAtom/runScriptAtom were fully flipped onto the buffer or left on a bridge, any behavior risk.\n(6) NEXT — the single most valuable follow-up (e.g. the tui store/actions split this migration set up but did not execute, a headless golden-snapshot test over runTurn, or SDK createAgent DI). If anything is red / blocked / unverified, headline it; do not oversell.\n\nRESULTS (JSON):\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' },
)

return { steps: results, report }
