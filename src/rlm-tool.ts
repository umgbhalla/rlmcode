// Agent-callable RLM tool — `run_rlm`. A REAL single-level @ax-llm/ax RLM (the
// distiller → executor → responder loop over runtime-held context), wired the same
// way the proven standalone smoke runs it, but bridged into ax2's live node-event
// tree so a self-orchestrated RLM renders NESTED under the chat.turn span.
//
// WHY RLM (vs orchestrate's fan-out): a fan-out leaf pulls the whole context into the
// LLM prompt. An RLM instead loads the context into the code runtime (AxJSRuntime) and
// the executor writes JS (slice/grep/llmQuery) to mine it — so a HUGE context (a long
// file, a pasted log, a whole module concatenated) never blows the prompt window. This
// is the right tool for "find X buried somewhere in this big blob".
//
// THE SAFETY MODEL (mirrors rlm-workflow.ts):
//   1. ONE LEVEL: this tool lives on the MAIN chat gen only (agent.ts RLM_WORKFLOW_TOOLS). The
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
// CONTEXT/TRACE: like rlm-workflow.ts, the handler runs Promise-native INSIDE forward(),
// which turn() runs inside otelContext.with(traceContext). So onEvent()'s active-span
// read resolves to the live chat.turn span and the RLM's start/delta/done events nest
// in the SAME OrchTree. The actorTurnCallback / onContextEvent callbacks are bridged
// into NodeEvents with stage labels (distiller / executor / responder).
import {
  agent as axAgent,
  type AxAgentActorTurnCallbackArgs,
  type AxAgentContextEvent,
  type AxAIService,
  type AxFunction,
  AxJSRuntime,
  AxJSRuntimePermission,
  AxMemory,
} from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { limits, llm, onEvent } from "./runtime.ts"
import { allocate, BudgetExhaustedError } from "./orch.ts"
import { withTimeout } from "./orch-recipes.ts"
import { setNodeSpanTracer } from "./orch-spans.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"

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

// Steer BOTH actor stages (distiller + executor) away from CommonJS. The AxJSRuntime worker
// is a least-privilege ESM sandbox (no require/import/Node modules — by design); an RLM mines
// an in-memory context blob, so it never needs them. Kimi defaults to require() out of habit,
// which throws "require is not defined" and loops the run to a timeout — this reinforces the
// pure-JS contract the runtime already enforces. Variable-name-generic (executor sees
// executorRequest/distilledContext, distiller sees the raw context global).
const SANDBOX_RULE =
  "The code runtime is a SANDBOXED ES-MODULE environment: NO require(), NO import, NO Node modules (no fs, path, process, child_process, http). NEVER call require or import — they are undefined and throw. The data you need is ALREADY present as runtime variables — read it directly, never load it from disk. Use ONLY plain JavaScript (String/Array/Object methods, regex, JSON, Math, console.log) plus the injected primitives (llmQuery, final, askClarification). Write ONE small observable step per turn — a single console.log to inspect, or final(...) to finish."

const signalOf = (extra: { abortSignal?: AbortSignal } | undefined): AbortSignal =>
  extra?.abortSignal ?? new AbortController().signal

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
    // SANDBOXED ES-MODULE context with NO require/import/Node modules — require-style code
    // throws "require is not defined" every actor turn and the run times out. Both actor
    // stages write code (distiller mines the raw context global; executor works the
    // distilledContext), so steer BOTH — variable-name-generic (the executor sees
    // executorRequest/distilledContext, NOT the raw `context`).
    contextOptions: { description: SANDBOX_RULE },
    executorOptions: { description: SANDBOX_RULE },
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

// ── Tool: run_rlm ────────────────────────────────────────────────────────────────
const runRlmTool: AxFunction = {
  name: "run_rlm",
  description:
    "Mine a LARGE blob of context (a long file, a pasted log, a whole concatenated module) with a Recursive Language Model: the blob is loaded into a code runtime (NOT the prompt) and a sub-LM writes JavaScript (slice / regex / sub-queries / llmQuery) to explore it, then answers your query with evidence. WHEN TO USE: the context is too big to fit the prompt window and you need to FIND or SUMMARISE something buried inside it — prefer this over `orchestrate` (a fan-out node would pull the whole blob into its prompt; the RLM keeps it in the runtime). WHEN NOT: a small context that already fits — just read/reason over it directly. " +
    "EXAMPLE: run_rlm({ context: <the entire 12k-line bundle.js>, query: 'which function registers the /auth route and what middleware does it apply?' }) — the actor greps/slices the blob in JS and returns the answer + the matching line ranges as evidence. " +
    "PARAMS: context (the big text blob, kept out of the prompt, loaded into the code runtime); query (what to find or answer). Returns the answer plus supporting evidence. " +
    "Single level: the RLM cannot itself orchestrate or call file tools, and its actor writes PURE sandboxed JS — NEVER require/import (the data is already a runtime variable). See .ax/orch/GUIDE.md for when to pick run_rlm vs orchestrate.",
  parameters: {
    type: "object",
    properties: {
      context: { type: "string", description: "the large text blob to explore (kept out of the prompt, loaded into the code runtime)" },
      query: { type: "string", description: "what to find or answer about the context" },
    },
    required: ["context", "query"],
  },
  func: async (
    args: { context: string; query: string },
    extra?: Readonly<{ sessionId?: string; ai?: AxAIService; abortSignal?: AbortSignal }>,
  ) => {
    const context = String(args?.context ?? "")
    const query = String(args?.query ?? "").trim()
    if (context.length === 0) return "error: run_rlm requires a non-empty context"
    if (query.length === 0) return "error: run_rlm requires a non-empty query"
    const ai = extra?.ai ?? llm
    const sessionId = extra?.sessionId ?? "tool"
    const signal = signalOf(extra)
    const rootId = `rlm-tool:${sessionId}:${Date.now()}`
    onEvent({ type: "start", nodeId: rootId, phase: "run_rlm" })
    try {
      const out = await otelContext.with(otelContext.active(), () => runRlm(context, query, ai, rootId, signal))
      onEvent({ type: "done", nodeId: rootId, result: { turns: out.turns, callbacks: out.callbacks } })
      const evidence = out.evidence.length > 0 ? `\n\nEvidence:\n${out.evidence.map((e) => `- ${e}`).join("\n")}` : ""
      return clip(`${out.answer}${evidence}`)
    } catch (e) {
      onEvent({ type: "error", nodeId: rootId, cause: e })
      if (e instanceof BudgetExhaustedError) {
        return `partial: the RLM hit its token budget (${e.spent}/${e.total}) and was stopped before finishing. ${e.reason}.`
      }
      return `rlm failed: ${String((e as { message?: string })?.message ?? e).slice(0, 500)}`
    }
  },
}

export const RLM_TOOLS: AxFunction[] = [runRlmTool]
