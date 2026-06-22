// Agent-callable RLM_WORKFLOW tool — the agent SELF-orchestrates. The model, mid-turn,
// decides to fan out / judge / verify / best-of-N over a sub-task via `rlm_workflow`.
// It runs the EXISTING engine (the 5 prims in orch.ts + the recipes in orch-recipes.ts)
// — this file adds NO 6th core primitive; it only composes what is already there.
//
// THE SAFETY MODEL (an LLM that can spawn fan-outs that spawn fan-outs = runaway cost):
//   1. STRUCTURAL one-level recursion guard: every worker NODE gen (nodeGen/nodeWorker — the
//      nodes that loop file/shell tools) carries BASE_TOOLS only, NEVER +RLM_WORKFLOW_TOOLS, so it
//      physically cannot re-orchestrate (structural, not a race-prone depth counter). The judge
//      + skeptic gens carry NO functions at all (pure reasoning over produced text) — strictly
//      stronger, so the one-level contract holds a fortiori.
//   2. BUDGET ceiling (ADVISORY/soft): each self-orchestration runs under its own
//      allocate(SOFT, HARD). SOFT (AX2_ORCH_TOKEN_BUDGET) only NUDGES — a node that did real
//      work is always returned. Only HARD (AX2_ORCH_TOKEN_HARD, a high runaway backstop) throws
//      BudgetExhaustedError → a PARTIAL string. maxSteps is the per-node hard stop.
//   3. BRANCH cap: orchestrate clamps the requested branch count to 1..MAX_BRANCHES (100), and
//      fanOut runs them via parallelLimit at <= ORCH_CONCURRENCY in flight (the rest QUEUE) — a
//      100-branch request runs concurrency-at-a-time, never 100 simultaneous CF hits. The
//      service-level rateLimiter (runtime.ts) is the second throttle.
//   4. abortSignal: extra.abortSignal threads into every NodeOpts, so a cancelled turn
//      cancels the whole sub-run (ax honors it in forward()).
//
// CONTEXT/TRACE: a tool handler runs Promise-native INSIDE forward(), which turn() runs inside
// otelContext.with(traceContext), so onEvent's getActiveSpan() resolves to the live chat.turn
// span and sub-run NodeEvents render in the SAME OrchTree — one trace per session stays intact.
import { ax, AxMemory, type AxAIService, type AxFunction, type AxGen } from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { BASE_PROMPT, estimatedCostOf, limits, llm, onEvent, readUsageOf } from "./runtime.ts"
import { choiceFromArgs, type NodeModelChoice, nodeForwardOpts } from "./models.ts"
import { adversarialVerify, finalizeOnMaxSteps, judge, loopUntilDry, MAX_CONCURRENCY, parallelLimit, runNode } from "./orch-recipes.ts"
import { allocate, type Budget, BudgetExhaustedError, type NodeOpts } from "./orch.ts"
import { setNodeSpanTracer } from "./orch-spans.ts"
import { runPlanner } from "./orch-plan.ts"
import { runRlm } from "./rlm-node.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"
import { BASE_TOOLS } from "./tools.ts"

// Per-self-orchestration SOFT token ceiling, SHARED across the sub-run's branches. This
// is the ADVISORY nudge line — crossing it logs/nudges but NEVER discards a completed
// node (the root-cause fix: the old hard model threw BudgetExhaustedError after a node
// finished and the empty-string discard nuked its real work). A real exploration node
// spends 70k–400k tokens, so ~2M is a sane "this run is getting big" marker.
const ORCH_TOKEN_BUDGET = Number(process.env.AX2_ORCH_TOKEN_BUDGET ?? 2_000_000)

// HARD runaway backstop — the ONLY ceiling that aborts (BudgetExhaustedError). Very high
// (~20M) so it never trips a single genuine node/fan-out; it only catches a true runaway
// loop. maxSteps (limits.maxSteps, ax-enforced per node forward) is the real per-node stop.
const ORCH_TOKEN_HARD = Number(process.env.AX2_ORCH_TOKEN_HARD ?? 20_000_000)

