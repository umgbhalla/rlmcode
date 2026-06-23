// WORKFLOW PRIMS — the in-process bindings the model-authored workflow script runs against.
// buildWorkflowPrims() returns the prims bound as the script body's PARAMETERS: phase/log/agent/
// parallel/pipeline/judge/rlm/budget/args. They are the INTENDED orchestration API, NOT an
// enforced scope (the body runs via `new Function` in-process and also sees host globals — see
// workflow.ts header, D1). Each is a THIN binding over the EXISTING engine
// (orch.ts 5 prims + orch-recipes recipes) — this file adds NO 6th core primitive. It mirrors
// the assistant Workflow API exactly (parallel = barrier + null-on-throw; pipeline = no barrier).
//
// UNIFIED VOCABULARY — ONE WORD: the orchestration unit is a NODE. agent()/judge()/rlm() each
// spawn ONE node (a BASE_TOOLS leaf for agent; a pure-reasoning node for judge; the rlm-node
// kind for rlm). leaf/worker/task/job are forbidden synonyms.
//
// THE SAFETY MODEL (mirrors rlm-workflow.ts — the prims REUSE its guards, nothing new):
//   1. ONE LEVEL: agent()/rlm() nodes are built with BASE_TOOLS ONLY (never the workflow tool),
//      so a script physically cannot spawn a script — the structural recursion guard.
//   2. BUDGET (advisory): every node charges the caller-supplied Budget; crossing the SOFT line
//      only nudges, a completed node is always returned. Only the HARD ceiling throws.
//   3. BRANCH cap: parallel() fans out via parallelLimit at <= ORCH_CONCURRENCY in flight.
//   4. abortSignal: threaded into every node forward via NodeOpts.
import { ax, AxMemory, type AxAIService, type AxGen } from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { BASE_PROMPT, limits, makeOnEvent, nodeRateLimiter, readUsageOf } from "./runtime.ts"
import { type NodeModelChoice, nodeForwardOpts } from "./models.ts"
import { finalizeOnMaxSteps, judge as judgeRecipe, parallelLimit, runNode } from "./orch-recipes.ts"
import { type ActivitySink, pipeline as pipelineCore, type Budget, type NodeOpts } from "./orch.ts"
import { setNodeSpanTracer } from "./orch-spans.ts"
import { runRlm } from "./rlm-node.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "../otel.ts"
import { BASE_TOOLS } from "./tools.ts"

// In-flight concurrency for a parallel() barrier — at most this many nodes run simultaneously;
// the rest QUEUE (parallelLimit). RLM_ORCH_CONCURRENCY overrides; default 8 (clamped 1..100).
const ORCH_CONCURRENCY = (() => {
  const v = Number(process.env.RLM_ORCH_CONCURRENCY ?? 8)
  return Number.isFinite(v) ? Math.min(100, Math.max(1, Math.floor(v))) : 8
})()

const clip = (s: string, n = 256) => (s.length > n ? `${s.slice(0, n)}…` : s)
const numbered = (xs: readonly string[]) => xs.map((c, i) => `#${i + 1}:\n${c}`).join("\n\n")

// agent()'s node gen — a REAL sub-agent: BASE_PROMPT (the capable base) + the caller's label as
// a stance overlay, carrying BASE_TOOLS ONLY (the one-level recursion guard — no workflow tool).
// A fresh AxGen per call so each node's getUsage() is its own.
const LEAF_TOOL_SCOPE =
  "Your tools: glob, grep, read_file, write_file, edit_file, bash, web_fetch. Prefer glob/grep to LOCATE before reading; read_file before edit_file; run bash to VERIFY. You are a single-level sub-agent: do the task end-to-end yourself — you canNOT orchestrate or spawn more sub-agents."
const agentGen = (label: string): AxGen => {
  const g = ax("message:string -> reply:string", { functions: BASE_TOOLS })
  g.setDescription(`${BASE_PROMPT} ${label} ${LEAF_TOOL_SCOPE}`)
  return g
}
const BASE_TOOL_NAMES = BASE_TOOLS.map((f) => f.name)

