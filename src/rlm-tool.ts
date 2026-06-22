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
// THE SAFETY MODEL (mirrors orch-tools.ts):
//   1. ONE LEVEL: this tool lives on the MAIN chat gen only (agent.ts ORCH_TOOLS). The
//      RLM's own executor runs JS in the AxJSRuntime sandbox (TIMING permission only —
//      no network/fs/process); it has NO ax2 file/shell tools and cannot re-orchestrate.
//   2. BUDGET ceiling: the RLM runs under its OWN allocate(RLM_TOKEN_BUDGET); the
//      run's usage is charged after forward() returns. A breach surfaces as a partial.
//   3. maxSteps cap: the RLM actor loop is bounded by maxSteps (executor turns).
//   4. abortSignal: extra.abortSignal threads into forward() so a cancelled turn
//      cancels the RLM run.
//
// CONTEXT/TRACE: like orch-tools.ts, the handler runs Promise-native INSIDE forward(),
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
import { context as otelContext } from "@opentelemetry/api"
import { limits, llm, onEvent, readUsageOf } from "./runtime.ts"
import { allocate, BudgetExhaustedError } from "./orch.ts"

// Per-RLM token ceiling, charged after forward() returns. An RLM explores a big
// context across many executor turns + sub-LM queries, so it needs generous headroom
// (matches the orchestrate ceiling). Backstop against a runaway loop, not a tight cap.
// ponytail: ONE ceiling charged once after the whole run — not per executor turn, so a
// runaway actor isn't stopped mid-run, only after. Upgrade: stream per-turn usage off
// actorTurnCallback.usage and charge incrementally so the budget can abort live.
const RLM_TOKEN_BUDGET = Number(process.env.AX2_RLM_TOKEN_BUDGET ?? 2_000_000)

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)

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
  const budget = allocate(RLM_TOKEN_BUDGET)
  // Bridge counters surfaced to the caller so the smoke can assert callbacks fired.
  let turns = 0
  let callbacks = 0

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
    // actorTurnCallback fires once per executor turn (1-based). Bridge each turn into a
    // start→done|error pair labelled by stage (distiller/executor) so the live tree
    // shows the RLM's internal loop nested under the turn span.
    actorTurnCallback: (a: Readonly<AxAgentActorTurnCallbackArgs>) => {
      callbacks++
      turns = Math.max(turns, a.turn)
      const nodeId = `${rootId}/${a.stage}-${a.turn}`
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `rlm:${a.stage} turn ${a.turn}` })
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

  // forward() drives the whole distiller→executor→responder loop. abortSignal honours a
  // cancelled turn; mem is a FRESH AxMemory (forked — never the turn's shared history).
  const out = (await rlm.forward(
    ai,
    { context, query },
    { abortSignal: signal, mem: new AxMemory() },
  )) as { answer?: unknown; evidence?: unknown }

  // Charge the run's usage to the per-RLM budget (after forward, like the agent recipe).
  // A breach throws BudgetExhaustedError, caught by the tool handler for a partial.
  budget.charge(readUsageOf(rlm))

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
    "Explore a LARGE blob of context (a long file, a pasted log, a whole concatenated module) with a Recursive Language Model: the context is loaded into a code runtime (NOT the prompt) and a sub-LM writes JavaScript (slice / regex / sub-queries) to mine it, then answers your query with evidence. Use this — NOT orchestrate — when the context is too big to fit the prompt window and you need to FIND or SUMMARISE something buried inside it. Params: context (the big text blob), query (what to find/answer). Returns the answer plus supporting evidence. Single level: the RLM cannot itself orchestrate or call file tools.",
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