// PER-BRANCH BUDGETS (upgrade of the old "one shared ceiling" ponytail): each concurrent branch
// forwards under its OWN child Budget, so its advisory SOFT line is per-branch — a greedy branch
// nudges on its OWN spend and can't eat a sibling's headroom against one shared, concurrently-
// raced counter. After a branch settles its spend folds into the parent run-total SINGLE-THREADED
// (on the orchestrating fiber, see nodeWorker), so the parent stays the authoritative run-total
// for the cost-meter AND still trips the HARD ceiling on a genuine cumulative whole-run runaway.
const branchBudget = (): Budget => allocate(ORCH_TOKEN_BUDGET, ORCH_TOKEN_HARD)

// BRANCH cap — hard upper bound on parallel leaves, regardless of what the model asks.
// Raised from 4 to MAX_CONCURRENCY (100) for real fan-out scale: the model's request is
// clamped to 1..MAX_BRANCHES, but the nodes are FANNED OUT via parallelLimit(nodes,
// ORCH_CONCURRENCY) so at most ORCH_CONCURRENCY run at once — a 100-branch decompose runs
// concurrency-at-a-time, the rest queue. So the cap is high (scale) but bounded (safe).
const MAX_BRANCHES = MAX_CONCURRENCY

// In-flight concurrency for a single orchestrate fan-out — at most this many sub-agent
// nodes run simultaneously; the remaining requested branches QUEUE behind them
// (parallelLimit). AX2_ORCH_CONCURRENCY overrides; default 8 (clamped 1..MAX_CONCURRENCY).
const ORCH_CONCURRENCY = (() => {
  const v = Number(process.env.AX2_ORCH_CONCURRENCY ?? 8)
  return Number.isFinite(v) ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(v))) : 8
})()

const STRATEGIES = ["parallel", "judge", "verify", "best_of_n", "plan", "rlm"] as const
type Strategy = (typeof STRATEGIES)[number]

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)

