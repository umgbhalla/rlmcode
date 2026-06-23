// WORKFLOW TOOL — the PRIMARY self-orchestration interface: the model AUTHORS a JS orchestration
// script (not a fixed JSON strategy-menu) and the engine runs it IN-PROCESS. The prims
// (phase/log/agent/parallel/pipeline/judge/rlm/budget/args) bound by buildWorkflowPrims() over the
// EXISTING engine (orch.ts 5 prims + orch-recipes recipes) are the INTENDED orchestration interface
// — this file adds NO 6th core primitive. RLM is the rlm() prim, one node-kind among many.
//
// RUN MODEL + HONEST SCOPE (D1): the body is a `new Function` whose PARAMETERS are the prims, so a
// script references them as free names — but `new Function` does NOT sandbox: the body runs
// IN-PROCESS with FULL host access (it can reach `process.env`, `globalThis`, `require`), bounded
// only by the token budget + the wall-clock timeout below. The prims are the intended API, NOT an
// enforced boundary. This is NO AxJSRuntime worker, NO sandbox ceremony — by design for 0.0.1.
//
// ponytail: in-process LLM-authored JS = full host authority (process.env/globalThis reachable),
// but <= the bash tool already exposed (tools.ts is unsandboxed real shell — see SECURITY.md), so
// in-process JS eval adds ZERO new authority over what the agent already has. The one asymmetry is
// auditability: a script reading process.env directly leaves NO `Tool: bash` tree row.
// Upgrade: run the body in an AxJSRuntime isolate (a worker the host can terminate) with the prims
// as host globals — proven for the RLM executor in rlm-node.ts — so the prims become the REAL
// enforced boundary (no process/globalThis) AND the wall-clock cap becomes total. Use if untrusted
// scripts ever run; out of 0.0.1 scope (the user wanted the simple in-process model).
//
// THE SAFETY MODEL (reuses the existing guards via buildWorkflowPrims): budget ceiling (advisory
// SOFT, runaway-only HARD throw), abortSignal threaded into every node, branch cap via
// parallelLimit, ONE LEVEL (prim nodes carry BASE_TOOLS only — a script cannot spawn a script).
// CONTEXT/TRACE: the handler runs Promise-native INSIDE forward() inside otelContext.with(
// traceContext), so node emits nest under the live chat.turn span in the SAME OrchTree.
import { type AxAIService, type AxFunction } from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { estimatedCostOf, getTurnEmit, llm, makeOnEvent } from "./runtime.ts"
import { choiceFromArgs } from "./models.ts"
import { allocate, BudgetExhaustedError } from "./orch.ts"
import { NodeTimeoutError, withTimeout } from "./orch-recipes.ts"
import { getTurnContext, setNodeSpanTracer } from "./orch-spans.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "../otel.ts"
import { buildWorkflowPrims, type WorkflowPrims } from "./workflow-prims.ts"

// Per-workflow SOFT token ceiling (advisory nudge line) + HARD runaway backstop (the ONLY one
// that throws). Same budget shape as rlm-workflow.ts — a real exploration run spends 70k–400k
// tokens, so ~2M is a sane "getting big" marker and ~20M only catches a true runaway loop.
const WF_TOKEN_BUDGET = Number(process.env.RLM_ORCH_TOKEN_BUDGET ?? 2_000_000)
const WF_TOKEN_HARD = Number(process.env.RLM_ORCH_TOKEN_HARD ?? 20_000_000)

