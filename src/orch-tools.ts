// Agent-callable ORCHESTRATION tools — the agent SELF-orchestrates. The model, mid-
// turn, decides to fan out / judge / verify / best-of-N over a sub-task (`orchestrate`)
// or to load + run a saved .ax/orch/<name> script (`run_orch_script`). Both run the
// EXISTING engine (the 5 prims in orch.ts + the 4 recipes in orch-recipes.ts) — this
// file adds NO 6th core primitive; it only composes what is already there.
//
// THE SAFETY MODEL (an LLM that can spawn fan-outs that spawn fan-outs = runaway cost):
//   1. STRUCTURAL one-level recursion guard: every sub-run WORKER LEAF gen (the nodes that
//      actually loop file/shell tools — see leafGen/worker) is built with BASE_TOOLS only
//      (file tools), NEVER BASE_TOOLS+ORCH_TOOLS. So a worker leaf physically cannot call
//      orchestrate/run_orch_script again. Structural, not a depth counter (counters race
//      under parallel()). The judge (line ~157) and skeptic (line ~182) gens are EXEMPT:
//      they are pure reasoning nodes — they pick/vote over already-produced candidate text
//      and never loop tools — so they carry NO functions at all (not even BASE_TOOLS).
//      Giving them ZERO tools is strictly stronger than the BASE_TOOLS-only guard, so the
//      one-level recursion contract holds a fortiori for them.
//   2. BUDGET ceiling (ADVISORY/soft): each self-orchestration runs under its OWN
//      allocate(SOFT, HARD). The SOFT line (AX2_ORCH_TOKEN_BUDGET) only NUDGES — a leaf
//      that did real work is ALWAYS returned, never discarded for crossing it. Only the
//      HARD ceiling (AX2_ORCH_TOKEN_HARD, a very high runaway backstop) throws
//      BudgetExhaustedError → a PARTIAL result string. maxSteps is the per-leaf hard stop.
//   3. BRANCH cap: orchestrate clamps the model's requested branch count to <= 4.
//   4. abortSignal: extra.abortSignal threads into every LeafOpts, so a cancelled turn
//      cancels the whole sub-run (ax honors it in forward()).
//
// CONTEXT/TRACE: a tool handler runs Promise-native INSIDE forward(), which turn() runs
// inside otelContext.with(traceContext) (agent.ts). So otelTrace.getActiveSpan() (read by
// emit()/onEvent) resolves to the live chat.turn span and sub-run NodeEvents render in the
// SAME OrchTree, nested under the turn's span — one trace per session stays intact. No new
// Effect boundary is needed here; we read the ambient tracer/context synchronously.
import { ax, AxMemory, type AxAIService, type AxFunction, type AxGen } from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import { BASE_PROMPT, limits, llm, onEvent, readUsageOf } from "./runtime.ts"
import { adversarialVerify, agent, judge, loopUntilDry } from "./orch-recipes.ts"
import { allocate, type Budget, BudgetExhaustedError, type LeafOpts } from "./orch.ts"
import { type OrchLoadCtx, runLoadedScript } from "./orch-load.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"
import { BASE_TOOLS } from "./tools.ts"

// Per-self-orchestration SOFT token ceiling, SHARED across the sub-run's branches. This
// is the ADVISORY nudge line — crossing it logs/nudges but NEVER discards a completed
// leaf (the root-cause fix: the old hard model threw BudgetExhaustedError after a leaf
// finished and the empty-string discard nuked its real work). A real exploration leaf
// spends 70k–400k tokens, so ~2M is a sane "this run is getting big" marker.
const ORCH_TOKEN_BUDGET = Number(process.env.AX2_ORCH_TOKEN_BUDGET ?? 2_000_000)

// HARD runaway backstop — the ONLY ceiling that aborts (BudgetExhaustedError). Very high
// (~20M) so it never trips a single genuine leaf/fan-out; it only catches a true runaway
// loop. maxSteps (limits.maxSteps, ax-enforced per leaf forward) is the real per-leaf stop.
const ORCH_TOKEN_HARD = Number(process.env.AX2_ORCH_TOKEN_HARD ?? 20_000_000)

// ponytail: ONE shared soft+hard ceiling across concurrent branches — a greedy branch can
// starve the others' headroom. Upgrade: per-branch budgets (allocate per worker) so fan-out
// is fair.

// BRANCH cap — hard upper bound on parallel leaves, regardless of what the model asks.
const MAX_BRANCHES = 4

const STRATEGIES = ["parallel", "judge", "verify", "best_of_n"] as const
type Strategy = (typeof STRATEGIES)[number]

const clip = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s)