// The assistant Workflow API shape — the prim names bound as the script body's parameters (the
// intended API; the body can still reach host globals — see workflow.ts header). agent/parallel/
// pipeline/judge/rlm are async; phase/log are sync emits; budget/args are values.
export type AgentOpts = {
  readonly label?: string | undefined
  readonly phase?: string | undefined
  // schema: a JSON-schema for a validated OBJECT return. ponytail: untyped at this seam — the
  // schema is a model-authored shape and the validated result is structurally unknown to TS, so
  // the return crosses as `object`. Upgrade: a typed AxSignature builder per schema if scripts
  // ever need static field types. The cast is sound (we only narrow string|object at the seam).
  readonly schema?: Record<string, unknown> | undefined
  readonly model?: string | undefined
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined
}
export type WorkflowPrims = {
  phase: (title: string) => void
  log: (msg: string) => void
  agent: (prompt: string, opts?: AgentOpts) => Promise<string | object | null>
  parallel: <T>(thunks: ReadonlyArray<() => Promise<T>>) => Promise<Array<T | null>>
  pipeline: <T>(items: Iterable<T> | AsyncIterable<T>, ...stages: ReadonlyArray<(prev: unknown, item: T, i: number) => Promise<unknown>>) => Promise<unknown[]>
  judge: (candidates: readonly string[], criteria?: string) => Promise<string>
  rlm: (context: string, query: string, opts?: { readonly model?: string | undefined }) => Promise<string>
  budget: { total: number | null; spent: () => number; remaining: () => number }
  args: unknown
}

