// WORKFLOW TOOL — the PRIMARY self-orchestration interface: the model AUTHORS a JS orchestration
// script (not a fixed JSON strategy-menu) and the engine runs it IN-PROCESS. The script body sees
// ONLY the prims (phase/log/agent/parallel/pipeline/judge/rlm/budget/args) bound by
// buildWorkflowPrims() over the EXISTING engine (orch.ts 5 prims + orch-recipes recipes) — this
// file adds NO 6th core primitive. RLM is the rlm() prim, one node-kind among many.
//
// RUN MODEL: an async Function whose only in-scope names are the prims — exactly like the
// assistant's Workflow tool. NO AxJSRuntime worker, NO sandbox ceremony.
//
// ponytail: in-process LLM-authored JS = host authority, but <= the bash tool already exposed
// (tools.ts is unsandboxed real shell), so in-process JS eval adds ZERO new authority.
// Upgrade: AxJSRuntime isolate if untrusted scripts ever run.
//
// THE SAFETY MODEL (reuses the existing guards via buildWorkflowPrims): budget ceiling (advisory
// SOFT, runaway-only HARD throw), abortSignal threaded into every node, branch cap via
// parallelLimit, ONE LEVEL (prim nodes carry BASE_TOOLS only — a script cannot spawn a script).
// CONTEXT/TRACE: the handler runs Promise-native INSIDE forward() inside otelContext.with(
// traceContext), so node emits nest under the live chat.turn span in the SAME OrchTree.
import { type AxAIService, type AxFunction } from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { estimatedCostOf, llm, onEvent } from "./runtime.ts"
import { choiceFromArgs } from "./models.ts"
import { allocate, BudgetExhaustedError } from "./orch.ts"
import { setNodeSpanTracer } from "./orch-spans.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"
import { buildWorkflowPrims, type WorkflowPrims } from "./workflow-prims.ts"