// Pull a usable abortSignal out of extra, or fall back to a never-aborted one so a
// missing signal never crashes the handler.
const signalOf = (extra: { abortSignal?: AbortSignal } | undefined): AbortSignal =>
  extra?.abortSignal ?? new AbortController().signal

// Build the SHARED boundary state for a self-orchestration: the FORKED-memory LeafOpts
// factory (a fresh AxMemory per call → concurrent leaves never share a mutating history),
// a fresh Budget at the ORCH ceiling, and a stable rootId the sub-run nests under. tracer
// + traceContext are read from the AMBIENT OTel context (the live chat.turn span set by
// turn()), so sub-run spans/events land in the session's one trace.
const boundary = (sessionId: string, signal: AbortSignal, rootId: string) => {
  const tracer = otelTrace.getTracer(SERVICE_NAME, SERVICE_VERSION)
  const traceContext = otelContext.active()
  const optsFor = (): LeafOpts => ({
    mem: new AxMemory(),
    sessionId,
    tracer,
    traceContext,
    maxSteps: limits.maxSteps,
    stream: false,
    abortSignal: signal,
  })
  const budget = allocate(ORCH_TOKEN_BUDGET, ORCH_TOKEN_HARD)
  return { optsFor, budget, rootId }
}

// A sub-run leaf gen — a REAL sub-agent: the SAME capable system prompt as the main
// agent (BASE_PROMPT from runtime.ts) so a leaf is as capable as the main agent MINUS
// orchestration, with the caller's `persona` appended as an OVERLAY (not the whole
// prompt — the old thin one-line persona crippled leaves). It carries BASE_TOOLS ONLY
// (NOT ORCH_TOOLS / no ORCH_OVERLAY) — the structural one-level recursion guard: a leaf
// physically cannot re-orchestrate. A fresh AxGen per call (never shared across
// concurrent branches) so each leaf's getUsage() is its own, keeping budget charging
// crisp. BASE_PROMPT is imported from runtime.ts (the neutral cycle-breaker module),
// NOT agent.ts — so a leaf gets the main agent's capable prompt without re-introducing
// the agent ⇄ orch-tools static init cycle.
// Terse tool-scoping overlay for a leaf — mirrors claude_code's Explore agent prompt
// (a short bulleted list of the leaf's tools + usage priorities). Appended AFTER the
// persona so a leaf knows exactly what it has and how to use it, without bloating the
// prompt. A leaf is one level deep: it canNOT orchestrate (BASE_TOOLS only, structural).
const LEAF_TOOL_SCOPE = [
  "Your tools: glob (find files by pattern), grep (search file contents), read_file (read a known path),",
  "write_file / edit_file (modify files), bash (run real commands).",
  "Prefer glob/grep to LOCATE before reading; read_file before you edit_file; run real bash commands to VERIFY.",
  "You are a single-level sub-agent: do the task end-to-end yourself — you canNOT orchestrate or spawn more sub-agents.",
].join(" ")

const leafGen = (persona: string): AxGen => {
  const g = ax("message:string -> reply:string", { functions: BASE_TOOLS })
  g.setDescription(`${BASE_PROMPT} ${persona} ${LEAF_TOOL_SCOPE}`)
  return g
}