// COST-METER: a compact usage footer the orchestrate tool appends to its returned reply —
// "… · 4 branches · 318k tok" (+ " · ~$0.0123" when ax has a price for the model). `tokens`
// is the sub-run's TOTAL spend (budget.spent()); branches is the surviving branch count.
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k tok` : `${n} tok`)
const costMeterSummary = (branches: number, tokens: number): string => {
  const parts = [`${branches} ${branches === 1 ? "branch" : "branches"}`, fmtTok(tokens)]
  const cost = estimatedCostOf(tokens)
  if (cost !== undefined) parts.push(`~$${cost.toFixed(4)}`)
  return parts.join(" · ")
}

// Pull a usable abortSignal out of extra, or fall back to a never-aborted one so a
// missing signal never crashes the handler.
const signalOf = (extra: { abortSignal?: AbortSignal } | undefined): AbortSignal =>
  extra?.abortSignal ?? new AbortController().signal

// Build the SHARED boundary state for a self-orchestration: the FORKED-memory NodeOpts
// factory (a fresh AxMemory per call → concurrent leaves never share a mutating history),
// a fresh Budget at the ORCH ceiling, and a stable rootId the sub-run nests under. tracer
// + traceContext are read from the AMBIENT OTel context (the live chat.turn span set by
// turn()), so sub-run spans/events land in the session's one trace.
const boundary = (sessionId: string, signal: AbortSignal, rootId: string) => {
  const tracer = otelTrace.getTracer(SERVICE_NAME, SERVICE_VERSION)
  const traceContext = otelContext.active()
  setNodeSpanTracer(tracer) // telemetry 2b: node spans under the orchestrate root (live-harness path has no turn())
  // MULTI-MODEL: optsFor takes an OPTIONAL routing choice — nodeForwardOpts() spreads {model, modelConfig, thinkingTokenBudget} onto NodeOpts (absent ⇒ default Kimi).
  const optsFor = (choice?: NodeModelChoice): NodeOpts => ({
    mem: new AxMemory(),
    sessionId,
    tracer,
    traceContext,
    maxSteps: limits.maxSteps,
    stream: false,
    abortSignal: signal,
    ...nodeForwardOpts(choice),
  })
  const budget = allocate(ORCH_TOKEN_BUDGET, ORCH_TOKEN_HARD)
  return { optsFor, budget, rootId }
}

// A sub-run node gen — a REAL sub-agent: the SAME capable BASE_PROMPT as the main agent (from
// runtime.ts, the neutral cycle-breaker — NOT agent.ts, so no agent ⇄ rlm-workflow init cycle),
// with the caller's `persona` as an OVERLAY. It carries BASE_TOOLS ONLY (no RLM_WORKFLOW_TOOLS/overlay)
// — the structural one-level recursion guard: a node physically cannot re-orchestrate. A fresh
// AxGen per call (never shared across concurrent branches) keeps each node's getUsage() its own.
// LEAF_TOOL_SCOPE is a terse tool-scoping overlay (claude_code Explore-style) appended AFTER the
// persona so a node knows its tools + priorities without bloating the prompt. One level deep.
const LEAF_TOOL_SCOPE = [
  "Your tools: glob (find files by pattern), grep (search file contents), read_file (read a known path),",
  "write_file / edit_file (modify files), bash (run real commands), web_fetch (fetch a URL).",
  "Prefer glob/grep to LOCATE before reading; read_file before you edit_file; run real bash commands to VERIFY.",
  "You are a single-level sub-agent: do the task end-to-end yourself — you canNOT orchestrate or spawn more sub-agents.",
].join(" ")

const nodeGen = (persona: string): AxGen => {
  const g = ax("message:string -> reply:string", { functions: BASE_TOOLS })
  g.setDescription(`${BASE_PROMPT} ${persona} ${LEAF_TOOL_SCOPE}`)
  return g
}

// The node gen's tool names — handed to finalizeOnMaxSteps so a node that exhausts its step
// budget is FORCED to emit its best reply in-loop (GRACEFUL ceiling) instead of throwing
// "max steps reached" → an empty/failed branch. Same claude_code behavior as the main turn.
const BASE_TOOL_NAMES = BASE_TOOLS.map((f) => f.name)

// One bracketed worker node over `task`. PER-BRANCH BUDGET: the node forwards under its OWN
// child Budget (independent soft line); its spend folds into the parent AGGREGATE after it
// settles (mergeBranchSpend). nodeId nests the node under rootId in the live tree.
type NodeWorkerOpts = {
  ai: AxAIService
  rootId: string
  i: number
  task: string
  persona: string
  optsFor: (choice?: NodeModelChoice) => NodeOpts
  budget: Budget // parent aggregate (the run-total + HARD backstop)
  choice?: NodeModelChoice | undefined // MULTI-MODEL: routing choice; absent ⇒ default Kimi
}
const nodeWorker = ({ ai, rootId, i, task, persona, optsFor, budget, choice }: NodeWorkerOpts): Promise<string> => {
  const nodeId = `${rootId}/branch-${i}`
  // runNode() emits the single start (with parentId+label) and the done/error — no
  // double-emit here, which previously overwrote the "branch N" label with "node".
  // The persona is an OVERLAY on BASE_PROMPT (nodeGen prepends the full main-agent
  // system prompt); the node is already told it has the file tools, so the overlay
  // is just a stance, not a re-statement of its capabilities.
  //
  // The branch LABEL (phase) reflects this branch's OWN subtask (clipped), not a
  // generic "branch N" — so the live tree shows the division of labour, and a
  // decompose run reads as distinct work per node rather than N identical attempts.
  const gen = nodeGen(persona)
  // GRACEFUL MAX-STEPS for a node: strip the node's tools on its last permitted step so it
  // returns its BEST reply (from work already done) instead of throwing — a node that exhausts
  // steps yields real output, never an error/empty branch. The marker renders on this node.
  const opts: NodeOpts = { ...optsFor(choice), stepHooks: finalizeOnMaxSteps(BASE_TOOL_NAMES, onEvent, nodeId) }
  // PER-BRANCH BUDGET: runNode charges THIS branch's own child budget (no shared-counter race
  // with siblings); fold its spend into the parent after it settles — including on failure, so a
  // branch's pre-failure spend is still accounted (single-threaded charge on the boundary fiber).
  const childBudget = branchBudget()
  const merge = async () => void budget.charge({ totalTokens: await childBudget.spent() })
  return runNode(
    { nodeId, parentId: rootId, phase: `branch ${i + 1}: ${clip(task, 48)}`, gen, opts, onEvent, budget: childBudget, usageOf: (g) => readUsageOf(g) },
    ai,
    { message: task },
  ).then(
    async (o) => (await merge(), String((o as { reply?: string }).reply ?? "")),
    async (err) => (await merge(), Promise.reject(err)),
  )
}

const PERSONAS = [
  "You are a terse, no-nonsense senior engineer.",
  "You are a thorough, methodical investigator.",
  "You are a pragmatic problem-solver who values the simplest working approach.",
  "You are a careful reviewer who double-checks edge cases.",
] as const

const numbered = (xs: readonly string[]) => xs.map((c, i) => `#${i + 1}:\n${c}`).join("\n\n")

