// RLM NODE — a node-kind callable via the rlm() prim in workflow({script}). `runRlm` is
// the context-mining node: a REAL single-level @ax-llm/ax RLM (the distiller → executor →
// responder loop over runtime-held context), bridged into ax2's live node-event tree as one
// prim among agent/parallel/pipeline/judge, so it renders NESTED under the chat.turn span.
// It is NOT a standalone tool and NOT invoked via a fixed strategy-menu: the workflow-prims.ts
// rlm() binding invokes it directly, on the SAME event bus / budget / trace.
//
// WHY RLM (vs the fan-out strategies): a fan-out leaf pulls the whole context into the
// LLM prompt. An RLM instead loads the context into the code runtime (AxJSRuntime) and
// the executor writes JS (slice/grep/llmQuery) to mine it — so a HUGE context (a long
// file, a pasted log, a whole module concatenated) never blows the prompt window. This
// is the right tool for "find X buried somewhere in this big blob".
//
// THE SAFETY MODEL:
//   1. ONE LEVEL: this prim is invoked directly within workflow({script}) via rlm(context, query) —
//      a prim binding, not an AxFunction on the chat gen. The agent()/rlm() prim nodes carry only
//      BASE_TOOLS (file/shell), so a node cannot re-orchestrate. The
//      RLM's own executor runs JS in the AxJSRuntime sandbox (TIMING permission only —
//      no network/fs/process); it has NO ax2 file/shell tools and cannot re-orchestrate.
//   2. BUDGET ceiling (ADVISORY/soft): the RLM runs under its OWN allocate(SOFT, HARD);
//      usage is charged PER EXECUTOR TURN off actorTurnCallback.usage (streamed live), not
//      once-after. Crossing the SOFT line only nudges — the RLM answer is ALWAYS returned.
//      Only the HARD runaway ceiling throws BudgetExhaustedError → a partial. maxSteps caps turns.
//   3. maxSteps cap: the RLM actor loop is bounded by maxSteps (executor turns).
//   4. abortSignal: extra.abortSignal threads into forward() so a cancelled turn
//      cancels the RLM run.
//
// CONTEXT/TRACE: like the other workflow prims, the rlm() handler runs Promise-native INSIDE forward(),
// which turn() runs inside otelContext.with(traceContext). So onEvent()'s active-span
// read resolves to the live chat.turn span and the RLM's start/delta/done events nest
// in the SAME OrchTree. The actorTurnCallback / onContextEvent callbacks are bridged
// into NodeEvents with stage labels (distiller / executor / responder).
import {
  agent as axAgent,
  type AxAgentActorTurnCallbackArgs,
  type AxAgentContextEvent,
  type AxAIService,
  AxJSRuntime,
  AxJSRuntimePermission,
  AxMemory,
} from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { limits } from "./runtime.ts"
import { allocate } from "./orch.ts"
import { type EmitSink, withTimeout } from "./orch-recipes.ts"
import { setNodeSpanTracer } from "./orch-spans.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "../otel.ts"

// Per-RLM SOFT token ceiling (advisory nudge line). An RLM explores a big context across
// many executor turns + sub-LM queries, so ~2M is a sane "this run is getting big" marker.
// Charged PER EXECUTOR TURN off actorTurnCallback.usage (streamed live) — crossing it only
// nudges; the RLM answer is ALWAYS returned (the soft-budget root-cause fix).
const RLM_TOKEN_BUDGET = Number(process.env.AX2_RLM_TOKEN_BUDGET ?? 2_000_000)

// HARD runaway backstop — the ONLY ceiling that aborts (BudgetExhaustedError). Very high
// (~20M) so a single genuine RLM run never trips it; it only catches a true runaway loop.
const RLM_TOKEN_HARD = Number(process.env.AX2_RLM_TOKEN_HARD ?? 20_000_000)

// Wall-clock TIMEOUT for a whole RLM run. The per-NODE LEAF_TIMEOUT_MS (120s, orch-resilience)
// is the wrong backstop for an RLM: it explores a big blob across MANY executor turns +
// sub-LM queries (long-horizon), so a 120s cap would GUILLOTINE a legitimate run. run_rlm
// never goes through runNode/resilientNode (it forwards an axAgent directly), so that 120s
// never actually applied — but we add a MUCH larger, RLM-specific ceiling here as the real
// backstop against a hung run, while still honoring the turn's abortSignal for a true cancel
// (withTimeout forks a child signal off `signal`, so cancel + timeout both abort the forward).
// AX2_RLM_TIMEOUT_MS overrides; default 600s. Clamped to a sane floor.
const RLM_TIMEOUT_MS = (() => {
  const v = Number(process.env.AX2_RLM_TIMEOUT_MS ?? 600_000)
  return Number.isFinite(v) && v > 0 ? Math.max(10_000, Math.floor(v)) : 600_000
})()

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)

