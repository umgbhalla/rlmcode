export const meta = {
  name: 'sdk-extraction',
  description: 'Extract ax2 core into an externally-usable SDK. RE-GROUNDED past d014b5d (+40 commits): the AxAIService is no longer in agent.ts — it is now built ONCE in src/runtime.ts (exports llm/MODEL/onEvent/rateLimiter, imported by agent.ts AND every orch-* module), and src/models.ts is a multi-model registry (Kimi+GLM via resolveModel/modelConfigFor). So the DI target is runtime.ts (one construction site), NOT three agent.ts singletons. Replace the runtime.ts module-level AxAIService/model with a createAgent({ai,tools,maxSteps,model,tokenBudget}) DI factory (model resolved through models.ts); lift the captureFetch finish-reason latch (re-pin its module — moved off agent.ts in the runtime.ts cycle-break) into per-turn context; define ONE public type+value surface (the 5 orch prims + recipes + BudgetExhaustedError + tools + TurnResult + abortTurn + the orchestrate()/loadAndRunOrch() session entries) in a NEW src/sdk.ts; and ship a runnable usage example (examples/sdk-usage.ts) that drives the core with a caller-supplied AxAIService and NO Cloudflare env. Each step is tagged BEHAVIOR-PRESERVING (pure interface extraction / re-export) or DI (real wiring change). GROUNDED to commit d014b5d: runTurn()/TurnEvent DO NOT EXIST and core-tui-split has NOT shipped — turn()/orchestrate()/loadAndRunOrch() are Effect.fn spans (Effect-returning, NOT AsyncGenerators), and the live event path is still the GLOBAL activity sink (emitActivity in src/activity.ts, consumed by atoms.ts setActivitySink). This workflow does NOT depend on runTurn and MUST NOT invent it or a per-turn buffer; it extracts the Effect-boundary turn() into an injectable factory as-is. Runs sequentially on main (shared tree), self-heals to check-green, adversarial-reviews each step, commits each as a checkpoint.',
  phases: [
    { title: 'Scout',         detail: 'parallel read-only: pin the AxAIService/MODEL/rateLimiter/onEvent construction in src/runtime.ts (the single site) + the src/models.ts multi-model registry (resolveModel/modelConfigFor) + the captureFetch finish-reason latch (re-pin its module), the orch/recipes/BudgetExhaustedError public exports, the Effect-boundary turn()/orchestrate()/loadAndRunOrch() shape (NO runTurn — confirm), and ALL runtime.ts importers (agent, orch-run, orch-load, orch-tools, …) as the injection consumers + tools registry' },
    { title: 'type-surface',  detail: 'BEHAVIOR-PRESERVING: new src/sdk.ts re-exporting the public value+type surface (leaf/parallel/pipeline/allocate/emit, BudgetExhaustedError, agent/judge/loopUntilDry/adversarialVerify, tools, AxFunction, TurnResult, abortTurn, LeafOpts/NodeEvent/Budget/BudgetUsage/EmitSink/AgentNode) from their CURRENT homes — zero logic change' },
    { title: 'finish-reason-di', detail: 'DI: lift the module-level `let lastFinishReason` latch (agent.ts ~155) into a per-turn TurnContext captured by a makeCaptureFetch(ctx) closure factory — removes the concurrency-unsafe global, prerequisite for multi-agent injection' },
    { title: 'createAgent-di', detail: 'DI: move the AxAIService construction (now in runtime.ts, NOT agent.ts) into createAgent({ai,tools,maxSteps,model,tokenBudget}) -> { turn, abortTurn }; model resolved via models.ts. Because runtime.ts is the SINGLE construction site that agent.ts + every orch-* import, inject there ONCE — no per-consumer threading. Keep module-level defaultAgent + re-exported llm/MODEL/turn/abortTurn so all current importers stay byte-identical' },
    { title: 'sdk-public-api', detail: 'BEHAVIOR-PRESERVING: finalize src/sdk.ts as the single external entrypoint — add createAgent + AxAgentConfig + AxAgentSDK; re-export the session-boundary entries orchestrate (orch-run.ts) and loadAndRunOrch (orch-load.ts) since they are intended public API; verify atoms.ts/orch-run.ts/orch-load.ts route through the factory with no behavior drift' },
    { title: 'usage-example', detail: 'DI: examples/sdk-usage.ts — a runnable headless script that calls createAgent with a caller-supplied stub AxAIService (NO CF env), runs ONE turn via the returned Effect (Effect.runPromise at the boundary), and asserts a reply + at least one emitted Activity node; doubles as the SDK smoke gate' },
    { title: 'Report',        detail: 'classification matrix (behavior-preserving vs DI per step), what an external caller can now do, residual ponytails + risk (esp. whether orch-run/orch-load still hardwire llm), the single most valuable follow-up' },
  ],
}

// ---------------------------------------------------------------------------
// Gates + loop ceilings (match orch-full-build conventions).
//   check  = tsc --noEmit                          (the HARD green gate — fast inner loop)
//   lint   = check + test + analyze + debt          (informational; dead-export / ponytail ledger)
//   smoke  = the SDK headless example (created step 6)
// (package.json: "check"=tsc --noEmit, "lint"=check && test && analyze && debt, "debt"=ponytail ledger)
// ---------------------------------------------------------------------------
const CHECK = 'bun run check'
const LINT = 'bun run lint'
const SMOKE = 'bun examples/sdk-usage.ts'
const MAX_HEAL = 4
const MAX_HARDEN = 2