// Compose one self-orchestration over `task` for the requested strategy. Promise-native:
// fans out workers (BASE_TOOLS leaves, forked mem), then judges/verifies per strategy.
// Every node emits through onEvent → the OrchTree. The budget is ADVISORY: a node over
// the soft line still returns its real work (a nudge delta marks it); only a HARD-ceiling
// runaway bubbles as BudgetExhaustedError, caught by the handler for a partial return.
type OrchestrationOpts = {
  ai: AxAIService
  strategy: Strategy
  task: string
  // DISTINCT subtasks (division of labour): branch i works subtasks[i]. Empty/absent
  // ⇒ the parallel-same fallback — every branch gets `task` (redundant attempts). The
  // model is told to PREFER distinct subtasks; same-task is the cheap default only.
  subtasks: string[]
  branches: number
  optsFor: (choice?: NodeModelChoice) => NodeOpts
  budget: Budget
  rootId: string
  choice?: NodeModelChoice | undefined // MULTI-MODEL: per-run routing for WORKER nodes (absent ⇒ Kimi)
}
const runRlmWorkflow = async ({
  ai,
  strategy,
  task,
  subtasks,
  branches,
  optsFor,
  budget,
  rootId,
  choice,
}: OrchestrationOpts): Promise<{ reply: string; branches: number; accepted?: boolean }> => {
  onEvent({ type: "start", nodeId: rootId, phase: `orchestrate:${strategy}` })
  try {
    // AUTO-decomposition ('plan'): a PLANNER node emits the DISTINCT subtask list itself
    // (the model's own division of labour, vs the caller passing `subtasks`), THEN we fan
    // out over that list. The planner runs FIRST (one node, no tools); its subtasks replace
    // whatever was passed in and drive the branch count (clamped to MAX_BRANCHES). After
    // planning, the rest is exactly the 'parallel' fan-out path over the generated list.
    let effectiveSubtasks = subtasks
    let effectiveBranches = branches
    if (strategy === "plan") {
      const planned = await runPlanner({ ai, task, cap: MAX_BRANCHES, optsFor, budget, rootId, onEvent, usageOf: (g) => readUsageOf(g) })
      if (planned.length === 0) throw new Error("planner produced no subtasks")
      effectiveSubtasks = planned
      effectiveBranches = planned.length
    }

    // Branch i's task: its OWN subtask if the model supplied a distinct list, else the
    // shared `task` (parallel-same fallback). subtaskFor keeps the judge/verify message
    // (the overall `task`) separate from per-branch work.
    const subtaskFor = (i: number): string => effectiveSubtasks[i]?.trim() || task
    // BOUNDED fan-out: build n node thunks, run <= ORCH_CONCURRENCY at a time via
    // parallelLimit (the rest QUEUE) so a large branch count never hits CF all at once.
    // parallelLimit preserves input order and maps a failed slot to null; we coerce null
    // → "" and drop empties, exactly like the old Promise.all(.catch("")).filter path.
    const fanOut = (n: number): Promise<string[]> =>
      parallelLimit(
        Array.from({ length: n }, (_, i) =>
          () => nodeWorker({ ai, rootId, i, task: subtaskFor(i), persona: PERSONAS[i % PERSONAS.length]!, optsFor, budget, choice }),
        ),
        ORCH_CONCURRENCY,
      ).then((rs) => rs.map((r) => r ?? "").filter((r) => r.length > 0))

    // parallel / plan: fan out, return the joined replies (no judge/verify). For 'plan'
    // the fan-out is over the PLANNER-generated subtasks (each branch its own subtask), so
    // the reply is the numbered join of distinct per-subtask work — real auto division of
    // labour. We prepend the PLAN (the subtask list) so the caller sees the decomposition
    // alongside each branch's output.
    if (strategy === "parallel" || strategy === "plan") {
      const replies = await fanOut(effectiveBranches)
      if (replies.length === 0) throw new Error("all branches failed")
      const joined = replies.length === 1 ? replies[0]! : numbered(replies)
      const reply =
        strategy === "plan"
          ? `PLAN (${effectiveSubtasks.length} subtasks):\n${effectiveSubtasks.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\nRESULTS:\n${joined}`
          : joined
      onEvent({ type: "done", nodeId: rootId, result: { branches: replies.length } })
      return { reply, branches: replies.length }
    }

    // judge / best_of_n: fan out then one judge node picks the best verbatim. best_of_n
    // re-runs the fan-out until the surviving count converges (loopUntilDry), then judges.
    if (strategy === "judge" || strategy === "best_of_n") {
      const survivors =
        strategy === "best_of_n"
          ? await loopUntilDry(() => fanOut(branches), (p, n) => p.length === n.length, 2)
          : await fanOut(branches)
      if (survivors.length === 0) throw new Error("all branches failed")
      if (survivors.length === 1) {
        onEvent({ type: "done", nodeId: rootId, result: { branches: 1 } })
        return { reply: survivors[0]!, branches: 1 }
      }
      const judgeId = `${rootId}/judge`
      onEvent({ type: "start", nodeId: judgeId, parentId: rootId, phase: "judge" })
      const judgeGen = ax("message:string, candidates:string -> reply:string")
      judgeGen.setDescription(
        "You are an impartial judge. Given the task and several candidate answers (numbered), pick the single best answer and return it VERBATIM as your reply — do not blend or rewrite.",
      )
      try {
        const judged = await judge(ai, survivors, judgeGen, optsFor(), (cs) => ({
          message: task,
          candidates: numbered(cs as readonly string[]),
        }))
        budget.charge(readUsageOf(judgeGen))
        const reply = String((judged as { reply?: string }).reply ?? survivors[0]!)
        onEvent({ type: "done", nodeId: judgeId, result: clip(reply, 256) })
        onEvent({ type: "done", nodeId: rootId, result: { branches: survivors.length } })
        return { reply, branches: survivors.length }
      } catch (cause) {
        onEvent({ type: "error", nodeId: judgeId, cause })
        throw cause
      }
    }

    // verify: produce one answer (single node), then skeptics (the remaining branches)
    // vote accept/reject in parallel via adversarialVerify.
    const verifyId = `${rootId}/verify`
    onEvent({ type: "start", nodeId: verifyId, parentId: rootId, phase: "verify" })
    try {
      const skepticGen = ax("message:string, answer:string -> verdict:string")
      skepticGen.setDescription(
        "You are a skeptical reviewer. Decide whether the answer actually addresses the task. Reply with exactly one word: 'accept' or 'reject'.",
      )
      const nSkeptics = Math.max(1, branches - 1)
      const verdict = await adversarialVerify<string>(
        async () => {
          const [answer] = await fanOut(1)
          if (answer === undefined) throw new Error("producer branch failed")
          return answer
        },
        Array.from({ length: nSkeptics }, (_, i) => async (answer: string) => {
          const sid = `${rootId}/skeptic-${i}`
          onEvent({ type: "start", nodeId: sid, parentId: rootId, phase: `skeptic ${i + 1}` })
          try {
            const out = await runNode(
              { nodeId: sid, gen: skepticGen, opts: optsFor(), onEvent, budget, usageOf: (g) => readUsageOf(g) },
              ai,
              { message: task, answer },
            )
            return /accept/i.test(String((out as { verdict?: string }).verdict ?? ""))
          } catch {
            return false
          }
        }),
      )
      const tag = verdict.votes.length > 0 ? (verdict.accepted ? "accepted" : "rejected") : "unverified"
      const reply = `${verdict.value}\n\n— verification: ${tag} (${verdict.votes.filter(Boolean).length}/${verdict.votes.length} skeptics accepted)`
      onEvent({ type: "done", nodeId: verifyId, result: { accepted: verdict.accepted, votes: verdict.votes.length } })
      onEvent({ type: "done", nodeId: rootId, result: { accepted: verdict.accepted } })
      return { reply, branches: 1, accepted: verdict.accepted }
    } catch (cause) {
      onEvent({ type: "error", nodeId: verifyId, cause })
      throw cause
    }
  } catch (cause) {
    onEvent({ type: "error", nodeId: rootId, cause })
    throw cause
  }
}

