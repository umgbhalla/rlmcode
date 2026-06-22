// orch-optimize — OPT-IN GEPA self-improvement scaffold over the ORCHESTRATOR.
//
// ⚠️ WIP — NOT WORKING / UNVERIFIED. This is a scaffold only: the optimize() wiring has
// NEVER been run against a real GEPA optimize (the build gate was compile + a DRY
// assertOptimizeWiring check, not a live run), so the call construction, scoring, and
// artifact apply are UNPROVEN and likely need fixing. Do not treat GEPA as a working
// feature. See the SCAFFOLD-ONLY ponytail below; the real run + validation is the Upgrade.
//
// THE IDEA: the orchestrator decides, per user task, HOW to fan out — which model
// (kimi|glm), which strategy (parallel|judge|verify|pipeline), how many branches, and
// what node prompt to hand each leaf. Today those decisions are hand-written. GEPA can
// LEARN them: we expose the routing decision as a typed `ax` gen (the "router program"),
// score its predictions against a tiny labelled task set (expectedActions), and let
// @ax-llm/ax's `optimize()` evolve the router's instruction + few-shot demos over the
// REAL Kimi+GLM pool. The learned artifact is persisted to disk and re-applied on load.
//
// ponytail: SCAFFOLD-ONLY. This wires the optimize() call + applyOptimization() + the
// artifact loader and proves (DRY, via assertOptimizeWiring) the call is constructed
// correctly — it does NOT run a full GEPA optimize automatically (expensive: many live
// Kimi+GLM forwards). The `gepa` script runs it ONLY under AX2_GEPA=1, manually.
// Upgrade: run the real optimize over Kimi+GLM (AX2_GEPA=1 bun run gepa), commit the
// landed artifact (.ax/orch/optimized-router.json), and wire applyRouterOptimization()
// into the live orchestrate path so node selection uses the learned router.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import {
  ax,
  optimize,
  axSerializeOptimizedProgram,
  axDeserializeOptimizedProgram,
  type AxAIService,
  type AxGen,
  type AxMetricFn,
  type AxOptimizeOptions,
  type AxParetoResult,
  type AxSerializedOptimizedProgram,
  type AxTypedExample,
} from "@ax-llm/ax"
import { GLM, KIMI } from "./models.ts"

// ─── The router program (the thing GEPA optimizes) ──────────────────────────────────
//
// A single typed AxGen: given a coding task, predict the orchestration plan. The output
// fields are class/string fields ax can parse + validate; GEPA evolves THIS gen's
// instruction (and bootstraps few-shot demos) so its predictions match the labelled set.
// String-only I/O (no tools) — the router is a pure decision node, cheap to evaluate.
export const ROUTER_SIGNATURE =
  'task:string "A coding/agent task to orchestrate" -> ' +
  'model:class "kimi, glm" "Which pool model the lead node should run on", ' +
  'strategy:class "parallel, judge, verify, pipeline" "How to fan the work out", ' +
  'branches:number "How many sub-nodes to spawn (1..8)", ' +
  'nodePrompt:string "A concise system-prompt nudge for each sub-node"'

// Build a FRESH router gen. The optimizer mutates a program in place
// (applyOptimization), so callers that want an untouched baseline build their own.
export const buildRouter = (): AxGen => {
  const g = ax(ROUTER_SIGNATURE)
  g.setDescription(
    "You are the orchestrator's router. Decide the cheapest plan that will solve the task well: " +
      "pick a pool model, a fan-out strategy, a branch count, and a short per-node prompt nudge.",
  )
  return g
}

// ─── The task set shape ──────────────────────────────────────────────────────────────
//
// One labelled example = a task + the criteria a good plan must satisfy + the EXPECTED
// router actions (the gold label the metric scores against). `expectedActions` is the
// supervision signal; `criteria` is human-readable rationale (and feedback fodder for an
// eventual judge-based metric). The example doubles as an AxTypedExample: GEPA reads the
// input field (`task`) + the gold output fields (model/strategy/branches) off the SAME
// object, so we spread expectedActions into the example at build time (toExample below).
export type RouterAction = {
  readonly model: "kimi" | "glm"
  readonly strategy: "parallel" | "judge" | "verify" | "pipeline"
  readonly branches: number
}
export type RouterTask = {
  readonly task: string
  readonly criteria: string
  readonly expectedActions: RouterAction
}