// ---------------------------------------------------------------------------
// Shared spec the implementers + reviewers must honor. Encodes the SETTLED
// architecture and the ponytail / lazy-senior ethos: extract an interface,
// inject a dependency — add NO speculative ceremony. GROUNDED to commit d014b5d.
// ---------------------------------------------------------------------------
const CORE_SPEC = `
ax2 SDK EXTRACTION. The goal is an EXTERNALLY-USABLE core: a caller in another repo can
\`import { createAgent } from '<ax2>/src/sdk.ts'\`, pass their OWN AxAIService (OpenAI, Ollama,
a stub), their own tools/model/maxSteps/tokenBudget, and run turns + orchestrations WITHOUT any
Cloudflare env var. Today THREE module-level singletons in src/agent.ts hardwire CF-Kimi and block this:
  - llm = ai({ name:"openai", apiKey: process.env.CLOUDFLARE_API_TOKEN!, apiURL: \`https://api.cloudflare.com/client/v4/accounts/\${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1\`, config:{ model: MODEL } })   (src/agent.ts ~36-41, EXPORTED — and it is THE thing turn() forwards over)
  - chat = ax('message:string -> reply:string', { functions: tools }); chat.setDescription(BASE_PROMPT + loadProjectDoc())   (src/agent.ts ~77-78, module-local)
  - answerGen = ax('message:string -> reply:string'); answerGen.setDescription(...no-tools recovery nudge...)               (src/agent.ts ~82-85, module-local)
plus a CONCURRENCY-UNSAFE module latch: \`let lastFinishReason: string | undefined\` (src/agent.ts ~155) written by
captureFetch (the fetch wrapper at ~157-169 that skims choices[0].finish_reason off a res.clone().json()),
RESET inside turn() (\`lastFinishReason = undefined\`, ~277) and READ after forward (the addGenAIAnnotations
finishReasons line ~362 + the TurnResult.finishReason field ~393). Safe ONLY because turns are serialized by
busyAtom — injected/concurrent DI breaks that. captureFetch + liveLogger are bound ONCE via
\`llm.setOptions({ debug:true, logger: liveLogger, fetch: captureFetch })\` (~175).

SETTLED ARCHITECTURE — DO NOT CONTRADICT:
- core stays EXACTLY 5 orch primitives (leaf, parallel, pipeline, emit, allocate) in src/orch.ts. NEVER add a 6th. Recipes (agent/judge/loopUntilDry/adversarialVerify) stay USERLAND in src/orch-recipes.ts. BudgetExhaustedError is ALREADY a typed export in src/orch.ts (~54) — reuse it, NEVER redefine.
- Promise-native at the combinator level; Effect ONLY at the session boundary and otel.ts. turn() (src/agent.ts), orchestrate() (src/orch-run.ts), and loadAndRunOrch() (src/orch-load.ts) are each an \`Effect.fn(...)(function*(){...})\` — they RETURN AN EFFECT (the call site does \`turn(mem,parent,id)(text)\` / \`orchestrate(parent,id,text)()\` and pipes the Effect). The SDK factory MUST keep turn() Effect-returning — do NOT push Effect into the recipes, and do NOT convert turn() into an AsyncGenerator.
- runTurn() / a TurnEvent union / a per-turn closure buffer DO NOT EXIST as of d014b5d (core-tui-split has NOT shipped). The LIVE event path is the GLOBAL activity sink: orch.emit() / agent.ts onEvent() push via \`emitActivity\` (src/activity.ts), and atoms.ts installs a per-turn sink via \`setActivitySink\` for the duration of a turn. DO NOT assume, invent, or depend on runTurn/TurnEvent/a per-turn buffer. Build on the ACTUAL Effect-boundary turn() and the existing global sink. (If a future core-tui-split lands runTurn, a follow-up workflow re-points this — out of scope here.)
- One trace per session (chat.session -> chat.turn -> ax gen_ai). Per-session AxMemory (src/sessions.ts SessionRT) is never shared across concurrent leaves (orch-run/orch-load fork a fresh AxMemory per parallel branch via optsFor()).
- Real @ax-llm/ax types where exported (AxAIService, AxGen, AxFunction, AxMemory, AxProgramForwardOptions, AxLoggerFunction); minimal local structural types otherwise. Any UNAVOIDABLE \`any\` gets a 'ponytail:' comment WITH an 'Upgrade:' trigger line (bun run debt enforces). Local deps live in ../ (ax, opentui, motel, effect-smol) — read source there, not npm.

ETHOS (ponytail / lazy-senior): this is interface extraction + dependency injection, not a rewrite. Move construction, do not reinvent it. Keep BASE_PROMPT, loadProjectDoc, the budget-exhaustion recovery (answerGen nudge + isMaxSteps catch), the OTel annotations (Telemetry.addGenAIAnnotations), the AbortController-per-session (turnAborters), and the metrics (turnsTotal/turnsFailed/tokensTotal/turnDuration) EXACTLY as they are — just close them over injected config instead of module globals. Add NO new abstraction layer, NO config validation ceremony, NO speculative provider adapters. Default createAgent's tools to the existing \`tools\` array (src/tools.ts), model/maxSteps/tokenBudget to today's constants (MODEL, MAX_STEPS, TOKEN_BUDGET), and logger to the existing liveLogger so the APP keeps working byte-for-byte.

CLASSIFICATION (every step is one or the other — state which in the result):
- BEHAVIOR-PRESERVING = pure interface extraction / re-export. No runtime path changes. Diff is moves + exports.
- DI = a real wiring change: a singleton becomes a factory parameter, or module state becomes per-turn state. Behavior of the APP must stay identical (same defaults), but the SHAPE of who-constructs-what changes.

GREEN GATE = ${CHECK} clean (tsc --noEmit). ${LINT} (check + test + analyze + debt) may stay RED ONLY on documented PRE-EXISTING user dead exports (e.g. history/clipboard helpers, agent.ts abortTurn / projectDocLoaded before sdk.ts consumes them, orch.ts emit/pipeline re-exports already only used by orch-load) — never blame those on this work, never delete the user's in-flight files. Every NEW export YOU add MUST be consumed (by the app, orch-run.ts, orch-load.ts, the usage example, or be part of the documented public SDK surface re-exported from src/sdk.ts) — no NEW dead exports.
`