// Normalize + validate the tool args into the resolved shape the fan-out needs.
// Extracted out of func() so the tool body stays under the cyclomatic budget: the
// ternary ladder (subtasks-vs-task branch count, strategy clamp, synthesized `overall`)
// is the bulk of the branching and is pure, so it lives here.
type NormalizedArgs = {
  task: string
  subtasks: string[]
  strategy: Strategy
  branches: number
  overall: string
}
const normalizeArgs = (args: {
  task: string
  subtasks?: string[]
  strategy?: string
  branches?: number
}): NormalizedArgs | string => {
  const task = String(args?.task ?? "").trim()
  // DISTINCT subtasks (division of labour) — the preferred path. Coerce to strings,
  // drop blanks. A non-empty list overrides the `task`-only parallel-same fallback
  // and DRIVES the branch count (clamped to MAX_BRANCHES); branch i works subtasks[i].
  const subtasks = (Array.isArray(args?.subtasks) ? args!.subtasks : [])
    .map((s) => String(s ?? "").trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_BRANCHES)
  // A non-empty task OR at least one subtask is required.
  if (task.length === 0 && subtasks.length === 0) return "error: rlm_workflow requires a non-empty task or subtasks"
  const strategy: Strategy = STRATEGIES.includes(args?.strategy as Strategy) ? (args!.strategy as Strategy) : "parallel"
  // BRANCH cap (guard 3): when subtasks are given, the list length wins (each branch
  // its own subtask); otherwise clamp the model's `branches` request to 1..MAX_BRANCHES.
  const branches =
    subtasks.length > 0
      ? subtasks.length
      : Math.min(MAX_BRANCHES, Math.max(1, Math.floor(Number(args?.branches ?? 2)) || 2))
  // The judge/verify message: the overall task, or — when only subtasks were given —
  // a synthesized statement of the whole, so the judge/skeptics see the full intent.
  const overall = task.length > 0 ? task : `Complete these subtasks: ${subtasks.map((s, i) => `(${i + 1}) ${s}`).join("; ")}`
  return { task, subtasks, strategy, branches, overall }
}