// Steer BOTH actor stages (distiller + executor) away from CommonJS AND away from giving up via
// askClarification / a globalThis scan. The AxJSRuntime worker is a least-privilege ESM sandbox
// (no require/import/Node modules — by design); an RLM mines an in-memory blob, so it never needs
// them. Kimi defaults to require() out of habit, which throws "require is not defined" and loops
// the run to a timeout. This text is PREPENDED as the actor's base description (signatureBuilders.
// ts:268-281 — our executorDescription/contextDescription is the `baseDefinition` axBuildExecutor/
// DistillerDefinition wraps; ax's accurate per-stage template still follows it). So it MUST NOT
// contradict that template: the blob lands in DIFFERENT variables per stage — the distiller reads
// the raw `context` global, the EXECUTOR reads `inputs.executorRequest` + `inputs.distilledContext`
// (raw `context` is NOT in the executor scope; see rlm/executor.md). An earlier version named
// `context` for both, so the executor wrote `context.slice(...)` → "context is not defined", looped
// on policy errors, and lost the buried fact. The rule now defers variable NAMING to ax's per-stage
// template and only adds the genuinely-additive steers (no require, no askClarification, mine it).
const SANDBOX_RULE =
  "The code runtime is a SANDBOXED ES-MODULE environment: NO require(), NO import, NO Node modules (no fs, path, process, child_process, http). NEVER call require or import — they are undefined and throw. The full source/document you must mine is ALREADY loaded into the runtime as a string input for this stage (the distiller reads the `context` variable; the executor reads `inputs.executorRequest` and `inputs.distilledContext` — follow the per-stage instructions below for the exact names; raw `context` is not in the executor scope). It is NOT missing — read the provided input string DIRECTLY and slice/regex it. NEVER scan `Object.keys(globalThis)` for it, and NEVER call askClarification or ask the user to provide the source — the source is already loaded; mine it. Use ONLY plain JavaScript (String/Array/Object methods, regex, JSON, Math, console.log) plus the injected primitives `llmQuery` (sub-LM over a narrowed slice) and `final` (to answer). Write ONE small observable step per turn — a single console.log to inspect, or final(...) to finish."

// DISTILLER stage steer — the lossy step. The distiller decides what slice of the raw `context`
// to forward to the executor as `distilledContext`. For a LOCATE/FIND/NAME query it must NOT
// summarize the answer away: a single buried line (e.g. the one function that registers a route)
// is the answer, so paraphrasing the blob can drop it. So instruct the distiller to RETRIEVE — grep
// the raw `context` for terms from the query and forward the MATCHING LINES VERBATIM (with a little
// surrounding text), never a lossy summary. This is the root-cause fix for the intermittent
// "buried fact lost in distillation" failure. Prepended ahead of the shared SANDBOX_RULE.
const DISTILLER_RULE =
  "You are the DISTILLER: select evidence from the raw `context` for a downstream executor — do NOT answer. CRITICAL for locate/find/name/which questions: the answer is often ONE buried line, so do NOT paraphrase or summarize the context away. Instead RETRIEVE: derive search terms from the query (and obvious synonyms — e.g. for a '/auth route' question, search for 'auth', 'route', 'register', 'app.post', 'app.get'), `context.split('\\n').filter(l => /term/i.test(l))` to grep the raw context, and forward the MATCHING LINES VERBATIM (plus a few neighbors) as the distilled evidence. Preserve exact identifiers/code — never lose a candidate line to a summary. " +
  SANDBOX_RULE

// EXECUTOR stage steer — the other half of the intermittent "buried fact lost" failure. The
// distiller→executor handoff occasionally lands `inputs.distilledContext` as undefined/empty (an
// ax-internal flake). When that happens the executor must NOT give up or scan globalThis: the raw
// task still arrives on `inputs.executorRequest` (and the distiller's matching lines are usually
// inside it), so read THAT directly, grep it for the query terms, and final(...) the verbatim hit.
// Probe BOTH fields on turn 1 (`console.log(typeof inputs.distilledContext, typeof inputs.executorRequest)`)
// and mine whichever is non-empty — never conclude "not found" while a non-empty input string exists.
const EXECUTOR_RULE =
  "You are the EXECUTOR. Your inputs are `inputs.executorRequest` (the task + the distiller's evidence) and `inputs.distilledContext` (the distilled slice — but it MAY be undefined/empty if the distiller handoff dropped it). On your FIRST turn, console.log the type+length of BOTH so you know which holds the source. If `inputs.distilledContext` is undefined or empty, DO NOT conclude 'not found' and DO NOT scan globalThis — the source/evidence is in `inputs.executorRequest`: grep IT (`String(inputs.executorRequest).split('\\n').filter(l => /term/i.test(l))`) for the query terms and answer from the matching line. Only call final(...) once you have read a non-empty input string and located the literal answer in it. " +
  SANDBOX_RULE