// ---------------------------------------------------------------------------
// Schemas.
// ---------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'facts', 'cites'],
  properties: {
    area: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' }, description: 'verbatim signatures / shapes / construction sites — copy, do not paraphrase' },
    cites: { type: 'array', items: { type: 'string' }, description: 'file:line for every fact' },
  },
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'classification', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'behaviorDrift', 'notes'],
  properties: {
    status: { type: 'string', description: 'green | red (green = check clean modulo pre-existing dead exports)' },
    classification: { type: 'string', description: 'behavior-preserving | DI — which kind of change this step actually was' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string', description: 'unified git diff of THIS step' },
    checkOutput: { type: 'string', description: 'final check tail: "clean" or verbatim errors' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    newPonytails: { type: 'array', items: { type: 'string' }, description: 'any ponytail: markers added, each WITH its Upgrade: trigger' },
    behaviorDrift: { type: 'string', description: 'PROVE no app behavior changed (same defaults, same trace shape) OR name the intended drift precisely. "none" if behavior-preserving.' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', description: 'pass | blockers' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
        properties: {
          severity: { type: 'string', description: 'high | med | low' },
          isBlocker: { type: 'boolean' },
          where: { type: 'string', description: 'file:line' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'matrix', 'externalCallerCan', 'residualRisk', 'nextStep', 'narrative'],
  properties: {
    headline: { type: 'string', description: 'one blunt line: how many of the 5 steps landed green, anything red/partial' },
    matrix: {
      type: 'array',
      description: 'the classification matrix — one row per step',
      items: {
        type: 'object', additionalProperties: false,
        required: ['step', 'classification', 'status', 'commit', 'whatChanged'],
        properties: {
          step: { type: 'string' },
          classification: { type: 'string', description: 'behavior-preserving | DI' },
          status: { type: 'string' },
          commit: { type: 'string' },
          whatChanged: { type: 'string' },
        },
      },
    },
    externalCallerCan: { type: 'array', items: { type: 'string' }, description: 'concrete capabilities a foreign caller now has (e.g. inject OpenAI, run headless with no CF env)' },
    residualRisk: { type: 'array', items: { type: 'string' }, description: 'new ponytails (with Upgrade triggers), known pre-existing dead exports, any unsound cast or remaining global state, whether orch-run/orch-load still hardwire llm' },
    nextStep: { type: 'string', description: 'the single most valuable follow-up' },
    narrative: { type: 'string', description: 'full markdown report for the ax2 author — blunt, terse, technical' },
  },
}

// ===========================================================================
// SCOUT — pin the exact construction sites + public surface. PARALLEL: four
// disjoint read-only reconnaissance lanes, no shared writes -> fan out, barrier.
// ===========================================================================
phase('Scout')
const SCOUT = [
  {
    key: 'singletons-latch',
    prompt: `Read src/agent.ts IN FULL. Report VERBATIM: (1) the three construction sites — \`export const llm = ai({...})\` with every field (name, apiKey expr, apiURL expr, config.model cast), \`const chat = ax(...)\` + its setDescription(BASE_PROMPT + loadProjectDoc()), \`const answerGen = ax(...)\` + its setDescription; (2) the module constants MODEL ("@cf/moonshotai/kimi-k2.7-code"), PROVIDER ("cloudflare.workers-ai"), MAX_STEPS, TOKEN_BUDGET, BASE_PROMPT, BUDGET_NUDGE and where each is read; (3) loadProjectDoc + projectDocLoaded; (4) the captureFetch + \`let lastFinishReason\` latch — the wrap (~157-169), where it's reset (\`lastFinishReason = undefined\` ~277), where it's read (the addGenAIAnnotations finishReasons line ~362 + TurnResult.finishReason ~393), and readResponseId; (5) the \`llm.setOptions({ debug, logger, fetch })\` wiring (~175) — note that logger+fetch are bound ONCE on the singleton; (6) the EXACT turn() signature \`turn(mem: AxMemory, parent: AnySpan, sessionId: string) => Effect.fn("chat.turn",...)(function*(message:string){...})\` and what it closes over (chat, answerGen, llm, MODEL, MAX_STEPS, TOKEN_BUDGET, budget=allocate(...), usageOf, turnAborters, the 4 metrics) — CONFIRM it returns an Effect (NOT an AsyncGenerator) and there is NO runTurn export; (7) the exported surface today: MODEL, llm, projectDocLoaded, onEvent, readUsageOf, limits, TurnResult, abortTurn, turn. Cite file:line. This is the DI target — copy signatures exactly.`,
  },
  {
    key: 'orch-recipes-exports',
    prompt: `Read src/orch.ts and src/orch-recipes.ts IN FULL. Report VERBATIM every export + full signature: from orch.ts — LeafOpts (all fields), NodeEvent (all 4 variants), EmitOpts, BudgetUsage, Budget, BudgetExhaustedError (the typed throwable class, confirm it is EXPORTED ~54), leaf, parallel, pipeline, emit (note: Effect<void>-returning), allocate; from orch-recipes.ts — EmitSink, AgentNode, agent, judge, loopUntilDry, adversarialVerify. Note WHICH are values vs types. These are the public composition surface the SDK re-exports UNCHANGED. CONFIRM BudgetExhaustedError lives in orch.ts (so sdk.ts re-exports it from there, never redefines it). Cite file:line.`,
  },
  {
    key: 'boundary-shape',
    prompt: `Read src/orch-run.ts and src/orch-load.ts IN FULL, and the Effect-boundary signature in src/agent.ts. Report the CURRENT shape of the three SESSION-BOUNDARY entries — each is an \`Effect.fn(name, {kind,parent,attributes})(function*(){...})\` returning an Effect: (1) turn(mem, parent, sessionId) (agent.ts); (2) orchestrate(parent, sessionId, message) -> OrchestrateResult { reply, candidates, accepted, votes } (orch-run.ts ~69); (3) loadAndRunOrch(parent, sessionId, scriptRef, message) -> OrchLoadResult { reply, detail? } (orch-load.ts ~135), plus its OrchPrims / OrchLoadCtx types and ORCH_SCRIPTS_DIR (~44). CONFIRM EXPLICITLY: there is NO runTurn(), NO TurnEvent union, NO per-turn closure buffer — the live node-event path is the GLOBAL activity sink (orch.emit/agent.onEvent -> emitActivity in src/activity.ts -> atoms setActivitySink). Read src/activity.ts: report setActivitySink/emitActivity (~20-26) and confirm the GLOBAL \`let sink\` is the current mechanism (NOT vestigial). If anything named runTurn/TurnEvent exists, SAY SO with file:line; if absent, state "absent". Cite file:line.`,
  },
  {
    key: 'consumers-tools',
    prompt: `Read src/tools.ts, src/orch-run.ts, src/orch-load.ts, src/atoms.ts, and src/sessions.ts. Report the THREE consumers that must keep working byte-for-byte after createAgent DI: (1) the tools registry — \`export const tools: AxFunction[]\` and the AxFunction import (tools.ts), and how chat consumes it (\`{ functions: tools }\` in agent.ts); (2) src/orch-run.ts line 24 \`import { limits, llm, MODEL, onEvent, readUsageOf } from "./agent.ts"\` — it imports the BARE llm singleton and passes it to judge()/node(); orchestrate() must take the injected ai instead; (3) src/orch-load.ts line 26 \`import { limits, llm, MODEL, onEvent, readUsageOf } from "./agent.ts"\` — SAME bare-llm import (OrchLoadCtx.ai = llm); loadAndRunOrch() must take the injected ai too. NOTE: BOTH orch-run AND orch-load import the singleton (the old workflow only knew about orch-run — re-ground to BOTH). (4) src/atoms.ts — \`import { turn } from "./agent.ts"\` (~10), \`orchestrate\` from orch-run (~12), \`loadAndRunOrch\` from orch-load (~11); sendAtom calls \`turn(rt.mem, rt.parent, id)(text)\` (~181), orchestrateAtom calls \`orchestrate(rt.parent, id, text)()\` (~245), runScriptAtom calls \`loadAndRunOrch(...)()\` (~307); SessionRT.mem/parent flow from src/sessions.ts sessionsRT map. These are the consumers; atoms.ts is the app caller and must import the SAME names with IDENTICAL behavior. Cite file:line.`,
  },
]
const scout = (await parallel(SCOUT.map((s) => () =>
  agent(
    `${s.prompt}\n\nReturn structured facts. area="${s.key}". Copy signatures VERBATIM; cite file:line for every fact. Do not invent — if something is absent (e.g. runTurn), say it is absent.\n\n${CORE_SPEC}`,
    { label: s.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' },
  )
))).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/4 surfaces`)

// ===========================================================================
// STEPS — built strictly in order; each depends on the prior. SEQUENTIAL
// (shared working tree on main — exactly one writer at a time). Each step is
// tagged behavior-preserving vs DI in its spec AND must self-report which it was.
// ===========================================================================
const STEPS = [
  {
    key: 'type-surface',
    title: 'type-surface',
    kind: 'behavior-preserving',
    spec: `BEHAVIOR-PRESERVING (pure re-export, ZERO logic change). Create src/sdk.ts as the SINGLE public import surface. Re-export, with one-line JSDoc each, the existing public surface — do NOT move definitions, do NOT change them, just re-export from their current homes:
  • from src/orch.ts:        value exports leaf, parallel, pipeline, allocate, BudgetExhaustedError; type exports LeafOpts, NodeEvent, EmitOpts, Budget, BudgetUsage.  (BudgetExhaustedError is the typed throwable class ALREADY exported from orch.ts ~54 — re-export it from there, NEVER redefine.) emit() is Effect<void>-returning: re-export it too but JSDoc it as "session-boundary only".
  • from src/orch-recipes.ts: value exports agent, judge, loopUntilDry, adversarialVerify; type exports EmitSink, AgentNode. (Keep the original name \`agent\` exported so existing imports don't break.)
  • from src/tools.ts:        value export tools (the default registry); re-export the AxFunction type via \`export type { AxFunction } from '@ax-llm/ax'\`.
  • from src/agent.ts:        type export TurnResult; value export abortTurn.  (Do NOT yet export createAgent — it does not exist until step 4. Do NOT re-export the llm singleton — it is being removed/wrapped in step 4.)
  • Do NOT re-export runTurn or a TurnEvent type — THEY DO NOT EXIST (core-tui-split has not shipped). turn()/orchestrate()/loadAndRunOrch() are Effect-returning session entries; orchestrate + loadAndRunOrch get added in step 5 once their ai is injectable. If scout reported any runTurn/TurnEvent under those names, NOTE it — but the ground truth is they are absent.
Add a top-of-file doc comment: "Public SDK surface for ax2 core. External callers import ONLY from here." This is a leaf module (no new logic), so analyze may flag its re-exports as unused until the usage example (step 6) and sdk-public-api (step 5) consume them — that is EXPECTED; note it. ${CHECK} must stay green (tsc --noEmit).`,
  },
  {
    key: 'finish-reason-di',
    title: 'finish-reason-di',
    kind: 'DI',
    spec: `DI (real change: kill a concurrency-unsafe module global). Replace the module-level \`let lastFinishReason\` latch in src/agent.ts (~155) with PER-TURN state, so an injected/concurrent caller is safe. Steps:
  • Define a tiny per-turn carrier: \`type TurnContext = { finishReason?: string }\` (local to agent.ts; do NOT over-engineer — no class, no service).
  • Change captureFetch from a module-singleton fetch into a FACTORY \`const makeCaptureFetch = (ctx: TurnContext): typeof fetch => (async (input, init) => {...})\` whose closure writes \`ctx.finishReason = fr\` instead of the module var. Keep the EXACT res.clone().json() skim of choices[0].finish_reason + the "Bun's typeof fetch carries .preconnect ax never calls" cast comment.
  • In turn(): allocate \`const turnCtx: TurnContext = {}\` per invocation; read \`turnCtx.finishReason\` where lastFinishReason was read (the addGenAIAnnotations finishReasons line ~362 + the TurnResult.finishReason field ~393). Remove the \`lastFinishReason = undefined\` reset line (~277) — the fresh per-turn object replaces it.
  • WIRING DETAIL: today logger+fetch are set ONCE via \`llm.setOptions({ debug, logger, fetch: captureFetch })\` (~175) on the singleton. Per-turn fetch means binding the per-turn fetch inside turn() before forward. Check ../ax/src for whether forward() accepts a per-call fetch in its opts; if it does, thread it through (cleanest). If it does NOT, set \`llm.setOptions({ fetch: makeCaptureFetch(turnCtx) })\` inside turn() before runForward — this is still correct because turns are serialized by busyAtom; mark it 'ponytail:' WITH 'Upgrade: per-call fetch when ax exposes it in forward opts', naming the busyAtom serialization assumption. Keep debug+logger bound on the service (they don't change per turn). Prefer the clean per-call-fetch path if ax supports it.
This unblocks step 4 (a second injected agent can't be corrupted by a shared latch). App behavior: identical (same finish_reason surfaced). ${CHECK} green.`,
  },
  {
    key: 'createAgent-di',
    title: 'createAgent-di',
    kind: 'DI',
    spec: `DI (the core change). Introduce \`createAgent\` in src/agent.ts that moves the THREE singletons (llm, chat, answerGen) into a factory, injecting the AI service + tools + model + step/token limits. Required shape (use scout's verbatim current types):
  • \`export type AxAgentConfig = { ai: AxAIService; model: string; maxSteps?: number; tokenBudget?: number; tools?: AxFunction[]; logger?: AxLoggerFunction }\` — \`ai\` and \`model\` required; maxSteps default = current MAX_STEPS, tokenBudget default = current TOKEN_BUDGET, tools default = the existing \`tools\` array (src/tools.ts), logger default = the existing liveLogger.
  • \`export const createAgent = (config: AxAgentConfig): AxAgentSDK => { ... }\` whose body constructs, ONCE per call (closure-scoped, not module-scoped): the chat gen (\`ax('message:string -> reply:string', { functions: config.tools ?? tools })\` + setDescription(BASE_PROMPT + loadProjectDoc())), the answerGen (+ its recovery setDescription), and binds debug+logger on config.ai via setOptions({ debug:true, logger: config.logger ?? liveLogger }). The per-turn fetch from step 3 (makeCaptureFetch) is wired INSIDE turn() over config.ai. turn() closes over THESE locals + config.model/maxSteps/tokenBudget instead of the module llm/chat/answerGen/MODEL/MAX_STEPS/TOKEN_BUDGET.
  • \`export type AxAgentSDK = { turn(mem: AxMemory, parent: AnySpan, sessionId: string): (message: string) => Effect.Effect<TurnResult, ...>; abortTurn(sessionId: string): boolean }\` — turn() STAYS Effect-returning (the Effect.fn span + budget recovery + metrics + OTel annotations live INSIDE the closure exactly as today, just sourced from config). There is NO runTurn — do NOT invent one. PROVIDER stays a constant ("cloudflare.workers-ai") — it is provider-name metadata; if you want it configurable, add \`provider?: string\` to AxAgentConfig defaulting to PROVIDER, else keep the constant and note it.
  • PRESERVE THE APP: keep a module-level \`export const llm = ai({...CF env...})\` (still constructed from CF env at module scope — this is the app's default wiring) and \`export const defaultAgent = createAgent({ ai: llm, model: MODEL })\`. Re-export \`export const turn = defaultAgent.turn\` and \`export const abortTurn = defaultAgent.abortTurn\` so atoms.ts (which does \`turn(rt.mem, rt.parent, id)(text)\`) and chat.tsx (abortTurn) import the SAME names with IDENTICAL behavior.
  • THREAD INJECTED ai INTO BOTH ORCH BOUNDARIES (scout confirmed BOTH import the bare llm): src/orch-run.ts (line 24) and src/orch-load.ts (line 26) each \`import { limits, llm, MODEL, onEvent, readUsageOf } from "./agent.ts"\`. Minimal app-preserving move: keep them importing the same llm/MODEL (still the CF default) so the APP is byte-identical, BUT if cheaply parameterizable, add an optional ai param to orchestrate()/loadAndRunOrch() defaulting to llm so an external caller can override — only if it does NOT change the atoms.ts call sites. If parameterizing orchestrate()/loadAndRunOrch() ripples into atoms.ts, DEFER it (note as next step) and leave them on the llm default. State clearly in behaviorDrift which path you took.
  • Do NOT push Effect into the recipes; do NOT add a 6th orch primitive; do NOT change leaf's signature. captureFetch is the per-turn factory from step 3 — wire it through the turn() closure over config.ai.
App behavior MUST be byte-for-byte identical (same model, same prompt, same recovery, same trace). The DI is in WHO constructs the gens, not WHAT they do. ${CHECK} green; verify atoms.ts + chat.tsx + orch-run.ts + orch-load.ts still typecheck against the re-exported turn/abortTurn/llm/MODEL.`,
  },
  {
    key: 'sdk-public-api',
    title: 'sdk-public-api',
    kind: 'behavior-preserving',
    spec: `BEHAVIOR-PRESERVING (finalize the public surface; no runtime path change). Now that createAgent exists, complete src/sdk.ts as the canonical external entrypoint:
  • Add to src/sdk.ts: value export createAgent; type exports AxAgentConfig, AxAgentSDK; (TurnResult, abortTurn, the prims + recipes + BudgetExhaustedError + tools + AxFunction are already there from step 2).
  • Re-export the SESSION-BOUNDARY entries that ARE intended public API: \`orchestrate\` + type OrchestrateResult from src/orch-run.ts, and \`loadAndRunOrch\` + types OrchPrims/OrchLoadCtx/OrchLoadResult + const ORCH_SCRIPTS_DIR from src/orch-load.ts. These are Effect-returning session entries (caller does \`orchestrate(parent,id,msg)()\`); JSDoc them as "session-boundary Effect entries". (Re-export loadAndRunOrch/orch-load surface ONLY because it is part of the intended public API per the dyn-load feature — it is.)
  • Re-export AxMemory (value) and the AxAIService type from @ax-llm/ax so a caller types their config + builds session memory without a direct ax import. Optionally add a thin \`export type SessionHandle = { id: string; mem: AxMemory }\` + \`export const createSession = (id: string): SessionHandle => ({ id, mem: new AxMemory() })\` ONLY if the step-6 example consumes it; do NOT wire the module sessionsRT map into the public surface (it stays app-internal).
  • Confirm the surface is COHERENT and leaks NO internal-only symbol: grep sdk.ts re-exports and verify NONE of liveLogger, captureFetch/makeCaptureFetch, the metrics, sessionsRT, readUsage, sumUsage, BASE_PROMPT escape. (onEvent/readUsageOf/limits are app/orch-internal — re-export ONLY if the example needs them; otherwise leave internal.)
  • Verify the APP path is unchanged: atoms.ts still imports turn/abortTurn (now defaultAgent.*, same names) and orchestrate/loadAndRunOrch from their current homes — it MAY keep importing from agent.ts/orch-run.ts/orch-load.ts OR be migrated to sdk.ts, your choice, but behavior identical. Run ${CHECK}; run ${LINT} and CONFIRM any new red is ONLY pre-existing documented dead exports — every sdk.ts export must be consumable (by the app and/or the step-6 example).
No logic changes here — this is the export-surface seal. ${CHECK} green.`,
  },
  {
    key: 'usage-example',
    title: 'usage-example',
    kind: 'DI',
    spec: `DI-demonstrating + the SDK SMOKE GATE. Create examples/sdk-usage.ts (no examples/ dir exists yet — create it): a RUNNABLE headless script (\`${SMOKE}\`) proving an external caller drives the core with NO Cloudflare env. It must:
  • Build an AxAIService WITHOUT CF env. Preferred: a tiny stub/fake ai that satisfies AxAIService enough for a single forward (read ../ax/src for the minimal AxAIService shape — the chat()/embed()/getName surface — and stub a deterministic reply, e.g. echo the message). A no-network stub makes the smoke deterministic and is the POINT (the injection seam). Mark any stub shortcut 'ponytail: example stub ai — Upgrade: point at a real injected provider in CI'.
  • \`const sdk = createAgent({ ai: stubAi, model: 'stub/echo', maxSteps: 4, tokenBudget: 50_000, tools: [] })\` — explicitly pass a non-CF model + empty tools to PROVE config injection.
  • Run ONE turn: build an AxMemory (or createSession), then \`turn(mem, parent, id)(message)\` returns an EFFECT — run it at the boundary with the SAME runtime the app uses (otel.ts appRuntime) or a minimal Effect.runPromise with the OtelTracerProvider layer the turn() span needs. Follow scout's EXACT turn() return shape — it is Effect-returning, NOT an AsyncGenerator, so there is nothing to for-await; collect emitted node Activities via \`setActivitySink\` (src/activity.ts) installed before the run and cleared after (mirror how atoms.ts installs its per-turn sink). If wiring the full Effect runtime/OTel layer in a standalone script is heavy, it is ACCEPTABLE to drive turn() via the exported appRuntime — note the dependency.
  • Assert (plain ax2 style: \`let failed=0; const assert=(c,m)=>{ if(!c){ console.error('FAIL: '+m); failed++ } }; ... process.exit(failed?1:0)\`) that: a reply string came back, at least one Activity was observed via the installed sink, and NO CF env was needed (the stubAi is constructed without reading CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID).
  • OPTIONAL second assertion ONLY IF step 4 parameterized orchestrate()/loadAndRunOrch() with an injectable ai: drive a small orchestrate() over the stub ai and assert the node tree shape (root + >=1 child Activity). If step 4 left them on the llm default (CF-hardwired), SKIP this and NOTE "parameterize orchestrate()/loadAndRunOrch() for injected ai" as the next follow-up rather than forcing it.
  • This file CONSUMES the sdk.ts public surface (so its exports are no longer dead) and is the regression smoke for the whole extraction. Note a package.json "sdk:smoke": "${SMOKE}" suggestion in notes; do not block on adding it. ${CHECK} green AND \`${SMOKE}\` exits 0.`,
  },
]

const results = []
for (let i = 0; i < STEPS.length; i++) {
  const f = STEPS[i]
  if (budget.total && budget.remaining() < 80000) {
    log(`budget low (${Math.round(budget.remaining() / 1000)}k) — stopping before ${f.key}`)
    break
  }
  phase(f.title)

  // -- implement (edits main, self-heals to green, commits) -----------------
  let impl = await agent(
    `Implement SDK-extraction step "${f.key}" (declared kind: ${f.kind}) in the ax2 main working tree. Earlier steps in this run are already committed — build on them.\n\nSTEP SPEC:\n${f.spec}\n\nRULES: ${CHECK} (tsc --noEmit) MUST end green (modulo pre-existing user dead exports). Self-heal: if check is red, fix and re-run, up to ${MAX_HEAL} attempts. For any deliberate shortcut add a 'ponytail:' marker WITH an 'Upgrade:' trigger line. PROVE behavior preservation: if this step is behavior-preserving, the app path must be unchanged (set behaviorDrift="none"); if DI, the app must still behave identically via defaults (state exactly why in behaviorDrift). When green, COMMIT this step alone with --no-verify and a conventional message ('feat(sdk): ${f.key} ...' or 'refactor(sdk): ...'). Report classification (behavior-preserving|DI), commit sha, diff, check tail, new ponytails, behaviorDrift.\n\nSCOUTED CONTRACTS (ground truth — copy signatures, don't re-derive; note runTurn/TurnEvent are ABSENT):\n${CONTRACTS}\n\n${CORE_SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
  )

  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++
    log(`${f.key}: heal ${heal} (check red)`)
    impl = await agent(
      `Step "${f.key}" left ${CHECK} RED. Diagnose + fix in the working tree, re-run until green (modulo pre-existing user dead exports), then commit with --no-verify.\n\nFAILING:\n${impl.checkOutput}\n\nReturn the structured result (keep classification + behaviorDrift accurate).\n\n${CORE_SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
  }

  // -- adversarial review — 2 lenses, PARALLEL (read-only, safe to fan out) --
  const LENSES = [
    {
      k: 'di-soundness',
      focus: `DI SOUNDNESS + BEHAVIOR PRESERVATION: did "${f.key}" actually achieve the injection it claims WITHOUT changing app behavior? Specifically — is the CF-Kimi singleton truly moved into createAgent (not just aliased while turn() still closes over the module global)? Is lastFinishReason truly per-turn (no remaining module latch that a second injected agent would share)? Does turn() STAY Effect-returning (the workflow must NOT have invented a runTurn/AsyncGenerator)? Does the app's default path (defaultAgent / re-exported turn) produce the IDENTICAL model, prompt, budget recovery, and trace shape as before? Is there any hidden \`any\` or unsound cast at the injection seam? Could an external caller pass a non-CF AxAIService and have it actually be used (or is CF still hardwired in turn() via captureFetch URL, or in orch-run.ts / orch-load.ts which BOTH import the bare llm)? Cite file:line.`,
    },
    {
      k: 'surface-orthogonality',
      focus: `PUBLIC-SURFACE ORTHOGONALITY + DEBT: is src/sdk.ts a clean single entrypoint that leaks NO internal-only symbol (liveLogger, captureFetch/makeCaptureFetch, the metrics, sessionsRT, readUsage/sumUsage, the module llm)? Does it correctly re-export BudgetExhaustedError FROM orch.ts (not redefined) and the intended public session entries orchestrate + loadAndRunOrch? Did this step keep CORE at exactly the 5 orch primitives (no recipe smuggled into orch.ts, no 6th prim, no Effect pushed into recipes)? Did it AVOID inventing runTurn/TurnEvent/a per-turn buffer (those do NOT exist — the live path is the global emitActivity sink + setActivitySink)? Are all NEW exports consumed (by app, orch-run, orch-load, or the usage example) — no NEW dead export beyond the documented pre-existing ones? Any UNMARKED any/ponytail, or a ponytail missing its Upgrade trigger? Did it add speculative ceremony (config validators, provider adapters, unused options) the ethos forbids? Cite file:line.`,
    },
  ]
  const reviews = (await parallel(LENSES.map((l) => () =>
    agent(
      `Adversarially review the just-committed "${f.key}" step (read the touched files + the diff; default skeptical). LENS — ${l.focus}\n\nDECLARED CLASSIFICATION: ${impl ? impl.classification : '(impl failed)'}  | BEHAVIOR DRIFT CLAIMED: ${impl ? impl.behaviorDrift : '(n/a)'}\n\nDIFF:\n${impl ? impl.diff : '(impl failed)'}\n\n${CORE_SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' },
    )
  ))).filter(Boolean)
  let blockers = reviews.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
  log(`${f.key}: ${reviews.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)} findings, ${blockers.length} blockers`)

  // -- harden blockers (fix -> re-verify both lenses) -----------------------
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++
    log(`${f.key}: harden ${hr} (${blockers.length} blockers)`)
    impl = await agent(
      `Review found BLOCKERS in "${f.key}". Fix each in the working tree, keep CORE at 5 primitives + APP behavior identical (defaults preserved) + turn() Effect-returning, re-run ${CHECK} to green, then AMEND the step commit (--no-verify).\n\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\nReturn the structured result (classification + behaviorDrift must stay honest).\n\n${CORE_SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' },
    )
    const rr = (await parallel(LENSES.map((l) => () =>
      agent(
        `Re-review "${f.key}" for your lens: confirm the blockers are closed and no new ones opened. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : ''}\n\n${CORE_SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' },
      )
    ))).filter(Boolean)
    blockers = rr.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
  }

  results.push({
    step: f.key,
    declaredKind: f.kind,
    classification: impl ? impl.classification : 'failed',
    status: impl ? impl.status : 'failed',
    commit: impl ? impl.commitSha : null,
    behaviorDrift: impl ? impl.behaviorDrift : 'n/a',
    openBlockers: blockers,
    newPonytails: impl ? impl.newPonytails : [],
    healUsed: heal,
    files: impl ? impl.filesChanged : [],
  })
}

// ===========================================================================
// REPORT — synthesis: the classification matrix + actionable external-use note.
// ===========================================================================
phase('Report')
const report = await agent(
  `Write the final SDK-extraction report for the ax2 author (blunt, terse, full technical substance). The core was extracted into an externally-usable SDK step-by-step on main, each committed.\n\nProduce the structured fields:\n- headline: how many of the 5 steps landed green; anything red/partial — say it plainly, do not oversell.\n- matrix: ONE ROW PER STEP — step, classification (behavior-preserving|DI — and FLAG any mismatch between declared kind and what actually happened), status, commit sha, one-line whatChanged.\n- externalCallerCan: concrete capabilities a foreign caller now has (inject their own AxAIService? run turn() with NO Cloudflare env? swap tools/model/maxSteps at createAgent time? compose the orch recipes + run orchestrate()/loadAndRunOrch() from sdk.ts?). Only list what is ACTUALLY true given the results — if step 4 left orch-run.ts / orch-load.ts CF-hardwired (both import the bare llm today), say the orchestration capability is partial.\n- residualRisk: new ponytails (with Upgrade triggers), the per-turn-context vs remaining-global-state status of the finish-reason latch, any unsound cast, the known pre-existing dead exports (NOT ours), and EXPLICITLY whether orch-run.ts AND orch-load.ts still hardwire the llm singleton.\n- nextStep: the single most valuable follow-up (likely: parameterize orchestrate()/loadAndRunOrch() for injected ai so the SDK's orchestration path is also provider-agnostic; or add the sdk:smoke npm script + CI gate; or a real-provider example).\n- narrative: the full markdown report tying it together.\n\nRESULTS (JSON):\n${JSON.stringify(results, null, 1)}\n\nSCOUTED SURFACE (for grounding):\n${CONTRACTS}`,
  { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, agentType: 'general-purpose' },
)

return { steps: results, report }