// One bracketed worker leaf over `task`, charged to the shared budget. nodeId nests it
// under rootId in the live tree.
type WorkerOpts = {
  ai: AxAIService
  rootId: string
  i: number
  task: string
  persona: string
  optsFor: () => LeafOpts
  budget: Budget
}
const worker = ({ ai, rootId, i, task, persona, optsFor, budget }: WorkerOpts): Promise<string> => {
  const nodeId = `${rootId}/branch-${i}`
  // agent() emits the single start (with parentId+label) and the done/error — no
  // double-emit here, which previously overwrote the "branch N" label with "agent".
  // The persona is an OVERLAY on BASE_PROMPT (leafGen prepends the full main-agent
  // system prompt); the leaf is already told it has the file tools, so the overlay
  // is just a stance, not a re-statement of its capabilities.
  //
  // The branch LABEL (phase) reflects this branch's OWN subtask (clipped), not a
  // generic "branch N" — so the live tree shows the division of labour, and a
  // decompose run reads as distinct work per node rather than N identical attempts.
  const gen = leafGen(persona)
  return agent(
    { nodeId, parentId: rootId, phase: `branch ${i + 1}: ${clip(task, 48)}`, gen, opts: optsFor(), onEvent, budget, usageOf: (g) => readUsageOf(g) },
    ai,
    { message: task },
  ).then((o) => String((o as { reply?: string }).reply ?? ""))
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
// Every node emits through onEvent → the OrchTree. The budget is ADVISORY: a leaf over
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
  optsFor: () => LeafOpts
  budget: Budget
  rootId: string
}
const runOrchestration = async ({
  ai,
  strategy,
  task,
  subtasks,
  branches,
  optsFor,
  budget,
  rootId,
}: OrchestrationOpts): Promise<{ reply: string; branches: number; accepted?: boolean }> => {
  onEvent({ type: "start", nodeId: rootId, phase: `orchestrate:${strategy}` })
  try {
    // Branch i's task: its OWN subtask if the model supplied a distinct list, else the
    // shared `task` (parallel-same fallback). subtaskFor keeps the judge/verify message
    // (the overall `task`) separate from per-branch work.
    const subtaskFor = (i: number): string => subtasks[i]?.trim() || task
    const fanOut = (n: number): Promise<string[]> =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          worker({ ai, rootId, i, task: subtaskFor(i), persona: PERSONAS[i % PERSONAS.length]!, optsFor, budget }).catch(() => ""),
        ),
      ).then((rs) => rs.filter((r) => r.length > 0))

    // parallel: fan out, return the joined replies (no judge/verify).
    if (strategy === "parallel") {
      const replies = await fanOut(branches)
      if (replies.length === 0) throw new Error("all branches failed")
      const reply = replies.length === 1 ? replies[0]! : numbered(replies)
      onEvent({ type: "done", nodeId: rootId, result: { branches: replies.length } })
      return { reply, branches: replies.length }
    }

    // judge / best_of_n: fan out then one judge leaf picks the best verbatim. best_of_n
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

    // verify: produce one answer (single worker), then skeptics (the remaining branches)
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
            const out = await agent(
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

// ── Tool 1: orchestrate ────────────────────────────────────────────────────────────
const orchestrateTool: AxFunction = {
  name: "orchestrate",
  description:
    "Decompose a task into DISTINCT subtasks and run each on its OWN parallel sub-agent (each with the file/shell tools) — real division of labour, not redundant attempts. PREFER passing `subtasks`: a list of DIFFERENT, independent pieces of the work (e.g. ['audit src/auth for bugs', 'check the tests cover edge cases', 'review error handling']); branch i works subtasks[i], `branches` follows the list length. If you only pass `task` (no subtasks), every branch runs the SAME task (parallel-same fallback — use only when you genuinely want N redundant attempts, e.g. best_of_n). strategy: 'parallel' (fan out, return all), 'judge' (fan out, pick the best), 'verify' (answer once, skeptics vote), 'best_of_n' (re-run fan-out until stable, then judge). branches caps at 4. Returns the synthesized result. Sub-agents CANNOT themselves orchestrate (one level deep).",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "the overall task; also the per-branch task in the parallel-same fallback when no subtasks are given" },
      subtasks: {
        type: "array",
        items: { type: "string" },
        description: "PREFERRED: a list of DISTINCT, independent subtasks (division of labour). Branch i gets subtasks[i]; the number of branches follows this list (capped at 4). Omit only when you want N redundant attempts at the same task.",
      },
      strategy: {
        type: "string",
        enum: ["parallel", "judge", "verify", "best_of_n"],
        description: "how to combine the sub-agents (default 'parallel')",
      },
      branches: { type: "number", description: "number of parallel sub-agents (1-4, default 2); ignored when subtasks is given (the list length wins)" },
    },
    required: ["task"],
  },
  func: async (
    args: { task: string; subtasks?: string[]; strategy?: string; branches?: number },
    extra?: Readonly<{ sessionId?: string; ai?: AxAIService; abortSignal?: AbortSignal }>,
  ) => {
    const task = String(args?.task ?? "").trim()
    // DISTINCT subtasks (division of labour) — the preferred path. Coerce to strings,
    // drop blanks. A non-empty list overrides the `task`-only parallel-same fallback
    // and DRIVES the branch count (clamped to MAX_BRANCHES); branch i works subtasks[i].
    const subtasks = (Array.isArray(args?.subtasks) ? args!.subtasks : [])
      .map((s) => String(s ?? "").trim())
      .filter((s) => s.length > 0)
      .slice(0, MAX_BRANCHES)
    // A non-empty task OR at least one subtask is required.
    if (task.length === 0 && subtasks.length === 0) return "error: orchestrate requires a non-empty task or subtasks"
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
    const ai = extra?.ai ?? llm
    const sessionId = extra?.sessionId ?? "tool"
    const signal = signalOf(extra)
    const rootId = `orch-tool:${sessionId}:${Date.now()}`
    const { optsFor, budget } = boundary(sessionId, signal, rootId)
    try {
      const out = await otelContext.with(otelContext.active(), () =>
        runOrchestration({ ai, strategy, task: overall, subtasks, branches, optsFor, budget, rootId }),
      )
      return clip(out.reply)
    } catch (e) {
      // BUDGET ceiling (guard 2): the soft budget is ADVISORY (never throws — a completed
      // leaf is always returned, see runOrchestration/agent). So this only fires for a
      // genuine RUNAWAY (the HARD ceiling) or an explicit freeze() — return a PARTIAL string
      // rather than throwing the whole turn. spent()/total surface that the sub-run was capped.
      if (e instanceof BudgetExhaustedError) {
        return `partial: the orchestration hit its HARD runaway token ceiling (${e.spent}/${e.total}) and was stopped. ${e.reason}.`
      }
      return `orchestration failed: ${String((e as { message?: string })?.message ?? e).slice(0, 500)}`
    }
  },
}

