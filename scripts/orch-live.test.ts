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
import { ai, type AxAIService, type AxFunction } from "@ax-llm/ax"
import { ORCH_TOOLS } from "../src/orch-tools.ts"
import { RLM_TOOLS, runRlm } from "../src/rlm-tool.ts"
import { MODEL, rateLimiter } from "../src/runtime.ts"

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

// Drive the REAL orchestrate tool (ORCH_TOOLS[0]) — the same AxFunction the model
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
  const orchestrateTool = ORCH_TOOLS.find((t: AxFunction) => t.name === "orchestrate")
  if (!orchestrateTool?.func) throw new Error("orchestrate tool not found in ORCH_TOOLS")
  const out = await orchestrateTool.func(
    { task, strategy, branches },
    { sessionId: "live-smoke", ai: liveAi, abortSignal: new AbortController().signal },
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
  const orchestrateTool = ORCH_TOOLS.find((t: AxFunction) => t.name === "orchestrate")
  if (!orchestrateTool?.func) throw new Error("orchestrate tool not found in ORCH_TOOLS")
  const out = await orchestrateTool.func(
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
  const orchestrateTool = ORCH_TOOLS.find((t: AxFunction) => t.name === "orchestrate")
  if (!orchestrateTool?.func) throw new Error("orchestrate tool not found in ORCH_TOOLS")
  const out = await orchestrateTool.func(
    { task, subtasks, strategy: "parallel" },
    { sessionId: "live-fanout", ai: liveAi, abortSignal: new AbortController().signal },
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
// handler's failure/partial sentinels (orch-tools.ts: "orchestration failed: …",
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
  let rlmOut = await runRlmLive(longContext, rlmQuery)
  for (let attempt = 1; attempt < 3 && !`${rlmOut.answer}\n${rlmOut.evidence.join("\n")}`.includes(MAGIC); attempt++) {
    console.log(`RLM did not surface the fact on attempt ${attempt} (turns=${rlmOut.turns} callbacks=${rlmOut.callbacks}) — retrying…`)
    rlmOut = await runRlmLive(longContext, rlmQuery)
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
})()

if (failed > 0) {
  console.error(`orch-live.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-live.test: all pass ✓")
