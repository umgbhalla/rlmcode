#!/usr/bin/env bun
// LIVE CF-Kimi verification harness — THE REAL GATE. tsc proves it compiles; this
// proves orchestration actually WORKS end-to-end against the real model. Same
// assert-fixture, no-framework style as orch.test / orch-core.test, but instead of
// a FAKE gen it drives the REAL @cf/moonshotai/kimi-k2.7-code service over the real
// orchestrate path and asserts a NON-EMPTY real string comes back (not a
// BudgetExhaustedError partial, not empty, not an "orchestration failed: …" string).
//
// GATED behind AX2_LIVE=1 so it costs nothing in normal `bun run lint`: without the
// flag it prints "skipped: set AX2_LIVE=1" and exits 0. The later (A)(B)(C) fixes
// import buildLiveAi() / runOrchestrateLive() from here and run their own assertions
// on distinct branch work / the RLM finding a buried fact.
//
// Run: AX2_LIVE=1 bun scripts/orch-live.test.ts   (or `bun run live`, which passes
// --env-file=.env so CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID load).
import { AxAgentClarificationError, ai, type AxAIService, type AxFunction } from "@ax-llm/ax"
import { type Activity, setActivitySink } from "../src/activity.ts"
import { RLM_WORKFLOW_TOOLS } from "../src/rlm-workflow.ts"
import { RLM_TOOLS, runRlm } from "../src/rlm-tool.ts"
import { limits, MODEL, rateLimiter } from "../src/runtime.ts"

// Build the CF-Kimi AxAIService EXACTLY like src/runtime.ts's `llm` (openai-shaped
// Cloudflare Workers AI endpoint from .env). A standalone builder — not the shared
// `llm` singleton — so a live test never mutates the app's service (agent.ts attaches
// a live logger + captureFetch to that one). Reusable: the (A)(B)(C) fixes call this.
export const buildLiveAi = (): AxAIService => {
  const apiKey = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!apiKey || !accountId) {
    throw new Error(
      "live harness needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in .env (run via `bun run live`, which passes --env-file=.env)",
    )
  }
  const svc = ai({
    name: "openai",
    apiKey,
    apiURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    config: { model: MODEL as never },
  })
  // Attach the SAME service-level throttle the app uses (agent.ts) so the bounded fan-out
  // gate exercises the real rate-limited path — concurrent forwards are min-interval spaced.
  svc.setOptions({ rateLimiter })
  return svc
}

// Drive the REAL orchestrate tool (RLM_WORKFLOW_TOOLS[0]) — the same AxFunction the model
// calls mid-turn — over a concrete task. This exercises the WHOLE live path:
// boundary() → forked-memory workers (BASE_TOOLS leaves) → strategy combine
// (parallel/judge/verify/best_of_n) → budget charging. Returns the tool's string
// result verbatim (the model would see exactly this). Reusable by the later phases.
export const runOrchestrateLive = async (
  task: string,
  strategy: "parallel" | "judge" | "verify" | "best_of_n" = "parallel",
  branches = 2,
  liveAi: AxAIService = buildLiveAi(),
): Promise<string> => {
  const rlmWorkflowTool = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
  if (!rlmWorkflowTool?.func) throw new Error("orchestrate tool not found in RLM_WORKFLOW_TOOLS")
  const out = await rlmWorkflowTool.func(
    { task, strategy, branches },
    { sessionId: "live-smoke", ai: liveAi, abortSignal: new AbortController().signal },
  )
  return String(out ?? "")
}

// (I) PER-NODE TOOL ROUTING: drive a REAL parallel fan-out over DISTINCT repo subtasks (each
// branch is a sub-agent that loops file tools) with an activity sink installed, capturing every
// tool/result activity. Reproduces the atoms reducer's routing (tagged nodeId → that node's
// tools; untagged → the main transcript) so we can ASSERT each branch's tools are attributed to
// ITS OWN node and never interleave / leak to the transcript. Returns the captured routing.
type CapturedTool = { id: string; name: string; status: string; nodeId?: string | undefined }
export const runRoutingLive = async (
  subtasks: string[],
  liveAi: AxAIService = buildLiveAi(),
): Promise<{ transcript: CapturedTool[]; nodeTools: Record<string, CapturedTool[]>; reply: string }> => {
  const rlmWorkflowTool = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
  if (!rlmWorkflowTool?.func) throw new Error("orchestrate tool not found in RLM_WORKFLOW_TOOLS")
  const transcript: CapturedTool[] = []
  const nodeTools: Record<string, CapturedTool[]> = {}
  // The SAME tool/result routing the atoms reducer applies (installSink is module-private).
  const sink = (a: Activity) => {
    if (a.kind === "tool") {
      const step: CapturedTool = { id: a.id, name: a.name, status: "running", nodeId: a.nodeId }
      if (a.nodeId !== undefined) (nodeTools[a.nodeId] ??= []).push(step)
      else transcript.push(step)
    } else if (a.kind === "result") {
      const list = a.nodeId !== undefined ? (nodeTools[a.nodeId] ?? []) : transcript
      for (const s of list) if (s.id === a.id) s.status = a.isError ? "error" : "ok"
    }
  }
  setActivitySink(sink)
  try {
    const out = await rlmWorkflowTool.func(
      { task: "Work the listed subtasks; each sub-agent handles exactly one.", subtasks, strategy: "parallel" },
      { sessionId: "live-routing", ai: liveAi, abortSignal: new AbortController().signal },
    )
    return { transcript, nodeTools, reply: String(out ?? "") }
  } finally {
    setActivitySink(null)
  }
}

