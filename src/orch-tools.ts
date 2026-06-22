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
//   2. BUDGET ceiling: each self-orchestration runs under its OWN allocate(ORCH_BUDGET)
//      (AX2_ORCH_TOKEN_BUDGET, default ~40k). On BudgetExhaustedError we return a PARTIAL
//      result string to the model rather than throwing the whole turn.
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
import { limits, llm, onEvent, readUsageOf } from "./agent.ts"
import { adversarialVerify, agent, judge, loopUntilDry } from "./orch-recipes.ts"
import { allocate, type Budget, BudgetExhaustedError, type LeafOpts } from "./orch.ts"
import { type OrchLoadCtx, runLoadedScript } from "./orch-load.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"
import { BASE_TOOLS } from "./tools.ts"

// Per-self-orchestration token ceiling. Distinct from the per-turn TOKEN_BUDGET: a
// self-orch sub-run gets its OWN smaller cap so a tool call can't burn the whole turn.
const ORCH_TOKEN_BUDGET = Number(process.env.AX2_ORCH_TOKEN_BUDGET ?? 40_000)

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
  const budget = allocate(ORCH_TOKEN_BUDGET)
  return { optsFor, budget, rootId }
}

// A sub-run leaf gen: the SAME signature as the chat gen, but carrying BASE_TOOLS ONLY —
// the structural recursion guard. A fresh AxGen per call (never shared across concurrent
// branches) so each leaf's getUsage() is its own, keeping budget charging crisp.
const leafGen = (description: string): AxGen => {
  const g = ax("message:string -> reply:string", { functions: BASE_TOOLS })
  g.setDescription(description)
  return g
}

// One bracketed worker leaf over `task`, charged to the shared budget. nodeId nests it
// under rootId in the live tree.
const worker = (
  ai: AxAIService,
  rootId: string,
  i: number,
  task: string,
  persona: string,
  optsFor: () => LeafOpts,
  budget: Budget,
): Promise<string> => {
  const nodeId = `${rootId}/branch-${i}`
  onEvent({ type: "start", nodeId, parentId: rootId, phase: `branch ${i + 1}` })
  const gen = leafGen(
    `${persona} You are a capable coding agent with file/shell tools (bash, read_file, write_file, edit_file, glob, grep, web_fetch). Use them to do real work before answering. Reply concisely in GitHub-flavored markdown.`,
  )
  return agent(
    { nodeId, gen, opts: optsFor(), onEvent, budget, usageOf: (g) => readUsageOf(g) },
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
// Every node emits through onEvent → the OrchTree. Budget breaches bubble as
// BudgetExhaustedError, caught by the handler for a partial return.
const runOrchestration = async (
  ai: AxAIService,
  strategy: Strategy,
  task: string,
  branches: number,
  optsFor: () => LeafOpts,
  budget: Budget,
  rootId: string,
): Promise<{ reply: string; branches: number; accepted?: boolean }> => {
  onEvent({ type: "start", nodeId: rootId, phase: `orchestrate:${strategy}` })
  try {
    const fanOut = (n: number): Promise<string[]> =>
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          worker(ai, rootId, i, task, PERSONAS[i % PERSONAS.length]!, optsFor, budget).catch(() => ""),
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
    "Decompose a sub-task and run it across multiple parallel sub-agents (each with the file/shell tools), then optionally judge or verify the results. Use for hard sub-problems where fanning out and comparing/judging beats a single attempt. strategy: 'parallel' (fan out, return all), 'judge' (fan out, pick the best), 'verify' (answer once, skeptics vote), 'best_of_n' (re-run fan-out until stable, then judge). branches caps at 4. Returns the synthesized result. Sub-agents CANNOT themselves orchestrate (one level deep).",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "the sub-task for the sub-agents to work on" },
      strategy: {
        type: "string",
        enum: ["parallel", "judge", "verify", "best_of_n"],
        description: "how to combine the sub-agents (default 'parallel')",
      },
      branches: { type: "number", description: "number of parallel sub-agents (1-4, default 2)" },
    },
    required: ["task"],
  },
  func: async (
    args: { task: string; strategy?: string; branches?: number },
    extra?: Readonly<{ sessionId?: string; ai?: AxAIService; abortSignal?: AbortSignal }>,
  ) => {
    const task = String(args?.task ?? "").trim()
    if (task.length === 0) return "error: orchestrate requires a non-empty task"
    const strategy: Strategy = STRATEGIES.includes(args?.strategy as Strategy) ? (args!.strategy as Strategy) : "parallel"
    // BRANCH cap (guard 3): clamp the model's request to 1..MAX_BRANCHES.
    const branches = Math.min(MAX_BRANCHES, Math.max(1, Math.floor(Number(args?.branches ?? 2)) || 2))
    const ai = extra?.ai ?? llm
    const sessionId = extra?.sessionId ?? "tool"
    const signal = signalOf(extra)
    const rootId = `orch-tool:${sessionId}:${Date.now()}`
    const { optsFor, budget } = boundary(sessionId, signal, rootId)
    try {
      const out = await otelContext.with(otelContext.active(), () =>
        runOrchestration(ai, strategy, task, branches, optsFor, budget, rootId),
      )
      return clip(out.reply)
    } catch (e) {
      // BUDGET ceiling (guard 2): a breach returns a PARTIAL result string — never throws
      // the whole turn. spent()/total surface so the model knows the sub-run was capped.
      if (e instanceof BudgetExhaustedError) {
        return `partial: the orchestration hit its token budget (${e.spent}/${e.total}) and was stopped before finishing. ${e.reason}.`
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
      if (e instanceof BudgetExhaustedError) {
        return `partial: the script hit its token budget (${e.spent}/${e.total}) and was stopped. ${e.reason}.`
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