// ── Tool 2: run_orch_script ────────────────────────────────────────────────────────
const runOrchScriptTool: AxFunction = {
  name: "run_orch_script",
  description:
    "Load and run a saved orchestration script from .ax/orch/<name> (trusted dir; paths escaping it are rejected) against an optional message. The script composes the engine prims { leaf, parallel, pipeline, emit, allocate, gen } + recipes { agent, judge, loopUntilDry, adversarialVerify }. Author one with write_file to .ax/orch/<name>.ts exporting orchestrate(ctx, prims), then run it here. Returns the script's result.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "bare script name under .ax/orch/ (no directories)" },
      message: { type: "string", description: "optional input message passed to the script" },
    },
    required: ["name"],
  },
  func: async (
    args: { name: string; message?: string },
    extra?: Readonly<{ sessionId?: string; ai?: AxAIService; abortSignal?: AbortSignal }>,
  ) => {
    const name = String(args?.name ?? "").trim()
    if (name.length === 0) return "error: run_orch_script requires a script name"
    const message = String(args?.message ?? "")
    const ai = extra?.ai ?? llm
    const sessionId = extra?.sessionId ?? "tool"
    const signal = signalOf(extra)
    const rootId = `orch-tool:${sessionId}:${name}:${Date.now()}`
    const { optsFor, budget } = boundary(sessionId, signal, rootId)
    const ctx: OrchLoadCtx = {
      sessionId,
      message,
      rootId,
      ai,
      model: "",
      budget,
      onEvent,
      optsFor,
      usageOf: readUsageOf,
    }
    try {
      // resolveScript inside runLoadedScript rejects any path that escapes .ax/orch/ —
      // the trusted-dir guard is reused, not reimplemented. (ponytail below.)
      const out = await otelContext.with(otelContext.active(), () => runLoadedScript(name, ctx))
      return clip(out.reply)
    } catch (e) {
      // ADVISORY budget: only a HARD-ceiling runaway (or freeze) throws — a completed leaf
      // is always returned. So this is the runaway backstop, not a per-leaf guillotine.
      if (e instanceof BudgetExhaustedError) {
        return `partial: the script hit its HARD runaway token ceiling (${e.spent}/${e.total}) and was stopped. ${e.reason}.`
      }
      return `script failed: ${String((e as { message?: string })?.message ?? e).slice(0, 500)}`
    }
  },
}

// The two agent-callable orchestration tools. Added to the MAIN chat gen ONLY
// (agent.ts) — never to a sub-run leaf gen (which carries BASE_TOOLS), so the structural
// one-level recursion guard holds.
//
// ponytail: in-process trust. run_orch_script dynamic-import()s a .ax/orch/ module and
// orchestrate spawns leaves that run the file/shell tools — all with the host process's
// FULL authority (fs/net/process). The boundary today is structural (BASE_TOOLS-only
// leaves can't re-orchestrate) + the trusted-dir path-escape guard (orch-load.resolveScript)
// + the per-sub-run token Budget — NOT a real sandbox. Ceiling: an LLM-chosen task or an
// LLM-authored .ax/orch/ script can do anything the agent process can. Upgrade: execute
// untrusted orchestration JS in an isolate via AxJSRuntime — the @ax-llm/ax sandbox over a
// Bun smol Worker (`new AxJSRuntime({ permissions: [], outputMode: "return",
// blockDynamicImport: true, freezeIntrinsics: true })`, ctor at
// node_modules/@ax-llm/ax/index.d.ts:10346; AxJSRuntimePermission enum at :10296) or the
// axCreateJSRuntime() factory (:10489) — session.eval the script text instead of import().
export const ORCH_TOOLS: AxFunction[] = [orchestrateTool, runOrchScriptTool]