// WALL-CLOCK ceiling for the whole script body (D2/D5). The token budget is BLIND to CPU
// runaway — a pure-JS loop makes zero LLM calls, so the HARD token ceiling never trips
// (D5); a wall-clock cap is the backstop a token ceiling cannot be. A real exploration
// script runs minutes (each agent/rlm node can take ~1–2 min), so 5 min is a sane ceiling
// that clears legitimate fan-outs and only catches a genuine hang. RLM_WORKFLOW_TIMEOUT_MS
// overrides; a non-finite/<=0 env falls back to the default (never disables the guard).
const WF_TIMEOUT_MS = (() => {
  const v = Number(process.env.RLM_WORKFLOW_TIMEOUT_MS ?? 300_000)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 300_000
})()

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)
// Human seconds for the timeout partial: whole seconds at >=10s (e.g. "300s"), one decimal
// below (e.g. "0.3s") so a small env-tuned ceiling never prints a misleading "0s".
const fmtSecs = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tok` : `${n} tok`)
const costFooter = (tokens: number): string => {
  const cost = estimatedCostOf(tokens)
  return `· ${fmtTok(tokens)}${cost !== undefined ? ` · ~$${cost.toFixed(4)}` : ""}`
}

const signalOf = (extra: { abortSignal?: AbortSignal } | undefined): AbortSignal =>
  extra?.abortSignal ?? new AbortController().signal

// Run the model-authored script body in-process: an async Function whose PARAMETER names are the
// prims (so the script body references them as free names). NB those parameters do NOT bound what
// the body can reach — `new Function` is not a sandbox, so the body also sees host globals
// (process/globalThis); see the file header (D1). The script's return value is what the workflow
// tool returns to the model. A SyntaxError (the model wrote bad JS) or a thrown error surfaces as a
// string — never crashes the turn.
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
    "AUTHOR a JS orchestration script and the engine runs it IN-PROCESS — for multi-node work (fan out, judge, mine a big blob), not a single reply. The body runs IN-PROCESS with host access (it is plain JS, NOT a sandbox) bounded only by the token budget + a wall-clock timeout; this is <= the bash tool you already have (no new authority). The script body uses these prims (the orchestration API — the intended interface, not an enforced boundary), mirroring a real workflow API: phase(title) groups the nodes that follow under a live tree heading; log(msg) narrates; agent(prompt, {label?, model?, effort?, schema?}) spawns ONE sub-agent NODE (file/shell tools) and returns its text (or a validated object with schema, or null if it dies); parallel(thunks) is a BARRIER — runs all concurrently (≤8 at once, the rest queue), a throwing thunk → null, so .filter(Boolean) the result; pipeline(items, ...stages) flows each item through every stage independently with NO barrier (stage(prev, item, i)); judge(candidates, criteria?) picks the best candidate verbatim; rlm(context, query) is the RLM NODE KIND — mine a BIG blob (long file/log/module) in a code runtime kept OUT of the prompt; budget is {total, spent(), remaining()} (advisory). `return <value>` is what comes back to you. EXAMPLE (fan out + judge): phase('audit'); const rs = await parallel([()=>agent('audit src/auth for bugs'),()=>agent('check the tests cover edge cases'),()=>agent('review error handling')]); return await judge(rs.filter(Boolean)); EXAMPLE (mine a blob): return await rlm(BIG_BLOB, 'which function registers the /auth route?'); EXAMPLE (pipeline): const outs = await pipeline(files, (prev,f)=>agent('summarize '+f), (prev)=>agent('refine: '+prev)); return outs.filter(Boolean).join('\\n'). RULES: sub-agent nodes carry the file/shell tools ONLY and canNOT themselves run a workflow (one level deep). Do NOT wrap a trivial or strictly sequential chore — do that directly. Write plain JS (loops/conditionals/await allowed at the top of the body).",
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
    // PER-TURN activity sink: recovered via getTurnEmit(sessionId) (turn() stashed it; ax forwards
    // only a fixed extra to a tool func, so it can't ride the forward opts). Absent ⇒ a no-op
    // (a standalone call with no turn boundary) — the run still works, it just emits no tree rows.
    const emit = getTurnEmit(extra?.sessionId)
    const onEvent = makeOnEvent(emit)
    // Wire the node-span minter under this root (the live-harness path has no turn()).
    setNodeSpanTracer(otelTrace.getTracer(SERVICE_NAME, SERVICE_VERSION))
    // PARENT CONTEXT: ax hands a tool func no traceContext (only a traceId string), and the
    // streaming for-await drain has already lost the ALS active() context by the time this
    // handler runs — so otelContext.active() here is the ROOT (→ fragmented traces). turn()
    // stashed its traceContext by sessionId; recover it so the whole run (root + node + RLM
    // spans) nests under the live chat.turn. Fallback to active() for the live-harness path.
    const parentCtx = getTurnContext(sessionId) ?? otelContext.active()
    try {
      // Run the ENTIRE body inside parentCtx so startNodeSpan's active-span fallback, the prims'
      // captured traceContext, AND the rlm() prim's own active() all resolve to chat.turn.
      // WALL-CLOCK CAP (D2/D5): race runScript against WF_TIMEOUT_MS. withTimeout forks a child
      // signal off the turn's `signal` (so a real cancel AND the deadline both abort), and we
      // build the prims with that FORKED signal so a timeout also aborts every in-flight node.
      // On timeout the race rejects with NodeTimeoutError → caught below → a partial string, the
      // turn never hangs.
      // ponytail: this wall-clock race interrupts an `await`-yielding loop (the realistic model
      // hang — a loop awaiting a prim/sleep), but a truly synchronous loop (`while(true){}`, no
      // await) pins the event loop so the timer can never fire — only a separate worker can preempt
      // that. The token HARD ceiling is likewise blind to pure-JS CPU (D5), so time is the backstop.
      // Upgrade: run the script in an AxJSRuntime isolate (a worker the host can terminate), as the
      // RLM executor already does (rlm-node.ts) — that makes the cap total + realizes D1's sandbox.
      const result = await otelContext.with(parentCtx, () =>
        withTimeout(rootId, WF_TIMEOUT_MS, signal, (wfSignal) => {
          onEvent({ type: "start", nodeId: rootId, phase: "workflow" })
          const prims = buildWorkflowPrims(ai, rootId, budget, wfSignal, choice, emit)
          return runScript(script, prims)
        }),
      )
      const reply = typeof result === "string" ? result : result === undefined ? "(workflow returned no value)" : (() => { try { return JSON.stringify(result) } catch { return String(result) } })()
      const spent = await budget.spent()
      onEvent({ type: "done", nodeId: rootId, result: clip(reply, 256) })
      return clip(`${reply}\n\n${costFooter(spent)}`)
    } catch (e) {
      onEvent({ type: "error", nodeId: rootId, cause: e })
      // WALL-CLOCK timeout (D2/D5): the script body ran past WF_TIMEOUT_MS — return a partial,
      // never hang the turn. (The token budget is blind to CPU runaway, so this is the backstop.)
      if (e instanceof NodeTimeoutError) return `workflow timed out after ${fmtSecs(WF_TIMEOUT_MS)} — partial (the script ran past its wall-clock ceiling and was stopped)`
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