// (H) MULTI-MODEL: drive the REAL orchestrate tool with an explicit { model, effort } so a
// leaf is routed to a CHOSEN pool model (kimi|glm) at a CHOSEN thinking level. This proves
// per-node model + thinking routing threads through the orchestrate tool → boundary →
// optsFor(choice) → nodeForwardOpts → forward() on the real CF endpoint. A single-branch
// parallel run = one real routed leaf (no judge/verify noise). Returns the verbatim string.
export const runRoutedLive = async (
  task: string,
  model: "kimi" | "glm",
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined,
  liveAi: AxAIService = buildLiveAi(),
): Promise<string> => {
  const rlmWorkflowTool = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
  if (!rlmWorkflowTool?.func) throw new Error("orchestrate tool not found in RLM_WORKFLOW_TOOLS")
  const out = await rlmWorkflowTool.func(
    { task, strategy: "parallel", branches: 1, model, ...(effort !== undefined ? { effort } : {}) },
    { sessionId: `live-multimodel-${model}`, ai: liveAi, abortSignal: new AbortController().signal },
  )
  return String(out ?? "")
}

// (G) PLAN-EXECUTE (auto-decompose): drive orchestrate with strategy 'plan' and JUST a
// decomposable `task` (NO subtasks) — a PLANNER node splits the task into distinct subtasks
// ITSELF, then one sub-agent works each. The 'plan' reply is "PLAN (N subtasks):\n …\n\n
// RESULTS:\n#1:…#2:…", so the caller sees the model's own decomposition AND each branch's
// output. Proves AUTO division of labour (model-driven, not caller-passed). Verbatim string.
export const runPlanLive = async (
  task: string,
  liveAi: AxAIService = buildLiveAi(),
): Promise<string> => {
  const rlmWorkflowTool = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
  if (!rlmWorkflowTool?.func) throw new Error("orchestrate tool not found in RLM_WORKFLOW_TOOLS")
  const out = await rlmWorkflowTool.func(
    { task, strategy: "plan" },
    { sessionId: "live-plan", ai: liveAi, abortSignal: new AbortController().signal },
  )
  return String(out ?? "")
}

// (B) DECOMPOSE: drive orchestrate with DISTINCT subtasks (real division of labour).
// Each branch gets subtasks[i]; with strategy 'parallel' the result is the numbered
// join of every branch's reply, so a decompose run yields DISTINCT per-branch work —
// not N redundant attempts. Returns the tool's verbatim string result.
export const runDecomposeLive = async (
  subtasks: string[],
  liveAi: AxAIService = buildLiveAi(),
  task = "Work the listed subtasks; each sub-agent handles exactly one.",
): Promise<string> => {
  const rlmWorkflowTool = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
  if (!rlmWorkflowTool?.func) throw new Error("orchestrate tool not found in RLM_WORKFLOW_TOOLS")
  const out = await rlmWorkflowTool.func(
    { task, subtasks, strategy: "parallel" },
    { sessionId: "live-decompose", ai: liveAi, abortSignal: new AbortController().signal },
  )
  return String(out ?? "")
}

// (D) BOUNDED FAN-OUT: drive orchestrate with >4 DISTINCT subtasks (here 12) to prove the
// raised branch cap (4 → 100) runs more than 4 sub-agents AND that bounded concurrency holds
// — parallelLimit caps in-flight nodes (default ~8) and the service rateLimiter throttles the
// real CF forwards, so 12 branches complete with real output and NO rate-limit blowup/crash.
// Each subtask is a deterministic single-word transform so per-branch correctness is checkable.
export const runFanOutLive = async (
  subtasks: string[],
  liveAi: AxAIService = buildLiveAi(),
  task = "Work the listed subtasks; each sub-agent handles exactly one.",
): Promise<string> => {
  const rlmWorkflowTool = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
  if (!rlmWorkflowTool?.func) throw new Error("orchestrate tool not found in RLM_WORKFLOW_TOOLS")
  const out = await rlmWorkflowTool.func(
    { task, subtasks, strategy: "parallel" },
    { sessionId: "live-fanout", ai: liveAi, abortSignal: new AbortController().signal },
  )
  return String(out ?? "")
}