// Build a REAL single-level RLM and forward it over { context, query }, bridging the
// actor/context callbacks into the node-event tree. Returns the responder's answer +
// evidence. rootId nests every RLM node under the live chat.turn span. Exported so the
// live harness drives the exact same path the model calls.
export const runRlm = async (
  context: string,
  query: string,
  ai: AxAIService,
  rootId: string,
  signal: AbortSignal,
  // PER-TURN node-event sink (the per-turn activity closure, via makeOnEvent). Threaded from the
  // workflow prim, replacing the deleted module-global onEvent. Defaults to a no-op so a
  // standalone live-harness call (no turn boundary) still runs — it just emits no live tree rows.
  onEvent: EmitSink = () => {},
): Promise<{ answer: string; evidence: string[]; turns: number; callbacks: number }> => {
  const budget = allocate(RLM_TOKEN_BUDGET, RLM_TOKEN_HARD)
  // SPAN GRANULARITY (telemetry 2b): the RLM's internal loop (distiller → executor turn 1..N
  // → responder) was an opaque single span. Thread our exporting tracer + the ambient trace
  // context INTO forward() so ax emits a gen_ai CHILD SPAN per internal stage nested under
  // run_rlm — AND wire the node-span minter so each actorTurnCallback NodeEvent also mints a
  // child span. Net: the trace mirrors the live tree instead of one black box. The live
  // harness drives runRlm() directly (no turn()), so we set the minter HERE too.
  const tracer = otelTrace.getTracer(SERVICE_NAME, SERVICE_VERSION)
  const traceContext = otelContext.active()
  setNodeSpanTracer(tracer)
  // Bridge counters surfaced to the caller so the smoke can assert callbacks fired.
  let turns = 0
  let callbacks = 0
  // a.usage is the RLM's CUMULATIVE usage array; we charge the per-turn DELTA so the soft
  // budget streams live (not once-after). Track the highest total already charged.
  let chargedTokens = 0
  type Tok = { totalTokens?: number; promptTokens?: number; completionTokens?: number }
  const tokensOf = (t: Tok | undefined): number =>
    t === undefined ? 0 : typeof t.totalTokens === "number" ? t.totalTokens : (t.promptTokens ?? 0) + (t.completionTokens ?? 0)
  // a.usage is an AxProgramUsage[] (cumulative) — read the last element's tokens.
  const tokensFromTurn = (usage: ReadonlyArray<{ tokens?: Tok }> | undefined): number => tokensOf(usage?.[usage.length - 1]?.tokens)
  // getUsage() is AxProgramUsage[] | AxAgentUsage ({ actor, responder }) — SUM every
  // entry's tokens so the final reconcile captures the responder stage too.
  const tokensFromGetUsage = (u: unknown): number => {
    const entries: Array<{ tokens?: Tok }> = Array.isArray(u)
      ? (u as Array<{ tokens?: Tok }>)
      : [...((u as { actor?: Array<{ tokens?: Tok }> })?.actor ?? []), ...((u as { responder?: Array<{ tokens?: Tok }> })?.responder ?? [])]
    return entries.reduce((sum, e) => sum + tokensOf(e?.tokens), 0)
  }

  // The RLM, built EXACTLY per the proven standalone pattern (../ax/src/examples/rlm.ts):
  // contextFields keeps `context` OUT of the prompt and IN the code runtime; the JS
  // runtime is least-privilege (TIMING only); contextPolicy checkpoints/summarizes the
  // action log under a balanced budget so a long exploration stays within window.
  const rlm = axAgent("context:string, query:string -> answer:string, evidence:string[]", {
    ai,
    contextFields: ["context"],
    runtime: new AxJSRuntime({ permissions: [AxJSRuntimePermission.TIMING] }),
    maxSteps: limits.maxSteps,
    contextPolicy: { preset: "checkpointed", budget: "balanced" },
    // The actor (Kimi) defaults to CommonJS (`require(...)`), but the AxJSRuntime worker is a
    // SANDBOXED ES-MODULE context with NO require/import/Node modules — require-style code throws
    // "require is not defined" every actor turn and the run times out. Steer BOTH stages off
    // require AND off the askClarification/globalThis-scan dead-ends; variable NAMING is left to
    // ax's per-stage template (distiller: `context`; executor: inputs.executorRequest/distilledContext).
    contextOptions: { description: DISTILLER_RULE },
    executorOptions: { description: EXECUTOR_RULE },
    // actorTurnCallback fires once per executor turn (1-based). Bridge each turn into a
    // start→done|error pair labelled by stage (distiller/executor) so the live tree
    // shows the RLM's internal loop nested under the turn span.
    actorTurnCallback: (a: Readonly<AxAgentActorTurnCallbackArgs>) => {
      callbacks++
      turns = Math.max(turns, a.turn)
      const nodeId = `${rootId}/${a.stage}-${a.turn}`
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `rlm:${a.stage} turn ${a.turn}` })
      // ADVISORY per-turn charge: fold this turn's cumulative-usage DELTA into the budget
      // so spend streams live across executor turns (the old model charged once-after).
      // charge() never throws for the soft line — it only flips overSoft(), which we nudge.
      // Only the HARD runaway ceiling throws; the RLM answer is still returned regardless.
      const seen = tokensFromTurn(a.usage as ReadonlyArray<{ tokens?: Tok }> | undefined)
      if (seen > chargedTokens) {
        budget.charge({ totalTokens: seen - chargedTokens })
        chargedTokens = seen
        if (budget.overSoft()) onEvent({ type: "delta", nodeId, chunk: "⚠ over soft token budget (advisory — continuing)" })
      }
      if (a.code) onEvent({ type: "delta", nodeId, chunk: clip(a.code, 256) })
      if (a.isError) onEvent({ type: "error", nodeId, cause: new Error(clip(a.output, 256)) })
      else onEvent({ type: "done", nodeId, result: clip(a.output, 256) })
    },
    // onContextEvent fires on budget checks / checkpointing. Surface each as a delta on
    // the root RLM node so context-management pressure is visible in the tree.
    onContextEvent: (e: Readonly<AxAgentContextEvent>) => {
      callbacks++
      const label =
        e.kind === "budget_check"
          ? `${e.stage} budget:${e.pressure} (turn ${e.turn})`
          : `${e.stage} ${e.kind} (turn ${e.turn})`
      onEvent({ type: "delta", nodeId: rootId, chunk: label })
    },
  })

  // forward() drives the whole distiller→executor→responder loop. mem is a FRESH AxMemory
  // (forked — never the turn's shared history). tracer + traceContext thread into forward() so
  // ax nests its internal gen_ai stage spans under run_rlm (the same way turn() hands them to
  // the chat forward). They are turn-level extensions AxProgramForwardOptions tolerates but does
  // not declare — cast through, like node() does in orch.ts (sound, not an `any`: a known
  // structural superset).
  //
  // RLM TIMEOUT: race the whole forward against RLM_TIMEOUT_MS (a generous long-horizon ceiling
  // — NOT the per-node 120s). withTimeout forks a child signal off the turn's `signal`, so a
  // real cancel (signal abort) AND the timeout both abort the in-flight forward; we hand that
  // forked signal to forward() as its abortSignal so ax actually stops the request.
  const out = (await withTimeout(rootId, RLM_TIMEOUT_MS, signal, (rlmSignal) =>
    rlm.forward(
      ai,
      { context, query },
      { abortSignal: rlmSignal, mem: new AxMemory(), tracer, traceContext } as Parameters<typeof rlm.forward>[2],
    ),
  )) as { answer?: unknown; evidence?: unknown }

  // Reconcile any tail usage not seen by the per-turn callback (e.g. the responder stage),
  // charging only the remaining DELTA so the soft tally is complete. Still advisory — this
  // never throws for the soft line; only the hard runaway ceiling does.
  const finalSeen = tokensFromGetUsage(rlm.getUsage())
  if (finalSeen > chargedTokens) {
    budget.charge({ totalTokens: finalSeen - chargedTokens })
    chargedTokens = finalSeen
  }

  const answer = String(out.answer ?? "")
  const evidence = Array.isArray(out.evidence) ? out.evidence.map((x) => String(x)) : []
  // The responder is the final stage — emit a done so the tree shows it completed.
  onEvent({ type: "done", nodeId: `${rootId}/responder`, result: clip(answer, 256) })
  return { answer, evidence, turns, callbacks }
}