// Per-workflow SOFT token ceiling (advisory nudge line) + HARD runaway backstop (the ONLY one
// that throws). Same budget shape as rlm-workflow.ts — a real exploration run spends 70k–400k
// tokens, so ~2M is a sane "getting big" marker and ~20M only catches a true runaway loop.
const WF_TOKEN_BUDGET = Number(process.env.AX2_ORCH_TOKEN_BUDGET ?? 2_000_000)
const WF_TOKEN_HARD = Number(process.env.AX2_ORCH_TOKEN_HARD ?? 20_000_000)

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tok` : `${n} tok`)
const costFooter = (tokens: number): string => {
  const cost = estimatedCostOf(tokens)
  return `· ${fmtTok(tokens)}${cost !== undefined ? ` · ~$${cost.toFixed(4)}` : ""}`
}

const signalOf = (extra: { abortSignal?: AbortSignal } | undefined): AbortSignal =>
  extra?.abortSignal ?? new AbortController().signal

// Run the model-authored script body in-process: an async Function whose ONLY parameter names are
// the prims (so the script body references them as free names). The script's return value is what
// the workflow tool returns to the model. A SyntaxError (the model wrote bad JS) or a thrown error
// surfaces as a string — never crashes the turn.
const runScript = async (script: string, prims: WorkflowPrims): Promise<unknown> => {
  const { phase, log, agent, parallel, pipeline, judge, rlm, budget, args } = prims
  // The async Function wrapper: the body runs with the prims bound as parameters. `await` is
  // allowed at the top level of the body (it is an async function body, not a module).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    "phase",
    "log",
    "agent",
    "parallel",
    "pipeline",
    "judge",
    "rlm",
    "budget",
    "args",
    `return (async () => { ${script}\n })()`,
  ) as (...a: unknown[]) => Promise<unknown>
  return fn(phase, log, agent, parallel, pipeline, judge, rlm, budget, args)
}

const workflowTool: AxFunction = {
  name: "workflow",
  description:
    "AUTHOR a JS orchestration script and the engine runs it IN-PROCESS — for multi-node work (fan out, judge, mine a big blob), not a single reply. The script body uses these prims (the ONLY names in scope), mirroring a real workflow API: phase(title) groups the nodes that follow under a live tree heading; log(msg) narrates; agent(prompt, {label?, model?, effort?, schema?}) spawns ONE sub-agent NODE (file/shell tools) and returns its text (or a validated object with schema, or null if it dies); parallel(thunks) is a BARRIER — runs all concurrently (≤8 at once, the rest queue), a throwing thunk → null, so .filter(Boolean) the result; pipeline(items, ...stages) flows each item through every stage independently with NO barrier (stage(prev, item, i)); judge(candidates, criteria?) picks the best candidate verbatim; rlm(context, query) is the RLM NODE KIND — mine a BIG blob (long file/log/module) in a code runtime kept OUT of the prompt; budget is {total, spent(), remaining()} (advisory). `return <value>` is what comes back to you. EXAMPLE (fan out + judge): phase('audit'); const rs = await parallel([()=>agent('audit src/auth for bugs'),()=>agent('check the tests cover edge cases'),()=>agent('review error handling')]); return await judge(rs.filter(Boolean)); EXAMPLE (mine a blob): return await rlm(BIG_BLOB, 'which function registers the /auth route?'); EXAMPLE (pipeline): const outs = await pipeline(files, (prev,f)=>agent('summarize '+f), (prev)=>agent('refine: '+prev)); return outs.filter(Boolean).join('\\n'). RULES: sub-agent nodes carry the file/shell tools ONLY and canNOT themselves run a workflow (one level deep). Do NOT wrap a trivial or strictly sequential chore — do that directly. Write plain JS (loops/conditionals/await allowed at the top of the body).",
  parameters: {
    type: "object",
    properties: {
      script: { type: "string", description: "the JS orchestration script body — a sequence of statements using the prims (phase/log/agent/parallel/pipeline/judge/rlm/budget/args), ending in a `return` of the value to hand back. `await` is allowed at the top level of the body." },
      model: { type: "string", description: "default model for the script's agent() nodes — 'kimi' (default) or 'glm'. A per-agent {model} overrides it." },
      effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "default thinking level for the script's agent() nodes." },
    },
    required: ["script"],
  },
  func: async (
    args: { script?: string; model?: string; effort?: string },
    extra?: Readonly<{ sessionId?: string; ai?: AxAIService; abortSignal?: AbortSignal }>,
  ) => {
    const script = String(args?.script ?? "").trim()
    if (script.length === 0) return "error: workflow requires a non-empty `script`"
    const ai = extra?.ai ?? llm
    const sessionId = extra?.sessionId ?? "tool"
    const signal = signalOf(extra)
    const rootId = `workflow:${sessionId}:${Date.now()}`
    const choice = choiceFromArgs({ model: args?.model, effort: args?.effort })
    const budget = allocate(WF_TOKEN_BUDGET, WF_TOKEN_HARD)
    // Wire the node-span minter under this root (the live-harness path has no turn()).
    setNodeSpanTracer(otelTrace.getTracer(SERVICE_NAME, SERVICE_VERSION))
    onEvent({ type: "start", nodeId: rootId, phase: "workflow" })
    try {
      const prims = buildWorkflowPrims(ai, rootId, budget, signal, choice)
      // The handler runs Promise-native INSIDE the active OTel context so the script's node
      // emits nest under the live chat.turn span (one trace per session).
      const result = await otelContext.with(otelContext.active(), () => runScript(script, prims))
      const reply = typeof result === "string" ? result : result === undefined ? "(workflow returned no value)" : (() => { try { return JSON.stringify(result) } catch { return String(result) } })()
      const spent = await budget.spent()
      onEvent({ type: "done", nodeId: rootId, result: clip(reply, 256) })
      return clip(`${reply}\n\n${costFooter(spent)}`)
    } catch (e) {
      onEvent({ type: "error", nodeId: rootId, cause: e })
      // BUDGET ceiling (advisory — never throws for the soft line): this only fires for a genuine
      // RUNAWAY (the HARD ceiling) or a script error. Return a string, never throw the turn.
      if (e instanceof BudgetExhaustedError) return `partial: the workflow hit its HARD runaway token ceiling (${e.spent}/${e.total}) and was stopped. ${e.reason}.`
      return `workflow failed: ${String((e as { message?: string })?.message ?? e).slice(0, 500)}`
    }
  },
}

// The agent-callable workflow tool — added to the MAIN chat gen ONLY (agent.ts), never to a node
// gen (nodes carry BASE_TOOLS), so the one-level recursion guard holds.
export const WORKFLOW_TOOLS: AxFunction[] = [workflowTool]