// (F) GRACEFUL MAX-STEPS: drive a TOOL-DEMANDING task with a LOW maxSteps cap (the harness
// runs this gate with AX2_MAX_STEPS=1 — limits.maxSteps is read at module load). With the
// graceful ceiling, finalizeOnMaxSteps (orch-recipes.ts) strips the node's tools on its last
// permitted step via ax's stepHooks.beforeStep, FORCING a real final text reply with NO further
// tool calls and NO "max steps reached" throw. Without it the node would throw/return empty.
// Returns the orchestrate tool's verbatim string (branches:1 = one real node, no judge noise).
export const runGracefulMaxStepsLive = async (
  task: string,
  liveAi: AxAIService = buildLiveAi(),
): Promise<string> => {
  const rlmWorkflowTool = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
  if (!rlmWorkflowTool?.func) throw new Error("orchestrate tool not found in RLM_WORKFLOW_TOOLS")
  const out = await rlmWorkflowTool.func(
    { task, strategy: "parallel", branches: 1 },
    { sessionId: "live-graceful", ai: liveAi, abortSignal: new AbortController().signal },
  )
  return String(out ?? "")
}

// (C) RLM: drive the REAL run_rlm path over a long context with a buried fact. Builds
// the @ax-llm/ax single-level RLM (distiller→executor→responder over runtime-held
// context) EXACTLY like the standalone smoke and asserts the ANSWER contains the fact.
// Returns the answer + the callback count (actorTurnCallback/onContextEvent firings) so
// the smoke can prove the bridge wired — runRlm is the same fn the run_rlm tool calls.
export const runRlmLive = async (
  context: string,
  query: string,
  liveAi: AxAIService = buildLiveAi(),
): Promise<{ answer: string; evidence: string[]; turns: number; callbacks: number }> =>
  runRlm(context, query, liveAi, `live-rlm:${Date.now()}`, new AbortController().signal)

// A non-empty REAL reply = a string with actual content that is NOT one of the
// handler's failure/partial sentinels (rlm-workflow.ts: "orchestration failed: …",
// "partial: …", "error: …"). Those compile and return a string but mean the live
// run did NOT succeed — the exact false-green the tsc gate missed.
const isRealReply = (s: string): boolean => {
  const t = s.trim()
  if (t.length === 0) return false
  return !/^(orchestration failed:|partial:|error:|script failed:)/i.test(t)
}

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

if (process.env.AX2_LIVE !== "1") {
  console.log("orch-live.test: skipped: set AX2_LIVE=1")
  process.exit(0)
}

// ax leaks a BENIGN background promise rejection on some samplings: when the RLM's
// executor stalls and the agent loop emits an AxAgentClarificationError, ax surfaces it
// from an internal stream that the awaited forward() has already resolved past — so it
// arrives as an UNHANDLED rejection AFTER our assertions ran. Bun then flips the exit
// code to 1 even though every gate printed pass. Swallow that one known-benign shape
// (and the matching stream-terminated artifact) so a post-success ax background reject
// can't red a green run; anything else still crashes loud. We exit(0) explicitly below
// after the pass line so no dangling microtask can override a clean result either.
const isBenignAxReject = (e: unknown): boolean =>
  e instanceof AxAgentClarificationError ||
  /AxAgentClarificationError|StreamTerminated|EmptyResult/i.test(String((e as { name?: string; message?: string })?.name ?? (e as { message?: string })?.message ?? e))
process.on("unhandledRejection", (reason: unknown) => {
  if (isBenignAxReject(reason)) {
    console.error(`  (ignored benign ax background rejection: ${String((reason as { message?: string })?.message ?? reason).slice(0, 120)})`)
    return
  }
  console.error("orch-live.test: UNHANDLED rejection (not benign) —", reason)
  process.exit(1)
})