// RLM NODE-KIND short-circuit: strategy 'rlm' mines a BIG `context` blob in a code
// runtime (the blob is loaded into the AxJSRuntime, NEVER the prompt) instead of fanning
// sub-agents — `overall` is the query. ONE self-contained RLM node on the same event
// bus / trace as the fan-out strategies. Extracted so func() stays under budget.
const runRlmBranch = async (context: string, overall: string, ai: AxAIService, rootId: string, signal: AbortSignal): Promise<string> => {
  if (context.length === 0) return "error: rlm_workflow strategy 'rlm' requires a non-empty `context` (the big blob to mine; `task` is the query)"
  onEvent({ type: "start", nodeId: rootId, phase: "rlm_workflow:rlm" })
  try {
    const out = await otelContext.with(otelContext.active(), () => runRlm(context, overall, ai, rootId, signal))
    onEvent({ type: "done", nodeId: rootId, result: { turns: out.turns } })
    const evidence = out.evidence.length > 0 ? `\n\nEvidence:\n${out.evidence.map((e) => `- ${e}`).join("\n")}` : ""
    return clip(`${out.answer}${evidence}`)
  } catch (e) {
    onEvent({ type: "error", nodeId: rootId, cause: e })
    if (e instanceof BudgetExhaustedError) return `partial: the RLM hit its HARD token ceiling (${e.spent}/${e.total}) and was stopped. ${e.reason}.`
    return `rlm_workflow (rlm) failed: ${String((e as { message?: string })?.message ?? e).slice(0, 500)}`
  }
}

