// Neutral low-level runtime helpers shared by the agent and the orchestration
// modules. Extracted here so agent.ts (the turn() owner) and orch-tools.ts /
// orch-load.ts / orch-run.ts (the orchestration drivers) all pull the SAME model
// id, AI service, budget ceilings, node-event sink and usage reader from a module
// that imports NONE of them — breaking the old agent ⇄ orch-tools static cycle.
import { ai } from "@ax-llm/ax"
import * as Effect from "effect/Effect"
import { type BudgetUsage, emit, type NodeEvent } from "./orch.ts"

export const MODEL = "@cf/moonshotai/kimi-k2.7-code"

const MAX_STEPS = Number(process.env.AX2_MAX_STEPS ?? 50) // max tool-call iterations per turn
// Hard per-turn TOKEN ceiling, enforced by orch's Budget (charged after each leaf
// from the forward result's usage). Distinct from MAX_STEPS (tool-call iterations,
// still recovered by turn() in agent.ts): this is a real token gate that throws
// BudgetExhaustedError when a turn's cumulative usage crosses it.
const TOKEN_BUDGET = Number(process.env.AX2_TOKEN_BUDGET ?? 2_000_000)

// The shared AI service. Exported so turn() (agent.ts) and every orchestration
// driver (orch-run.ts/orch-tools.ts/orch-load.ts) drive the SAME provider — one
// client, one trace. agent.ts attaches the live logger + captureFetch via
// setOptions at its module load (mutating this shared instance in place).
export const llm = ai({
  name: "openai",
  apiKey: process.env.CLOUDFLARE_API_TOKEN!,
  apiURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
  config: { model: MODEL as any },
})

// Node-lifecycle sink handed to the agent() recipe. emit() is Effect<void> (an
// Effect.sync body: bus push + active-OTel-span addEvent). We run it synchronously
// at the session boundary — the recipe stays Promise-native and never touches
// Effect. agentNode() runs inside otelContext.with(traceContext), so getActiveSpan()
// inside emit() resolves to the live chat.turn span (not a forked/empty context).
export const onEvent = (event: NodeEvent): void => Effect.runSync(emit(event))

// Generic usage reader: a getUsage() probe over any AxGen the orchestration drivers
// forward. Exported so a sub-run charges the shared Budget from each leaf's usage,
// exactly like turn().
export const readUsageOf = (gen: unknown): BudgetUsage | undefined => {
  const u = (gen as { getUsage?: () => unknown }).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return (last as { tokens?: BudgetUsage })?.tokens ?? (last as BudgetUsage | undefined)
}

// Tool-call iteration ceiling + per-orchestration token ceiling, so every
// orchestration driver builds LeafOpts/Budget with the same limits as turn().
export const limits = { maxSteps: MAX_STEPS, tokenBudget: TOKEN_BUDGET } as const
