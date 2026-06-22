#!/usr/bin/env bun
// GRACEFUL MAX-STEPS live probe (the dedicated gate for the graceful-maxsteps feature).
// Drives the REAL orchestrate tool with AX2_MAX_STEPS=1 so a node's FIRST step is its LAST:
// finalizeOnMaxSteps (orch-recipes.ts) strips the node's tools on step 0 via ax's
// stepHooks.beforeStep, FORCING a final text reply with NO tool calls and NO "max steps reached"
// throw. The task DEMANDS tools (inspect the repo), so without the graceful ceiling it would
// throw/empty. Asserts a real non-empty reply comes back — proof the ceiling is graceful.
//
// Gated behind AX2_LIVE=1 (skips clean otherwise). Run:
//   AX2_LIVE=1 AX2_MAX_STEPS=1 bun --env-file=.env scripts/graceful-maxsteps-probe.ts
import { ai, type AxAIService, type AxFunction } from "@ax-llm/ax"
import { RLM_WORKFLOW_TOOLS } from "../src/rlm-workflow.ts"
import { MODEL, limits, rateLimiter } from "../src/runtime.ts"

if (process.env.AX2_LIVE !== "1") {
  console.log("graceful-maxsteps-probe: skipped: set AX2_LIVE=1")
  process.exit(0)
}

const buildLiveAi = (): AxAIService => {
  const apiKey = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!apiKey || !accountId) throw new Error("needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (run via --env-file=.env)")
  const svc = ai({
    name: "openai",
    apiKey,
    apiURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    config: { model: MODEL as never },
  })
  svc.setOptions({ rateLimiter })
  return svc
}

const orchestrate = RLM_WORKFLOW_TOOLS.find((t: AxFunction) => t.name === "rlm_workflow")
if (!orchestrate?.func) throw new Error("orchestrate tool not found")

console.log(`graceful-maxsteps-probe: live CF-Kimi (model ${MODEL}), AX2_MAX_STEPS=${limits.maxSteps}`)
console.log("Driving a TOOL-DEMANDING task that WILL exceed the cap — expecting a graceful in-loop finalize…")

// A task that needs tools to answer. With maxSteps=1 the node cannot complete it via tools; the
// step hook strips tools on the (first=last) step, forcing a real text reply instead of a throw.
const task =
  "Read the file package.json in this repo with your tools and report the project name and one dependency. If you cannot finish, summarize what you know."

let threw = false
let reply = ""
try {
  reply = String(
    (await orchestrate.func(
      { task, strategy: "parallel", branches: 1 },
      { sessionId: "graceful-probe", ai: buildLiveAi(), abortSignal: new AbortController().signal },
    )) ?? "",
  )
} catch (e) {
  threw = true
  console.error("THREW:", e)
}

console.log("─".repeat(60))
console.log("GRACEFUL-FINALIZE REPLY (AX2_MAX_STEPS=1, tool-demanding task):")
console.log(reply)
console.log("─".repeat(60))

const t = reply.trim()
const isSentinel = /^(orchestration failed:|partial:|error:|script failed:)/i.test(t)
let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}
assert(!threw, "orchestrate did NOT throw at the step cap (graceful, not a cliff)")
assert(t.length > 0, "reply is non-empty (forced final text, not empty)")
assert(!isSentinel, `reply is a real answer, not a failure/partial sentinel, got: ${JSON.stringify(t.slice(0, 160))}`)

if (failed > 0) {
  console.error(`graceful-maxsteps-probe: ${failed} failure(s).`)
  process.exit(1)
}
console.log("graceful-maxsteps-probe: graceful max-steps finalize verified ✓")
process.exit(0)