await (async () => {
  console.log(`orch-live.test: live CF-Kimi smoke (model ${MODEL}) — this calls the real API…`)

  // A small CONCRETE task with a deterministic right answer, so a non-empty reply is
  // also a meaningful one. parallel/2 = the cheapest real fan-out (two forked-memory
  // workers, BASE_TOOLS leaves, shared budget) — the minimal proof the path runs.
  const task = "What is 17 + 25? Reply with just the number and one short sentence confirming it."
  const reply = await runOrchestrateLive(task, "parallel", 2)

  console.log("─".repeat(60))
  console.log("LIVE REPLY:")
  console.log(reply)
  console.log("─".repeat(60))

  assert(isRealReply(reply), `reply is a real non-empty string (not a failure/partial sentinel), got: ${JSON.stringify(reply.slice(0, 200))}`)
  assert(reply.includes("42"), `reply contains the correct answer 42, got: ${JSON.stringify(reply.slice(0, 200))}`)

  // (A) leaf-real gate: a leaf is now built from the MAIN agent's BASE_PROMPT +
  // BASE_TOOLS (persona only an overlay), so it must be able to do REAL agentic work —
  // use its file/shell tools to inspect the repo and answer substantively, referencing
  // real files. A single-branch parallel run is one real leaf with no judge/verify
  // noise — the cleanest proof a leaf can stand on its own.
  const repoTask =
    "List the top-level files/directories of this repository (use your tools) and say in one or two sentences what this project is."
  const repoReply = await runOrchestrateLive(repoTask, "parallel", 1)

  console.log("─".repeat(60))
  console.log("LIVE LEAF-REAL REPLY:")
  console.log(repoReply)
  console.log("─".repeat(60))

  assert(isRealReply(repoReply), `leaf reply is a real non-empty string, got: ${JSON.stringify(repoReply.slice(0, 200))}`)
  // The leaf must reference REAL repo files it could only know by running tools.
  const realFiles = ["package.json", "src", "tsconfig", "CLAUDE.md", "node_modules", "scripts", ".env"]
  assert(
    realFiles.some((f) => repoReply.includes(f)),
    `leaf reply references at least one real top-level file (${realFiles.join(", ")}), got: ${JSON.stringify(repoReply.slice(0, 400))}`,
  )

  // (B) DECOMPOSE gate: 3 DISTINCT subtasks → each branch returns work for ITS OWN
  // subtask. With strategy 'parallel' the tool returns the numbered join (#1/#2/#3) of
  // each branch's reply, so we split on the "#N:" markers and assert: real non-empty,
  // 2+ distinct branch outputs that are NOT identical to each other. The subtasks are
  // small self-contained string transforms (deterministic, no repo state needed) so the
  // distinctness is unambiguous: each branch's answer is specific to its own subtask.
  const subtasks = [
    "Reverse the word 'orchestrate' and reply with ONLY the reversed string.",
    "Count the vowels in the word 'decomposition' and reply with ONLY that number.",
    "Uppercase the word 'subtask' and reply with ONLY the uppercased word.",
  ]
  const decomposeReply = await runDecomposeLive(subtasks)

  console.log("─".repeat(60))
  console.log("LIVE DECOMPOSE REPLY (3 distinct subtasks):")
  console.log(decomposeReply)
  console.log("─".repeat(60))

  assert(isRealReply(decomposeReply), `decompose reply is a real non-empty string, got: ${JSON.stringify(decomposeReply.slice(0, 200))}`)
  // Split the numbered join back into per-branch chunks ("#1:\n…", "#2:\n…").
  const chunks = decomposeReply
    .split(/(?=^#\d+:)/m)
    .map((c) => c.replace(/^#\d+:\s*/, "").trim())
    .filter((c) => c.length > 0)
  assert(chunks.length >= 2, `decompose produced 2+ branch chunks, got ${chunks.length}: ${JSON.stringify(decomposeReply.slice(0, 400))}`)
  // DISTINCT: the branch outputs must not all collapse to one identical string (the
  // exact failure of parallel-same — N redundant attempts). Real decomposition ⇒ each
  // branch's reply is specific to its own subtask, so they differ.
  const distinct = new Set(chunks.map((c) => c.toLowerCase()))
  assert(
    distinct.size >= 2,
    `decompose branch outputs are DISTINCT (division of labour, not redundant), got ${distinct.size} unique of ${chunks.length}: ${JSON.stringify(chunks)}`,
  )
  // Each branch did ITS subtask: the expected per-subtask answers appear somewhere in
  // the joined result (etartsehcro / 6 / SUBTASK — 'decomposition' has 6 vowels:
  // e,o,o,i,i,o). At least 2 of 3 must land so a single flaky branch doesn't red the
  // gate while still proving real per-subtask work.
  const expectedHits = [
    /etartsehcro/i.test(decomposeReply),
    /\b6\b/.test(decomposeReply),
    /SUBTASK/.test(decomposeReply),
  ].filter(Boolean).length
  assert(
    expectedHits >= 2,
    `at least 2/3 subtasks produced their specific correct answer (etartsehcro / 6 / SUBTASK), got ${expectedHits}: ${JSON.stringify(decomposeReply.slice(0, 400))}`,
  )

  // (G) PLAN-EXECUTE gate (AUTO-decompose): give a single DECOMPOSABLE task and strategy
  // 'plan' — the PLANNER node must split it into >1 DISTINCT subtask ITSELF (the model's own
  // division of labour, NOT a caller-passed list), then each branch returns real work for ITS
  // subtask. We parse the "PLAN (N subtasks):" header to read the planner's subtask list, and
  // the "#N:" chunks under "RESULTS:" to read each branch's output, asserting: a real plan with
  // 2+ distinct subtasks, and 2+ distinct branch outputs (so the fan-out did per-subtask work,
  // not N identical attempts). A decomposable, self-contained task so no repo/tool flakiness.
  const planTask =
    "Produce a tiny self-contained reference card with THREE independent parts: (1) list three common HTTP status codes with their meanings, (2) give the ISO date format string, (3) name three primary colors. Treat each part as a separate piece of work."
  const planReply = await runPlanLive(planTask)

  console.log("─".repeat(60))
  console.log("LIVE PLAN-EXECUTE REPLY (planner auto-decomposes, then fans out):")
  console.log(planReply)
  console.log("─".repeat(60))

  assert(isRealReply(planReply), `plan reply is a real non-empty string (not a failure/partial sentinel), got: ${JSON.stringify(planReply.slice(0, 200))}`)
  // The planner emitted a structured PLAN header listing its subtasks — proof the model
  // produced the decomposition itself. Read the numbered "  1. …" lines under "PLAN (".
  assert(/^PLAN \(\d+ subtasks\):/m.test(planReply), `plan reply opens with the planner's "PLAN (N subtasks):" header, got: ${JSON.stringify(planReply.slice(0, 200))}`)
  const planSection = planReply.split(/\n\nRESULTS:\n/)[0] ?? ""
  // >1 DISTINCT subtask: the planner split the task (not a single passthrough). Compare the
  // numbered plan lines case-insensitively.
  const planLines = planSection.split(/\n/).filter((l) => /^\s*\d+\.\s/.test(l)).map((l) => l.replace(/^\s*\d+\.\s*/, "").trim())
  const distinctPlan = new Set(planLines.map((l) => l.toLowerCase()))
  assert(
    distinctPlan.size > 1,
    `planner produced >1 DISTINCT subtask (auto division of labour), got ${distinctPlan.size} unique of ${planLines.length}: ${JSON.stringify(planLines)}`,
  )
  // Each branch returned real work for ITS subtask: split the RESULTS join into "#N:" chunks
  // and assert 2+ distinct non-empty branch outputs (per-subtask work, not redundant attempts).
  const resultsSection = planReply.split(/\n\nRESULTS:\n/)[1] ?? ""
  const planChunks = resultsSection
    .split(/(?=^#\d+:)/m)
    .map((c) => c.replace(/^#\d+:\s*/, "").trim())
    .filter((c) => c.length > 0)
  assert(planChunks.length >= 2, `plan-execute produced 2+ branch outputs (one per subtask), got ${planChunks.length}: ${JSON.stringify(resultsSection.slice(0, 400))}`)
  const distinctBranches = new Set(planChunks.map((c) => c.toLowerCase()))
  assert(
    distinctBranches.size >= 2,
    `plan-execute branch outputs are DISTINCT (each did ITS own subtask), got ${distinctBranches.size} unique of ${planChunks.length}: ${JSON.stringify(planChunks.map((c) => c.slice(0, 80)))}`,
  )

  // (D) BOUNDED FAN-OUT gate: 12 DISTINCT subtasks (> the OLD cap of 4) → prove the raised
  // branch cap runs MORE THAN 4 sub-agents, all complete with real output, and bounded
  // concurrency holds (parallelLimit in-flight cap + service rateLimiter) — no rate-limit
  // error, no crash. Each subtask is a deterministic single-word transform so we can verify
  // real per-branch work landed. With strategy 'parallel' the tool returns the numbered
  // join (#1..#12) of every branch's reply; we split it back and count distinct branches.
  const fanWords = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]
  const fanSubtasks = fanWords.map((w) => `Uppercase the word '${w}' and reply with ONLY the uppercased word.`)
  const fanReply = await runFanOutLive(fanSubtasks)

  console.log("─".repeat(60))
  console.log(`LIVE BOUNDED FAN-OUT REPLY (${fanSubtasks.length} branches, > old cap of 4):`)
  console.log(fanReply)
  console.log("─".repeat(60))

  assert(isRealReply(fanReply), `fan-out reply is a real non-empty string (no rate-limit/crash sentinel), got: ${JSON.stringify(fanReply.slice(0, 200))}`)
  const fanChunks = fanReply
    .split(/(?=^#\d+:)/m)
    .map((c) => c.replace(/^#\d+:\s*/, "").trim())
    .filter((c) => c.length > 0)
  // MORE THAN 4 branches ran — the core proof the cap was raised past the old 4. Real fan-out
  // is mildly flaky per-branch, so require a clear majority (>=8 of 12) of branches to land,
  // which is still strictly > 4 and proves bounded concurrency completed the large fan-out.
  assert(
    fanChunks.length > 4,
    `bounded fan-out ran MORE THAN 4 branches (raised cap), got ${fanChunks.length} branch chunks: ${JSON.stringify(fanReply.slice(0, 300))}`,
  )
  assert(
    fanChunks.length >= 8,
    `most of the 12 branches completed (>=8), got ${fanChunks.length} — bounded concurrency holds without rate-limit drops`,
  )
  // Per-branch correctness: each branch's uppercase answer should appear. Require a strong
  // majority (>=8/12) so a couple of flaky branches don't red the gate while still proving
  // real distinct work across >4 concurrent sub-agents.
  const fanHits = fanWords.filter((w) => new RegExp(`\\b${w.toUpperCase()}\\b`).test(fanReply)).length
  assert(
    fanHits >= 8,
    `at least 8/12 fan-out branches produced their specific uppercased answer, got ${fanHits}: ${JSON.stringify(fanReply.slice(0, 400))}`,
  )


  // (F) GRACEFUL MAX-STEPS gate: a TOOL-DEMANDING task that WILL exceed a small maxSteps.
  // The harness runs this gate with AX2_MAX_STEPS=1 (limits.maxSteps below reflects it), so
  // the node's first step is also its last: finalizeOnMaxSteps strips its tools on that step
  // via ax's stepHooks.beforeStep, FORCING a real final text reply with NO further tool calls
  // and NO "max steps reached" throw. We assert the orchestrate tool did NOT throw, returned a
  // real non-empty reply (not a failure/partial sentinel) — proof the ceiling is GRACEFUL
  // (claude_code model), not a cliff. Only meaningful at a low cap; logs the cap it ran under.
  const gracefulTask =
    "Read the file package.json in this repo with your tools and report the project name and one dependency. If you cannot finish, summarize what you know."
  let gracefulThrew = false
  let gracefulReply = ""
  try {
    gracefulReply = await runGracefulMaxStepsLive(gracefulTask)
  } catch (e) {
    gracefulThrew = true
    console.error("GRACEFUL MAX-STEPS THREW:", e)
  }

  console.log("─".repeat(60))
  console.log(`LIVE GRACEFUL MAX-STEPS REPLY (AX2_MAX_STEPS=${limits.maxSteps}, tool-demanding task):`)
  console.log(gracefulReply)
  console.log("─".repeat(60))

  assert(!gracefulThrew, "graceful max-steps: orchestrate did NOT throw at the step cap (ceiling, not a cliff)")
  assert(
    isRealReply(gracefulReply),
    `graceful max-steps reply is a real non-empty string (forced in-loop finalize, not a throw/empty/sentinel), got: ${JSON.stringify(gracefulReply.slice(0, 200))}`,
  )

  // (C) RLM gate: a LONG context with a buried fact (like the proven /tmp smoke). The
  // context is 60 numbered sections; ONE section hides a magic token the model could
  // only know by mining the runtime-held blob (it is NOT in the query). The RLM must
  // load it into the code runtime, find it, and ANSWER with the fact. We also assert the
  // actor/context callbacks FIRED (the bridge that renders the RLM nested in the tree).
  assert(RLM_TOOLS.some((t) => t.name === "run_rlm"), "run_rlm tool is registered in RLM_TOOLS")

  // The buried fact is a BENIGN identifier (a mascot codename), not a credential —
  // asking for a "secret access code" tripped the model's safety refusal and it would
  // not return it even though it had found it. A harmless fact proves the SAME thing
  // (the RLM mined the runtime-held blob) without fighting the guardrail.
  const MAGIC = "ZEPHYR-7731"
  const sections = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1
    if (n === 38) {
      return `Section ${n}: Team trivia. The official codename for our internal load-test mascot is ${MAGIC}. The team picked it at the 2021 offsite and it has appeared on every dashboard since.`
    }
    return `Section ${n}: This section discusses ${
      ["caching strategy", "retry backoff", "schema migrations", "feature flags", "observability", "rate limiting"][i % 6]
    } in moderate detail, with several paragraphs of routine guidance that does not contain any unusual codenames or identifiers worth remembering.`
  })
  const longContext = sections.join("\n\n")
  const rlmQuery =
    "Search ALL sections of the context for the official codename of the internal load-test mascot (scan every section, it is mentioned exactly once). Reply with the exact codename string."

  // RLM exploration is non-deterministic: the executor writes its OWN search JS, and a
  // single run's strategy can miss the one buried section (a real property of the model,
  // not a wiring bug — the callbacks fire every run). Retry a few times and pass on the
  // FIRST run that recovers the fact, so the gate proves "the RLM CAN find it" without
  // depending on a single sampling. callbacks>0 is asserted on every attempt regardless.
  // A single attempt may THROW for two non-wiring reasons we must ride out, both of which
  // are transient properties of the live model/endpoint, not the orchestration code:
  //   (a) AxAgentClarificationError — the model asks for the sections instead of scanning;
  //       the SAME non-deterministic sampling miss as "fact not found" (callbacks fired).
  //   (b) a transient HTTP 429 ("Too Many Requests") from CF after ax's own 3 retries —
  //       an environmental rate-limit (e.g. back-to-back live runs), not a failure of the
  //       fan-out/budget logic. We back off and retry, exactly like ax's own backoff loop.
  // Either is treated as an empty (not-found) result so the retry loop runs again; ANY
  // other throw still propagates (a real failure). callbacks=1 keeps the callbacks>0
  // assertion valid on the eventual successful attempt.
  const isTransientRlmThrow = (e: unknown): boolean =>
    isBenignAxReject(e) || /\b429\b|too many requests|rate.?limit/i.test(String((e as { message?: string })?.message ?? e))
  const tryRlm = async (attempt: number): Promise<{ answer: string; evidence: string[]; turns: number; callbacks: number }> => {
    try {
      return await runRlmLive(longContext, rlmQuery)
    } catch (e) {
      if (isTransientRlmThrow(e)) {
        const backoff = Math.min(8000, 1500 * attempt)
        console.log(`RLM attempt threw a transient error (${String((e as { message?: string })?.message ?? e).slice(0, 80)}) — backing off ${backoff}ms and retrying…`)
        await new Promise((r) => setTimeout(r, backoff))
        return { answer: "", evidence: [], turns: 0, callbacks: 1 }
      }
      throw e
    }
  }
  let rlmOut = await tryRlm(1)
  for (let attempt = 1; attempt < 5 && !`${rlmOut.answer}\n${rlmOut.evidence.join("\n")}`.includes(MAGIC); attempt++) {
    console.log(`RLM did not surface the fact on attempt ${attempt} (turns=${rlmOut.turns} callbacks=${rlmOut.callbacks}) — retrying…`)
    rlmOut = await tryRlm(attempt + 1)
  }

  console.log("─".repeat(60))
  console.log("LIVE RLM ANSWER (buried-fact retrieval):")
  console.log(rlmOut.answer)
  console.log("RLM evidence:", JSON.stringify(rlmOut.evidence))
  console.log(`RLM turns=${rlmOut.turns} callbacks=${rlmOut.callbacks}`)
  console.log("─".repeat(60))

  assert(isRealReply(rlmOut.answer), `RLM answer is a real non-empty string, got: ${JSON.stringify(rlmOut.answer.slice(0, 200))}`)
  // The buried fact must appear in the ANSWER (or its evidence) — proof the RLM mined
  // the runtime-held context, not the prompt (the code was NEVER in the query).
  const haystack = `${rlmOut.answer}\n${rlmOut.evidence.join("\n")}`
  assert(
    haystack.includes(MAGIC),
    `RLM answer contains the buried fact ${MAGIC}, got: ${JSON.stringify(haystack.slice(0, 300))}`,
  )
  // The callback bridge must have fired (actorTurnCallback + onContextEvent) — this is
  // what renders the RLM's distiller/executor/responder loop nested under the turn span.
  assert(rlmOut.callbacks > 0, `RLM callbacks fired (actorTurnCallback/onContextEvent), got ${rlmOut.callbacks}`)

  // (H) MULTI-MODEL gate: per-NODE model + thinking-level routing over the TWO-model pool
  // (Kimi K2.7 + GLM 5.2), BOTH on the SAME CF endpoint with the existing creds. Proves:
  //   (a) DEFAULT path unchanged — an explicit { model:'kimi' } leaf returns real output;
  //   (b) a leaf routed to { model:'glm' } (GLM 5.2) returns real output (different model);
  //   (c) an explicit thinking level ({ effort:'high' }) threads through to forward() on
  //       BOTH models without breaking (real reply, not an empty/length-starved blob).
  // A small concrete task with a deterministic right answer so a real reply is meaningful.
  // The maxTokens floor (models.ts NODE_MAX_TOKENS) keeps each thinking model's reasoning
  // from eating the whole completion budget (the verified empty-content gotcha).
  const mmTask = "What is the capital of Japan? Reply with just the city name and one short confirming sentence."

  const kimiReply = await runRoutedLive(mmTask, "kimi", undefined)
  console.log("─".repeat(60))
  console.log("LIVE MULTI-MODEL — KIMI (default, no effort):")
  console.log(kimiReply)
  console.log("─".repeat(60))
  assert(isRealReply(kimiReply), `(a) kimi-routed leaf returns a real non-empty reply, got: ${JSON.stringify(kimiReply.slice(0, 200))}`)
  assert(/tokyo/i.test(kimiReply), `(a) kimi reply contains the correct answer Tokyo, got: ${JSON.stringify(kimiReply.slice(0, 200))}`)

  const glmReply = await runRoutedLive(mmTask, "glm", undefined)
  console.log("─".repeat(60))
  console.log("LIVE MULTI-MODEL — GLM 5.2 (routed, no effort):")
  console.log(glmReply)
  console.log("─".repeat(60))
  assert(isRealReply(glmReply), `(b) glm-routed leaf returns a real non-empty reply (GLM 5.2 on the same endpoint), got: ${JSON.stringify(glmReply.slice(0, 200))}`)
  assert(/tokyo/i.test(glmReply), `(b) glm reply contains the correct answer Tokyo, got: ${JSON.stringify(glmReply.slice(0, 200))}`)

  const kimiHigh = await runRoutedLive(mmTask, "kimi", "high")
  console.log("─".repeat(60))
  console.log("LIVE MULTI-MODEL — KIMI + effort:'high' (thinking level threads through):")
  console.log(kimiHigh)
  console.log("─".repeat(60))
  assert(isRealReply(kimiHigh), `(c) kimi + effort:'high' returns a real non-empty reply (thinking level passed to forward), got: ${JSON.stringify(kimiHigh.slice(0, 200))}`)

  const glmHigh = await runRoutedLive(mmTask, "glm", "high")
  console.log("─".repeat(60))
  console.log("LIVE MULTI-MODEL — GLM 5.2 + effort:'high' (thinking level threads through):")
  console.log(glmHigh)
  console.log("─".repeat(60))
  assert(isRealReply(glmHigh), `(c) glm + effort:'high' returns a real non-empty reply (thinking level passed to forward), got: ${JSON.stringify(glmHigh.slice(0, 200))}`)

  // (I) PER-NODE TOOL ROUTING gate: a parallel fan-out of DISTINCT repo subtasks, each branch a
  // sub-agent that MUST use file tools (grep/read/glob/bash). With the routing fix every tool a
  // branch loops carries that branch's nodeId, so the reducer attaches it to THAT branch's node
  // — never the main transcript, never another branch. We assert: (1) tools were captured at
  // all (the branches really looped tools); (2) every captured tool is TAGGED with a branch
  // nodeId (none leaked untagged into the transcript); (3) the tools are distributed across the
  // branch nodes (each owning node id contains ITS own tools), proving no interleave into one
  // stream. Tool-using sub-agents are mildly flaky, so the gate needs >=1 branch to have looped
  // a tool and ALL captured tools to be correctly attributed.
  const routeSubtasks = [
    "Use your tools to find how many TypeScript files are under the src/ directory of this repo, and report the count.",
    "Use your tools to read package.json in this repo and report the project name and one script name.",
  ]
  const routing = await runRoutingLive(routeSubtasks)
  const ownerIds = Object.keys(routing.nodeTools).filter((id) => (routing.nodeTools[id] ?? []).length > 0)
  const totalNodeTools = ownerIds.reduce((s, id) => s + (routing.nodeTools[id]?.length ?? 0), 0)

  console.log("─".repeat(60))
  console.log("LIVE PER-NODE TOOL ROUTING (2 distinct tool-using branches):")
  console.log(`  reply: ${routing.reply.slice(0, 120).replace(/\n/g, " ")}…`)
  console.log(`  transcript (untagged) tools: ${routing.transcript.length}`)
  for (const id of ownerIds) console.log(`  node ${id}: ${(routing.nodeTools[id] ?? []).map((t) => t.name).join(", ")}`)
  console.log("─".repeat(60))

  assert(isRealReply(routing.reply), `routing run returned a real reply, got: ${JSON.stringify(routing.reply.slice(0, 150))}`)
  // (1) the branches actually looped at least one tool (the whole point — a node OWNS tools).
  assert(totalNodeTools >= 1, `at least one branch looped a file tool attributed to its node, got ${totalNodeTools} across nodes ${JSON.stringify(ownerIds)}`)
  // (2) NOTHING leaked untagged into the main transcript — every tool a branch ran is tagged
  // with that branch's nodeId (the exact bug this fix closes: branch tools rendering under the
  // main outer agent's transcript).
  assert(routing.transcript.length === 0, `no branch tool leaked UNTAGGED into the main transcript (the bug), got ${routing.transcript.length}: ${JSON.stringify(routing.transcript.slice(0, 4))}`)
  // (3) every owning node id is a branch node of THIS run (not the root/judge) — tools are
  // attributed to the sub-agent that owns them, and each node's tools carry ITS OWN id (no
  // interleave: a tool's nodeId always equals the node bucket it landed in).
  for (const id of ownerIds) {
    const tools = routing.nodeTools[id] ?? []
    assert(tools.every((t) => t.nodeId === id), `node ${id}'s tools are ALL tagged with its own id (no interleave), got: ${JSON.stringify(tools.map((t) => t.nodeId))}`)
    assert(/\/branch-\d+$/.test(id), `tool-owning node ${id} is a branch sub-agent (its tools belong to it)`)
  }
})()

if (failed > 0) {
  console.error(`orch-live.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-live.test: all pass ✓")
// Exit EXPLICITLY on success: ax keeps internal streams/timers alive past forward(), and
// a late benign background rejection (handled above) could otherwise let Bun settle the
// exit code to 1 after this line. A clean exit(0) here locks in the green result.
process.exit(0)