// ── Tool 1: orchestrate ────────────────────────────────────────────────────────────
const rlmWorkflowTool: AxFunction = {
  name: "rlm_workflow",
  description:
    "Fan a task out across parallel sub-agent NODES (each carrying the file/shell tools) and combine the results. WHEN TO USE: the work splits into INDEPENDENT parts (division of labour), OR you want the best-of-N / a verified answer. WHEN NOT: a trivial or strictly sequential chore — do that directly yourself; do NOT fan out a one-liner. EXAMPLE (division of labour): rlm_workflow({ subtasks: ['audit src/auth for bugs', 'check the tests cover edge cases', 'review error handling'] }) — branch i works subtasks[i], real distinct work. EXAMPLE (best of N): rlm_workflow({ task: 'design a token-bucket rate limiter', strategy: 'judge', branches: 3 }). EXAMPLE (auto-decompose): rlm_workflow({ task: 'refactor the auth module', strategy: 'plan' }) — a PLANNER node splits the task into distinct subtasks itself, then fans out one node per subtask and returns the plan + each branch's output. PARAMS: task (the overall goal); subtasks (PREFERRED — a list of DISTINCT, independent pieces; branch i gets subtasks[i] and the list length drives the branch count); strategy (default 'parallel': 'parallel' fan out + return all, 'judge' fan out then one judge picks the best verbatim, 'verify' answer once then skeptics vote accept/reject, 'best_of_n' re-run the fan-out until the survivor count is stable then judge, 'plan' planner auto-decomposes then fans out, 'rlm' does NOT fan out — it mines a BIG `context` blob in a code runtime kept OUT of the prompt with `task` as the query, for a huge file/log that won't fit the window); context (strategy 'rlm' ONLY: the big blob to mine); branches (1-100, default 2; ignored when subtasks is given); model ('kimi' default | 'glm') and effort ('low'..'max') route the sub-agents per node. EXAMPLE (mine a huge blob): rlm_workflow({ strategy: 'rlm', context: '<the entire 12k-line bundle.js>', task: 'which function registers the /auth route?' }). RULE: give DISTINCT subtasks, NOT N copies — only omit subtasks (run `task` on every branch) when you genuinely want N redundant attempts (e.g. best_of_n). branches caps at 100 (~8 run at once; the rest queue). Sub-agents CANNOT themselves orchestrate (one level deep).",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "the overall task; also the per-branch task in the parallel-same fallback when no subtasks are given" },
      subtasks: {
        type: "array",
        items: { type: "string" },
        description: "PREFERRED: a list of DISTINCT, independent subtasks (division of labour). Branch i gets subtasks[i]; the number of branches follows this list (capped at 100; at most ~8 run at once, the rest queue). Omit only when you want N redundant attempts at the same task.",
      },
      strategy: {
        type: "string",
        enum: ["parallel", "judge", "verify", "best_of_n", "plan", "rlm"],
        description: "how to combine the sub-agents (default 'parallel'). 'plan' AUTO-decomposes `task` into subtasks via a planner node, then fans out one sub-agent per subtask. 'rlm' does NOT fan out — it mines a BIG `context` blob in a code runtime (kept OUT of the prompt) with `task` as the query.",
      },
      context: { type: "string", description: "strategy 'rlm' ONLY: the LARGE text blob to mine (a long file, pasted log, whole concatenated module). It is loaded into a code runtime, NOT the prompt; the RLM actor writes JS to explore it and answers `task`." },
      branches: { type: "number", description: "number of parallel sub-agents (1-100, default 2; at most ~8 run at once, the rest queue); ignored when subtasks is given (the list length wins)" },
      model: { type: "string", description: "MULTI-MODEL: which model the sub-agents run on — 'kimi' (Kimi K2.7, the default) or 'glm' (GLM 5.2). Both are thinking models on the same endpoint. Omit to use the default (kimi)." },
      effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "MULTI-MODEL: thinking level for the sub-agents (provider reasoning hint). Omit for the model default." },
    },
    required: ["task"],
  },
  func: async (
    args: { task: string; subtasks?: string[]; strategy?: string; branches?: number; model?: string; effort?: string; context?: string },
    extra?: Readonly<{ sessionId?: string; ai?: AxAIService; abortSignal?: AbortSignal }>,
  ) => {
    const norm = normalizeArgs(args)
    if (typeof norm === "string") return norm // validation error string
    const { strategy, subtasks, branches, overall } = norm
    const ai = extra?.ai ?? llm
    const sessionId = extra?.sessionId ?? "tool"
    const signal = signalOf(extra)
    const rootId = `orch-tool:${sessionId}:${Date.now()}`
    // strategy 'rlm' short-circuits before the fan-out boundary (mines a blob, no sub-agents).
    if (strategy === "rlm") return runRlmBranch(String(args?.context ?? ""), overall, ai, rootId, signal)
    const { optsFor, budget } = boundary(sessionId, signal, rootId)
    const choice = choiceFromArgs({ model: args?.model, effort: args?.effort }) // MULTI-MODEL: no model/effort ⇒ default Kimi
    try {
      const out = await otelContext.with(otelContext.active(), () =>
        runRlmWorkflow({ ai, strategy, task: overall, subtasks, branches, optsFor, budget, rootId, choice }),
      )
      // COST-METER: append a usage footer (… · N branches · Xk tok [· ~$cost]) so the
      // model — and whoever reads the tool result — sees what the fan-out actually cost.
      const spent = await budget.spent()
      return clip(`${out.reply}\n\n· ${costMeterSummary(out.branches, spent)}`)
    } catch (e) {
      // BUDGET ceiling (guard 2): the soft budget is ADVISORY (never throws — a completed
      // node is always returned, see runRlmWorkflow/runNode). So this only fires for a
      // genuine RUNAWAY (the HARD ceiling) or an explicit freeze() — return a PARTIAL string
      // rather than throwing the whole turn. spent()/total surface that the sub-run was capped.
      if (e instanceof BudgetExhaustedError) {
        return `partial: the orchestration hit its HARD runaway token ceiling (${e.spent}/${e.total}) and was stopped. ${e.reason}.`
      }
      return `orchestration failed: ${String((e as { message?: string })?.message ?? e).slice(0, 500)}`
    }
  },
}

// The agent-callable orchestration tool — added to the MAIN chat gen ONLY (agent.ts),
// never to a sub-run node gen (nodes carry BASE_TOOLS), so the one-level recursion guard holds.
export const RLM_WORKFLOW_TOOLS: AxFunction[] = [rlmWorkflowTool]