// An ax example is the gold OUTPUT fields PLUS the input field — flat record. We project
// a RouterTask into that shape: `task` (input) + the expected output fields. nodePrompt
// is intentionally NOT supervised (it's the free-text component GEPA evolves), so the
// metric scores only the discrete routing decisions.
export const toExample = (t: RouterTask): AxTypedExample<{ task: string }> => ({
  task: t.task,
  model: t.expectedActions.model,
  strategy: t.expectedActions.strategy,
  branches: t.expectedActions.branches,
})

// ─── The metric (DETERMINISTIC, cheap, no extra LLM calls) ───────────────────────────
//
// Score a router prediction against the gold example: 0.5 for the right model, 0.4 for
// the right strategy, 0.1 for a branch count within ±1 (orchestration tolerates a close
// fan-out). Normalized to 0..1 so trade-offs read cleanly. A deterministic metric is the
// ax-gepa default for discrete labels — we avoid an LLM judge (the skill's "keep metrics
// deterministic and cheap" rule). The signature matches AxMetricFn exactly.
export const routerMetric: AxMetricFn = ({ prediction, example }) => {
  const p = prediction as Partial<RouterAction>
  const modelOk = typeof p.model === "string" && p.model === example.model ? 0.5 : 0
  const strategyOk = typeof p.strategy === "string" && p.strategy === example.strategy ? 0.4 : 0
  const gold = Number(example.branches)
  const got = Number(p.branches)
  const branchOk = Number.isFinite(got) && Number.isFinite(gold) && Math.abs(got - gold) <= 1 ? 0.1 : 0
  return modelOk + strategyOk + branchOk
}

// ─── optimize() options builder ──────────────────────────────────────────────────────
//
// Build the AxOptimizeOptions for the router run over the REAL Kimi+GLM pool: a cheaper
// student (Kimi, the default session model) + a stronger teacher (GLM) — the ax-gepa
// "strong teacher, cheaper student" default. validationExamples is the HELD-OUT set
// (never the train set, per the skill's selection rule). maxMetricCalls bounds cost and
// MUST cover at least one full validation pass — we size it from the validation length
// plus headroom. bootstrap composes AxBootstrapFewShot -> AxGEPA (top-level optimize()
// default) so the artifact keeps demos. All fields are real AxOptimizeOptions — no `any`.
export type RouterOptimizeArgs = {
  readonly studentAI: AxAIService
  readonly teacherAI: AxAIService
  readonly validation: ReadonlyArray<RouterTask>
  readonly target?: number // targetScore early-stop (0..1)
  readonly bootstrap?: boolean
  readonly maxMetricCalls?: number
  // judgeOptions is accepted for API parity with the agent.optimize() spec; the router
  // run uses a DETERMINISTIC metric (no judge), so it is recorded but not forwarded to
  // optimize() (which has no judge field — judge scoring lives on agent.optimize()).
  // ponytail: judgeOptions is inert here. Upgrade: a judge-scored router variant via a
  // plain typed AxGen evaluator when the routing label becomes qualitative.
  readonly judgeOptions?: Record<string, unknown>
}

export const buildOptimizeOptions = (args: RouterOptimizeArgs): AxOptimizeOptions => {
  const validationExamples = args.validation.map(toExample)
  // At least one full validation pass + several reflection rounds. Floor keeps a tiny
  // held-out set from starving GEPA (the skill: maxMetricCalls must cover the val pass).
  const maxMetricCalls = args.maxMetricCalls ?? Math.max(60, validationExamples.length * 8)
  return {
    studentAI: args.studentAI,
    teacherAI: args.teacherAI,
    validationExamples,
    maxMetricCalls,
    bootstrap: args.bootstrap ?? true,
    numTrials: 8,
    minibatch: true,
    minibatchSize: 4,
    earlyStoppingTrials: 4,
    sampleCount: 1,
    seed: 42,
    ...(args.target !== undefined ? { targetScore: args.target } : {}),
    verbose: true,
  }
}

