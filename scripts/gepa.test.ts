#!/usr/bin/env bun
// gepa — OPT-IN GEPA router optimize, gated behind AX2_GEPA=1.
//
// WITHOUT the flag (the lint/CI path): runs the DRY assertion only — proves the
// optimize() call is constructed correctly (router program + train/held-out split +
// deterministic metric + well-formed options) WITHOUT a single live forward, prints
// "skipped: set AX2_GEPA=1", and exits 0. This is THE GATE for the gepa feature:
// COMPILE + scaffold wired + a DRY assertion the call is correct.
//
// WITH AX2_GEPA=1 (manual, expensive): builds the real Kimi (student) + GLM (teacher)
// CF services from .env, runs the real GEPA optimize over the router program, applies
// the best candidate, and persists the artifact to .ax/orch/optimized-router.json — the
// artifact a deliberate run is meant to land + commit.
//
// Run dry:   bun scripts/gepa.test.ts
// Run live:  AX2_GEPA=1 bun --env-file=.env scripts/gepa.test.ts   (or `bun run gepa`)
import { ai, type AxAIService } from "@ax-llm/ax"
import { MODEL, rateLimiter } from "../src/runtime.ts"
import { GLM, KIMI } from "../src/models.ts"
import {
  applyRouterOptimization,
  assertOptimizeWiring,
  buildRouter,
  optimizeRouter,
  OPTIMIZED_ROUTER_PATH,
  saveOptimization,
  type RouterOptimizeArgs,
} from "../src/orch-optimize.ts"
import { TRAIN_TASKS, VALIDATION_TASKS } from "../src/orch-tasks.ts"

// Build a CF service pinned to a specific pool model id (kimi|glm) — same openai-shaped
// Cloudflare Workers AI endpoint as runtime.ts's `llm`, with the shared min-interval
// rate limiter attached so a live optimize never hammers CF. Standalone (not the app
// singleton) so the run never mutates the app's service.
const buildPoolAi = (model: string): AxAIService => {
  const apiKey = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!apiKey || !accountId) {
    throw new Error("gepa live run needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in .env (run via `bun run gepa`)")
  }
  const svc = ai({
    name: "openai",
    apiKey,
    apiURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    config: { model: model as never },
  })
  svc.setOptions({ rateLimiter })
  return svc
}

const main = async (): Promise<void> => {
  const router = buildRouter()

  // DRY assertion — ALWAYS runs (no live calls). The student/teacher here are inert
  // placeholders only used to type-check the options shape; assertOptimizeWiring never
  // forwards them. This is the feature gate: it throws if the optimize() call is malformed.
  const dryArgs: RouterOptimizeArgs = {
    studentAI: { getName: () => "kimi" } as unknown as AxAIService,
    teacherAI: { getName: () => "glm" } as unknown as AxAIService,
    validation: VALIDATION_TASKS,
    target: 0.9,
    bootstrap: true,
  }
  const opts = assertOptimizeWiring(router, TRAIN_TASKS, dryArgs)
  console.log(
    `[gepa] DRY wiring OK — student=${KIMI} teacher=${GLM} ` +
      `train=${TRAIN_TASKS.length} validation=${VALIDATION_TASKS.length} ` +
      `maxMetricCalls=${opts.maxMetricCalls} bootstrap=${String(opts.bootstrap)} target=${String(opts.targetScore)}`,
  )

  if (process.env.AX2_GEPA !== "1") {
    // Confirm the artifact loader path is wired (loads nothing yet — scaffold-only).
    const applied = applyRouterOptimization(buildRouter())
    console.log(
      `[gepa] skipped live optimize: set AX2_GEPA=1 to run the real Kimi+GLM optimize. ` +
        `artifact ${applied ? "loaded + applied" : "not present yet"} (${OPTIMIZED_ROUTER_PATH})`,
    )
    return
  }

  // LIVE — expensive. Real Kimi student + GLM teacher over the labelled task set.
  console.log(`[gepa] AX2_GEPA=1 — running REAL optimize over the ${MODEL} pool (this costs tokens)…`)
  const liveArgs: RouterOptimizeArgs = {
    studentAI: buildPoolAi(KIMI),
    teacherAI: buildPoolAi(GLM),
    validation: VALIDATION_TASKS,
    target: 0.9,
    bootstrap: true,
  }
  const result = await optimizeRouter(router, TRAIN_TASKS, liveArgs)
  router.applyOptimization(result.optimizedProgram!)
  saveOptimization(result, OPTIMIZED_ROUTER_PATH)
  console.log(`[gepa] DONE — bestScore=${result.bestScore} artifact=${OPTIMIZED_ROUTER_PATH}`)
}

await main()
