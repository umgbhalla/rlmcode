// AUTO-DECOMPOSITION — the PLANNER node behind the orchestrate tool's 'plan' strategy.
// A planner sub-agent splits a task into a DISTINCT subtask list ITSELF (the model's own
// division of labour) so the orchestrate fan-out is over a plan the model produced, NOT a
// subtask list the caller hand-wrote. Lives in its OWN module so orch-tools.ts stays under
// the line budget; it adds NO 6th core primitive — it composes runNode() (orch-recipes.ts)
// over a typed gen, exactly like the judge/skeptic reasoning nodes.
import { ax, type AxAIService, type AxGen } from "@ax-llm/ax"
import { type EmitSink, runNode } from "./orch-recipes.ts"
import type { Budget, BudgetUsage, LeafOpts } from "./orch.ts"

// PLANNER node gen — AUTO-decomposition. A pure REASONING node (NO tools, like judge/
// skeptic — strictly STRONGER than the BASE_TOOLS-only recursion guard: zero functions ⇒ it
// physically cannot loop tools OR re-orchestrate) typed by a STRUCTURED signature
// `task:string -> subtasks:string[]`: ax parses/validates/retries the JSON array, so the
// planner emits a REAL distinct subtask list (the model's OWN division of labour), not a
// string blob. The list drives the fan-out: branch i works subtasks[i]. This is the model
// deciding the split — vs the caller passing `subtasks`. A fresh AxGen per call so its
// getUsage() is its own (crisp budget charging).
const plannerGen = (): AxGen => {
  const g = ax("task:string -> subtasks:string[]")
  g.setDescription(
    "You are a planner. Decompose the given task into a SHORT list of DISTINCT, independent subtasks that together accomplish it — real division of labour, NOT redundant rephrasings of the same work. Each subtask must be self-contained and actionable by a single sub-agent on its own. Emit 2-6 subtasks for a decomposable task; emit a single subtask only if the task genuinely cannot be split. Return the `subtasks` array.",
  )
  return g
}

// Run the planner node, returning its DISTINCT subtask list (blanks dropped, de-duplicated
// case-insensitively, clamped to `cap` = the branch cap). Charged to the shared advisory
// budget. Renders as a node under rootId (phase "plan: decompose") so the live tree shows
// the plan as the first step. onEvent/usageOf are threaded in so this module stays free of
// the runtime.ts singletons (the caller in orch-tools.ts supplies them).
export const runPlanner = async (opts: {
  ai: AxAIService
  task: string
  cap: number
  optsFor: () => LeafOpts
  budget: Budget
  rootId: string
  onEvent: EmitSink
  usageOf: (gen: AxGen) => BudgetUsage | undefined
}): Promise<string[]> => {
  const { ai, task, cap, optsFor, budget, rootId, onEvent, usageOf } = opts
  const planId = `${rootId}/planner`
  const out = await runNode(
    { nodeId: planId, parentId: rootId, phase: "plan: decompose", gen: plannerGen(), opts: optsFor(), onEvent, budget, usageOf },
    ai,
    { task },
  )
  const raw = (out as { subtasks?: unknown }).subtasks
  const list = (Array.isArray(raw) ? raw : [])
    .map((s) => String(s ?? "").trim())
    .filter((s) => s.length > 0)
  // De-dupe (case-insensitive) so a planner that repeats itself doesn't waste a branch,
  // then clamp to the branch cap. The downstream distinctness GATE relies on a real split.
  const seen = new Set<string>()
  const distinct = list.filter((s) => {
    const k = s.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return distinct.slice(0, Math.max(1, cap))
}
