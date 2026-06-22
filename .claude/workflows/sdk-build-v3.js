export const meta = {
  name: 'sdk-build-v3',
  description: 'Turn ax2 into a PROPER importable SDK (claude_code QueryEngine model): run the core/tui split, then build the createAgent->Agent handle over a flat serializable TurnEvent union + normalized TurnResult, seal every provider-wire/Effect/ax-internal/global-sink leak, expose ONE src/core/sdk.ts barrel guarded by a package.json exports map + a cross-core-import analyze rule, and prove it with a 10-line barrel-only consumer that imports no Effect/OTel/AxMemory. Sequential dependent steps on ONE shared branch, each gated on bun run check; the SDK smoke (examples) is the closing gate.',
  phases: [
    { title: 'Split', detail: 'run core-tui-split-v2.js to completion (folders + runTurn generator + global-sink kill) — the prerequisite' },
    { title: 'Seal', detail: 'delete provider-wire/ax-internal leaks; normalize TurnResult; refine the flat TurnEvent union + Activity->TurnEvent mapping' },
    { title: 'Surface', detail: 'createAgent->Agent handle + AgentOptions/TurnOptions; curated src/core/sdk.ts barrel; exports map + cross-core analyze rule; move defaultAgent/AX2_MOCK to app layer' },
    { title: 'Dogfood', detail: 'repoint atoms.ts/chat.tsx onto the Agent handle; rewrite examples to the 10-line barrel consumer; final seal review' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'

// Shared contract pasted into every step prompt so a step never re-derives the design.
const CONTRACT = `SDK-GRADE TARGET (claude_code QueryEngine model — single-process, ONE in-flight turn per session via busyAtom; NO codex submit/next_event ceremony):

PUBLIC SURFACE (the ONLY importable module = src/core/sdk.ts barrel, zero logic, <300 lines):
  export function createAgent(options: AgentOptions): Agent
  interface Agent {
    runTurn(sessionId: string, message: string, opts?: TurnOptions): AsyncGenerator<TurnEvent, void, void> // plain async-gen; Effect runs INSIDE on appRuntime; final yield ALWAYS {type:'reply'} even on error/abort
    abort(sessionId: string): boolean        // wraps today's abortTurn (agent.ts:237)
    closeSession(sessionId: string): boolean // wraps sessions.ts deleteSession
    info(): AgentInfo                         // read-only {model,maxSteps,tokenBudget,toolNames,systemPromptChars,version,axVersion}
  }
  interface AgentOptions { ai: AxAIService; model: string; maxSteps?: number; tokenBudget?: number;
    tools?: 'default'|'base'|readonly AxFunction[]; systemPromptAppend?: string; loadProjectDoc?: boolean;
    telemetry?: 'off'|'app';  // DEFAULT 'off' => SDK installs its OWN no-op OTel internally; consumer needs ZERO OTel wiring
    onLog?: (line: LogLine) => void }         // clean serializable line, NOT ax's AxLoggerFunction
  interface TurnOptions { signal?: AbortSignal; model?: string; maxSteps?: number; thinking?: 'minimal'|'low'|'medium'|'high'|'highest'|'none' }
  type LogLine = { level:'debug'|'info'|'warn'|'error'; msg:string; sessionId?:string; fields?:Record<string,string|number|boolean> }

FLAT SERIALIZABLE TurnEvent (promote each internal Activity variant to a top-level discriminant — do NOT wrap in {kind:'activity'}):
  type TurnEvent =
    | { type:'reply_delta'; text:string }
    | { type:'thinking_delta'; text:string }
    | { type:'message'; text:string }
    | { type:'tool_call'; id:string; name:string; args:string; nodeId?:string }
    | { type:'tool_result'; id:string; result:string; isError:boolean; nodeId?:string }
    | { type:'node'; nodeId:string; event:'start'|'delta'|'done'|'error'; parentId?:string; detail?:string; tokens?:number }
    | { type:'reply'; result:TurnResult }   // TERMINAL: yielded EXACTLY ONCE, ALWAYS last
  MAP from activity.ts Activity kinds at the runTurn yield boundary: text->message, tool->tool_call, result->tool_result, node->node, replyDelta->reply_delta, thinkingDelta->thinking_delta. Internal Activity union STAYS internal. Every field string|number|boolean|undefined — NO AxMemory/AxSpan/Effect.

NORMALIZED TurnResult (NO provider-wire leakage):
  interface TurnResult { reply:string; stopReason:StopReason; usage:TokenUsage; aborted:boolean; error?:TurnError }
  type StopReason = 'stop'|'max_steps'|'aborted'|'error'
  interface TokenUsage { total?:number; reasoning?:number; input?:number; output?:number }
  interface TurnError { kind:'aborted'|'budget_exhausted'|'provider'|'unknown'; message:string }  // one clean line, not a Cause dump

HIDE/SEAL LIST (grep MUST be zero after, except the one allowed internal usage ponytail):
  1. DELETE fetch.clone() finish_reason skim: agent.ts makeCaptureFetch/TurnContext (~109-137), passed ~330, read ~389,445. Its only public output was finishReason (now dropped).
  2. KEEP internal: (gen as any).getUsage?.() readUsage (~164-168) — feeds usage.* on TurnResult; NEVER re-exported; carries a ponytail Upgrade: line (ax public usage API).
  3. DELETE (gen as any).getChatLog?.() readResponseId/remoteId (~181-185, used ~388) — response id is provider-wire, not public.
  4. turn() Effect<TurnResult,ChatError,OtelTracerProvider> becomes INTERNAL impl that runTurn drives on appRuntime; Effect/ChatError/OtelTracerProvider NEVER cross src/core/sdk.ts.
  5. Global activity sink (activity.ts sinkState/setActivitySink/emitActivity ~29-43) DELETED by the Split phase; activity.ts keeps ONLY 'export type Activity'. grep emitActivity|setActivitySink => 0.
  6. defaultAgent + AX2_MOCK env branch (agent.ts ~478-485) = APP wiring, move to src/tui (or a src/app entry), NOT the SDK; SDK consumers inject their own AxAIService.
  7. DELETE today's leaky src/sdk.ts (re-exports NodeOpts/emit/AxMemory/BASE_TOOLS/orch prims). Replace with src/core/sdk.ts exporting ONLY createAgent + the public types + AxAIService/AxFunction type re-exports.
  8. package.json "exports": { ".": "./src/core/sdk.ts", "./package.json": "./package.json" } — blocks deep imports.

EVERY step: run ${CHECK} until green, commit on the current branch. Preserve main-only telemetry (reasoning tokens, timing span events, prompt-size annotations, orch node spans), the rlm_workflow rename, the structural one-level recursion guard, strict tsconfig, the conditioned file-size budget (barrel<=300, impl<=500, nest<=8).`

phase('Split')

const split = await agent(
  `Run the ENTIRE core/tui split by executing the plan in /Users/umang/hub/ax2/.claude/workflows/core-tui-split-v2.js MANUALLY as its author intended (you cannot nest a workflow; do the steps yourself with full tools). Read that file first for the exact step prompts + the Phase-0 reground. Deliver: src/core/ (headless engine) + src/tui/ (UI), src/core/run.ts with runTurn(sessionId,message): AsyncGenerator<TurnEvent>, the GLOBAL SINK DELETED (per-turn closure emit + makeLiveLogger), the final-reply-once invariant (the atoms.ts catchCause '⚠' mapping moved into runTurn), and the 3 producers (orch.emit / runtime onEvent / rlm-workflow) rerouted to the per-turn emit. otel.ts STAYS at src/ root. ${CONTRACT}
This phase lands the FOLDERS + a working (possibly raw {kind:'activity'} ) runTurn; the Seal phase refines the event/result shape next. Run ${CHECK} green; then ${LINT} green; commit. Return what moved + the runTurn signature you landed + confirmation grep emitActivity|setActivitySink is zero.`,
  { label: 'split:core-tui', phase: 'Split', effort: 'high' }
)

phase('Seal')

const seal = await agent(
  `On the post-Split tree (cwd /Users/umang/hub/ax2). Split result: ${split}
${CONTRACT}
DO, in order, gating each on ${CHECK}:
(A) DELETE the fetch.clone finish_reason skim (hide #1) and the getChatLog/remoteId probe (hide #3). KEEP readUsage internal (hide #2) with a ponytail Upgrade: line. Verify token usage still populates.
(B) Normalize TurnResult in core/agent.ts to {reply,stopReason,usage,aborted,error?} with the StopReason/TokenUsage/TurnError types. Map the old budget:true -> stopReason 'max_steps', abort -> 'aborted', ChatError -> error{kind,message} (one clean line via Cause.squash, NOT a dump).
(C) Refine the TurnEvent union in core/run.ts to the FLAT top-level variants; add the Activity->TurnEvent mapping at the yield boundary (text->message, tool->tool_call, result->tool_result, node->node, replyDelta->reply_delta, thinkingDelta->thinking_delta). The terminal 'reply' carries the normalized TurnResult, yielded exactly once, always last (even on error/abort).
Commit. Return the final TurnEvent + TurnResult shapes you landed and a grep proof that res.clone / getChatLog are gone.`,
  { label: 'seal:leaks-types', phase: 'Seal', effort: 'high' }
)

phase('Surface')

const surface = await agent(
  `On the post-Seal tree. Seal result: ${seal}
${CONTRACT}
DO, gating each on ${CHECK}:
(A) Build the Agent handle: createAgent(options: AgentOptions): Agent in core/agent.ts (or a thin core/handle.ts). It OWNS per-session state — a sessionId->{mem,rootSpan} map (absorb sessions.ts logic), lazily creating AxMemory + the root ExternalSpan on first runTurn for a sessionId. runTurn(sessionId,message,opts?) resolves/creates that state, applies TurnOptions (per-turn model/maxSteps/signal/thinking), and drives the internal turn() on appRuntime, yielding TurnEvents. abort/closeSession/info as specified. telemetry:'off' (default) installs an internal no-op OTel provider so runTurn needs no consumer OTel; 'app' reuses otel.ts. tools:'default'|'base'|AxFunction[] resolves the named default (no BASE_TOOLS import for consumers).
(B) Create src/core/sdk.ts barrel exporting ONLY createAgent + Agent/AgentInfo/AgentOptions/TurnOptions/TurnEvent/TurnResult/StopReason/TokenUsage/TurnError/LogLine + 'export type { AxAIService, AxFunction } from "@ax-llm/ax"'. Zero logic, <300 lines (the conditioned barrel budget). DELETE the old src/sdk.ts (or src/core/sdk.ts if Split moved it) — strip every NodeOpts/emit/AxMemory/BASE_TOOLS/orch-prim re-export (hide #7).
(C) Move defaultAgent + the AX2_MOCK env branch OUT of the SDK into the app layer (src/tui or a small src/app entry) — the SDK has no env coupling (hide #6).
(D) Add the package.json "exports" map (barrel only, hide #8). Add a design-check.ts analyze rule: any import of a src/core/* module that is NOT src/core/sdk.ts from OUTSIDE src/core/ is a finding ('cross-core deep import — go through the sdk barrel'). Keep it lean; the in-repo tui consumer must obey it too (it imports the barrel).
Commit. Return the barrel's exact export list + the new analyze rule + confirmation ${CHECK} green.`,
  { label: 'surface:handle-barrel', phase: 'Surface', effort: 'high' }
)

phase('Dogfood')

const dogfood = await agent(
  `On the post-Surface tree. Surface result: ${surface}
${CONTRACT}
DO, gating each on ${CHECK}:
(A) Repoint src/tui/atoms.ts (and chat.tsx where needed) to consume the Agent handle: build the agent once via createAgent({ ai: <CF llm or AX2_MOCK mock>, model, telemetry:'app' }) in the app layer, and drive sendAtom via 'for await (const ev of agent.runTurn(sessionId, message, { signal }))', reducing TurnEvents into appState. Remove atoms.ts's direct turn()/sessionsRT/installSink usage — it now goes through the handle + the generator (dogfood the boundary). Keep the velocity orch tree rendering (node events -> OrchTree).
(B) Rewrite examples/sdk-usage.ts to the 10-line barrel-ONLY consumer: import { createAgent } from the barrel + ai from @ax-llm/ax, createAgent, for-await runTurn, switch on ev.type, print reply. NO import of Effect, @opentelemetry/*, AxMemory, activity.ts, or any src/core/* non-barrel module. Make 'bun run sdk:smoke' run it under AX2_MOCK (or a mock AxAIService) with zero network. This is the SDK regression gate.
(C) FINAL SEAL REVIEW: grep the tree and assert ZERO of: res.clone, getChatLog, setActivitySink, emitActivity, and that getUsage appears only behind its internal ponytail. Assert the 10-line example imports nothing but the barrel + @ax-llm/ax. Run ${LINT} green and 'bun run sdk:smoke' green. Update AGENTS.md Files/Run sections to the core/tui + SDK reality.
Commit. Return a structured final report.`,
  { label: 'dogfood:repoint-prove', phase: 'Dogfood', effort: 'high', schema: {
    type: 'object', additionalProperties: false,
    required: ['lintGreen', 'smokeGreen', 'sealsZero', 'exampleBarrelOnly', 'commits', 'remaining'],
    properties: {
      lintGreen: { type: 'boolean' },
      smokeGreen: { type: 'boolean' },
      sealsZero: { type: 'boolean', description: 'res.clone/getChatLog/setActivitySink/emitActivity all grep-zero' },
      exampleBarrelOnly: { type: 'boolean' },
      commits: { type: 'array', items: { type: 'string' } },
      remaining: { type: 'array', items: { type: 'string' } },
    },
  }}
)

return { split, seal, surface, dogfood }