// buildWorkflowPrims — bind the prims for ONE workflow run. ai/rootId/budget/signal/choice are
// the boundary state the tool handler supplies (the same shape rlm-workflow.ts's boundary()
// mints): ai = the shared service, rootId = the tree root the nodes nest under, budget = the
// advisory ceiling, signal = the turn's abort, choice = the default per-node model routing.
// `args` is the script's input (usually undefined for rlmcode self-orchestration).
export const buildWorkflowPrims = (
  ai: AxAIService,
  rootId: string,
  budget: Budget,
  signal: AbortSignal,
  choice: NodeModelChoice | undefined,
  // PER-TURN activity sink: the tool handler passes the forward `extra.emit` (the per-turn
  // closure runTurn threaded). The node-lifecycle sink (onEvent) is built over it, and it rides
  // NodeOpts.emit so each node's tool rows tag with its id — replacing the deleted module global.
  emit: ActivitySink,
): WorkflowPrims => {
  const tracer = otelTrace.getTracer(SERVICE_NAME, SERVICE_VERSION)
  const traceContext = otelContext.active()
  setNodeSpanTracer(tracer)
  const onEvent = makeOnEvent(emit)
  // A fresh NodeOpts per node — forked AxMemory (concurrent nodes never share a mutating
  // history), the turn's abort, the ambient trace context, the per-node model routing, and the
  // per-turn activity emit (so the node's tool logger feeds THIS turn's queue).
  const optsFor = (c?: NodeModelChoice): NodeOpts => ({
    mem: new AxMemory(),
    sessionId: rootId,
    tracer,
    traceContext,
    maxSteps: limits.maxSteps,
    stream: false,
    abortSignal: signal,
    emit,
    // BACKGROUND lane (FIX B / contention): throttle this node on nodeRateLimiter's OWN clock
    // (a per-forward rateLimiter overrides the service-level chat lane) so a background fan-out
    // can never push the interactive chat turn's next forward behind N node reservations.
    rateLimiter: nodeRateLimiter,
    ...nodeForwardOpts(c ?? choice),
  })

  // `phase` tracks the CURRENT phase title; nodes spawned after it carry it as their label so
  // they group under that title in the live tree. `seq` mints a unique nodeId per node.
  let currentPhase = "workflow"
  // A holder (not a bare `let seq`) so the counter is READ on both the id-build and the advance —
  // a bare post-increment `seq++` reads as a dead final write to the analyzer (same pattern as
  // parallelLimit's cursor in orch-recipes.ts).
  const seq = { i: 0 }
  const nextId = () => {
    const id = `${rootId}/node-${seq.i}`
    seq.i = seq.i + 1
    return id
  }

  const phase = (title: string): void => {
    currentPhase = title
    onEvent({ type: "start", nodeId: nextId(), parentId: rootId, phase: `phase: ${clip(title, 64)}` })
  }
  const log = (msg: string): void => {
    onEvent({ type: "delta", nodeId: rootId, chunk: clip(msg, 256) })
  }

  // agent — spawn ONE BASE_TOOLS node forward (runNode). Without schema returns the reply text;
  // with a schema returns the validated object. null on throw (the script .filter(Boolean)s).
  const agent = async (prompt: string, opts?: AgentOpts): Promise<string | object | null> => {
    const nodeId = nextId()
    const label = opts?.label ?? opts?.phase ?? currentPhase
    const c: NodeModelChoice | undefined =
      opts?.model !== undefined || opts?.effort !== undefined ? { model: opts.model, effort: opts.effort } : choice
    const nodeOpts: NodeOpts = { ...optsFor(c), stepHooks: finalizeOnMaxSteps(BASE_TOOL_NAMES, onEvent, nodeId) }
    // SCHEMA: a model-authored JSON-schema asks for a validated OBJECT. Build a structured gen
    // whose output fields are the schema's top-level keys (string fields) so ax parses/validates
    // the reply into an object. ponytail (AgentOpts.schema): the field set is dynamic, so the gen
    // signature is built from the keys and the result crosses as `object`. Upgrade: a typed
    // AxSignature builder. No schema ⇒ the plain `-> reply:string` node, returns the text.
    const gen =
      opts?.schema !== undefined
        ? (() => {
            const fields = Object.keys(opts.schema as Record<string, unknown>)
            const sig = `message:string -> ${fields.length > 0 ? fields.map((f) => `${f}:string`).join(", ") : "reply:string"}`
            const g = ax(sig, { functions: BASE_TOOLS })
            g.setDescription(`${BASE_PROMPT} ${opts?.label ?? ""} ${LEAF_TOOL_SCOPE}`)
            return g
          })()
        : agentGen(typeof label === "string" ? label : "")
    try {
      const out = await runNode(
        { nodeId, parentId: rootId, phase: clip(label ?? "agent", 48), gen, opts: nodeOpts, onEvent, budget, usageOf: (g) => readUsageOf(g) },
        ai,
        { message: prompt },
      )
      if (opts?.schema !== undefined) return out as object
      return String((out as { reply?: string }).reply ?? "")
    } catch {
      return null
    }
  }

  // parallel — BARRIER: run all thunks concurrently (await all), at most ORCH_CONCURRENCY in
  // flight (the rest queue), a throwing thunk resolves to null. EXACTLY parallelLimit's contract.
  const parallel = <T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>> =>
    parallelLimit(thunks, ORCH_CONCURRENCY)

  // pipeline — NO barrier between stages: each item flows through ALL stages independently
  // (item A may be in stage 3 while B is still in stage 1). The core `pipeline` async-generator
  // does the fan-through; we adapt each Workflow-API stage(prev, item, i) — which also sees the
  // ORIGINAL item + its index — onto the core's single-arg (prev) => next stage shape, and a
  // throwing stage drops THAT item to null (it stops flowing). Drained to an array at the barrier
  // the caller awaits (the per-stage flow has no barrier; the final await collects results).
  const pipeline = async <T>(
    items: Iterable<T> | AsyncIterable<T>,
    ...stages: ReadonlyArray<(prev: unknown, item: T, i: number) => Promise<unknown>>
  ): Promise<unknown[]> => {
    // Snapshot the items so each carries its original value + index into every stage. The core
    // pipeline threads only the running `prev`; we pair it with the item via the indexed buffer.
    const buf: T[] = []
    for await (const it of items as AsyncIterable<T>) buf.push(it)
    const adapted = stages.map((stage) => async (prev: unknown): Promise<unknown> => {
      // prev arrives as { i, value } from the previous stage (or the seed); run the user stage,
      // null-on-throw drops the item out of the flow (yielded as null at the end).
      const { i, value } = prev as { i: number; value: unknown }
      if (value === null) return { i, value: null }
      try {
        return { i, value: await stage(value, buf[i] as T, i) }
      } catch {
        return { i, value: null }
      }
    })
    const out: unknown[] = new Array(buf.length).fill(null)
    for await (const r of pipelineCore(
      buf.map((value, i) => ({ i, value })),
      ...adapted,
    )) {
      const { i, value } = r as { i: number; value: unknown }
      out[i] = value
    }
    return out
  }

  // judge — one judge NODE picks the best candidate verbatim. A pure-reasoning gen (NO tools —
  // strictly stronger than the one-level guard). criteria defaults to a generic best-pick prompt.
  const judge = async (candidates: readonly string[], criteria?: string): Promise<string> => {
    const list = candidates.filter((c) => typeof c === "string" && c.length > 0)
    if (list.length === 0) return ""
    if (list.length === 1) return list[0]!
    const judgeId = nextId()
    onEvent({ type: "start", nodeId: judgeId, parentId: rootId, phase: "judge" })
    const judgeGen = ax("message:string, candidates:string -> reply:string")
    judgeGen.setDescription(
      "You are an impartial judge. Given the criteria and several candidate answers (numbered), pick the single best answer and return it VERBATIM as your reply — do not blend or rewrite.",
    )
    try {
      const judged = await judgeRecipe(ai, list, judgeGen, optsFor(), (cs) => ({
        message: criteria ?? "Pick the single best candidate.",
        candidates: numbered(cs as readonly string[]),
      }))
      budget.charge(readUsageOf(judgeGen))
      const reply = String((judged as { reply?: string }).reply ?? list[0]!)
      onEvent({ type: "done", nodeId: judgeId, result: clip(reply) })
      return reply
    } catch (cause) {
      onEvent({ type: "error", nodeId: judgeId, cause })
      return list[0]!
    }
  }

  // rlm — the RLM NODE KIND: mine a BIG context blob in the code runtime (out of the prompt) for
  // the query. JUST a prim — one node-kind among agent/judge, nothing special. runRlm builds the
  // single-level RLM and forwards it; we return its answer + evidence as a string. opts.model is
  // accepted for parity but the RLM uses the shared `ai` (one CF endpoint); routing is per-forward.
  const rlm = async (context: string, query: string, _opts?: { readonly model?: string | undefined }): Promise<string> => {
    const nodeId = nextId()
    if (context.length === 0) return "error: rlm() requires a non-empty context blob to mine"
    try {
      const out = await otelContext.with(otelContext.active(), () => runRlm(context, query, ai, nodeId, signal, onEvent))
      const evidence = out.evidence.length > 0 ? `\n\nEvidence:\n${out.evidence.map((e) => `- ${e}`).join("\n")}` : ""
      return `${out.answer}${evidence}`
    } catch (e) {
      return `rlm node failed: ${String((e as { message?: string })?.message ?? e).slice(0, 500)}`
    }
  }

  // budget — the advisory view over the caller's Budget: total (the soft ceiling, or null when
  // it's the runaway-only Infinity sentinel), spent() and remaining() (synchronous snapshots).
  // The underlying Budget.spent()/remaining() are async; we expose the last-known sync value the
  // nodes have charged so a script can read it inline (advisory only — never gates a node).
  let spentSnapshot = 0
  let remainingSnapshot = Number.isFinite(budget.total) ? budget.total : 0
  // Refresh the snapshots opportunistically off the async Budget (resolved, cheap — the tally is
  // in memory). A script reads the latest snapshot; the exact figure lands by the next await.
  const refresh = () => {
    void budget.spent().then((s) => (spentSnapshot = s))
    void budget.remaining().then((r) => (remainingSnapshot = r))
  }
  const budgetView = {
    total: Number.isFinite(budget.total) ? budget.total : null,
    spent: () => (refresh(), spentSnapshot),
    remaining: () => (refresh(), remainingSnapshot),
  }

  // `args` is the script's input — always undefined for rlmcode self-orchestration (the model
  // authors the whole script body; there is no separate input payload). Kept on the prim surface
  // for assistant-Workflow-API parity.
  return { phase, log, agent, parallel, pipeline, judge, rlm, budget: budgetView, args: undefined }
}