// ─── DRY wiring assertion (THE GATE for this feature) ────────────────────────────────
//
// Prove — WITHOUT running a live GEPA optimize — that the optimize() call is constructed
// correctly: a real router program, train + held-out validation, a deterministic metric,
// and well-formed options (student/teacher present, distinct train vs validation,
// maxMetricCalls big enough for the val pass). Throws on any defect so the gepa script
// can assert the wiring statically and the dry path stays green in lint. Returns the
// built options so a caller can inspect/log them.
export const assertOptimizeWiring = (
  router: AxGen,
  train: ReadonlyArray<RouterTask>,
  args: RouterOptimizeArgs,
): AxOptimizeOptions => {
  if (typeof router.forward !== "function") throw new Error("router is not an AxGen (no forward)")
  if (train.length === 0) throw new Error("train set is empty")
  if (args.validation.length === 0) throw new Error("validation (held-out) set is empty")
  // Held-out discipline: validation must not reuse training tasks (the skill's rule).
  const trainTasks = new Set(train.map((t) => t.task))
  const leaked = args.validation.filter((v) => trainTasks.has(v.task))
  if (leaked.length > 0) throw new Error(`validation leaks ${leaked.length} training task(s) — keep them distinct`)
  if (args.studentAI === undefined) throw new Error("studentAI missing")
  if (args.teacherAI === undefined) throw new Error("teacherAI missing")
  const opts = buildOptimizeOptions(args)
  if ((opts.maxMetricCalls ?? 0) < args.validation.length) {
    throw new Error("maxMetricCalls too small to cover one validation pass")
  }
  // metric is callable + returns a finite 0..1 score on a hand-checked pair (no LLM call).
  const probe = routerMetric({
    prediction: { model: "kimi", strategy: "parallel", branches: 2 },
    example: { task: "x", model: "kimi", strategy: "parallel", branches: 2 },
  }) as number
  if (!Number.isFinite(probe) || probe < 0 || probe > 1) throw new Error("routerMetric did not return a 0..1 score")
  return opts
}

// ─── The optimize() call (REAL, run only by the gepa script under AX2_GEPA=1) ────────
//
// Run a real GEPA optimize over the router program: AxBootstrapFewShot -> AxGEPA across
// the Kimi+GLM pool. Returns the full Pareto result (optimizedProgram = best candidate).
// EXPENSIVE: many live forwards — never called in lint; the gepa script calls it only
// when AX2_GEPA=1. The student program is forwarded by ax against studentAI; the teacher
// proposes component rewrites. We assert the wiring first (cheap) so a misbuilt call
// fails before spending tokens.
export const optimizeRouter = async (
  router: AxGen,
  train: ReadonlyArray<RouterTask>,
  args: RouterOptimizeArgs,
): Promise<AxParetoResult> => {
  const opts = assertOptimizeWiring(router, train, args)
  const examples = train.map(toExample)
  return optimize(router, examples, routerMetric, opts)
}

// ─── Persisted artifact loader/saver ─────────────────────────────────────────────────
//
// The optimized program serializes to a plain JSON artifact (axSerializeOptimizedProgram
// drops the non-serializable applyTo method) so it survives a process restart and can be
// committed. saveOptimization writes it under .ax/orch/; loadOptimization reads it back +
// rehydrates via axDeserializeOptimizedProgram (which restores applyTo). applyRouter-
// Optimization re-applies a loaded artifact to a fresh router so the live orchestrate
// path can pick up the learned instruction/demos. The default path is committed alongside
// the artifact once a real run lands one (ponytail: no artifact exists until then).
export const OPTIMIZED_ROUTER_PATH = resolvePath(process.cwd(), ".ax/orch/optimized-router.json")

export const saveOptimization = (result: AxParetoResult, path = OPTIMIZED_ROUTER_PATH): void => {
  if (result.optimizedProgram === undefined) throw new Error("optimize result has no optimizedProgram to save")
  const serialized = axSerializeOptimizedProgram(result.optimizedProgram)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(serialized, null, 2), "utf8")
}

// Load a persisted artifact, or undefined if none has been committed yet (the normal
// scaffold-only state). Rehydrates to an AxOptimizedProgramImpl (applyTo restored).
export const loadOptimization = (path = OPTIMIZED_ROUTER_PATH) => {
  if (!existsSync(path)) return undefined
  const serialized = JSON.parse(readFileSync(path, "utf8")) as AxSerializedOptimizedProgram
  return axDeserializeOptimizedProgram(serialized)
}

// Apply a loaded artifact to a router program. Returns true if an artifact existed and
// was applied, false if none is committed yet (so the caller falls back to the baseline
// hand-written router). applyOptimization reaches the whole program (instruction + demos
// + componentMap), per the ax-gepa rule (not just setInstruction).
export const applyRouterOptimization = (router: AxGen, path = OPTIMIZED_ROUTER_PATH): boolean => {
  const loaded = loadOptimization(path)
  if (loaded === undefined) return false
  router.applyOptimization(loaded)
  return true
}

// Re-export the two pool model ids so the gepa script labels the student/teacher pool
// without re-importing models.ts.
export { GLM, KIMI }
