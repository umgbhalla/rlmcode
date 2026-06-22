// Neutral low-level runtime helpers shared by the agent and the orchestration
// modules. Extracted here so agent.ts (the turn() owner) and orch-tools.ts /
// orch-load.ts / orch-run.ts (the orchestration drivers) all pull the SAME model
// id, AI service, budget ceilings, node-event sink and usage reader from a module
// that imports NONE of them — breaking the old agent ⇄ orch-tools static cycle.
import { ai, type AxRateLimiterFunction } from "@ax-llm/ax"
import * as Effect from "effect/Effect"
import { type BudgetUsage, emit, type NodeEvent } from "./orch.ts"

export const MODEL = "@cf/moonshotai/kimi-k2.7-code"

// SERVICE-LEVEL throttle: a min-interval (token-free) rate limiter attached to the CF-Kimi
// service so even an unbounded `parallel` fan-out (or many concurrent turns) never fires
// faster than AX2_MAX_RPS requests/second at the CF API. This is the SECOND throttle layer
// under parallelLimit (orch-recipes.ts) — parallelLimit caps how many forwards are IN FLIGHT;
// this caps how FAST they start. minIntervalRateLimiter serializes the start of each forward
// behind a shared `next-allowed` clock: each reqFunc waits until at least 1/RPS seconds after
// the previous one began, then runs. AxRateLimiterFunction must return the reqFunc's result
// (Promise or stream) — we just delay, then call through. Default 12 RPS (sensible for CF
// Workers AI); AX2_MAX_RPS overrides. Clamped to >= 0.1 so a bad env never divides by zero.
const MAX_RPS = (() => {
  const v = Number(process.env.AX2_MAX_RPS ?? 12)
  return Number.isFinite(v) && v > 0 ? Math.max(0.1, v) : 12
})()
const minIntervalRateLimiter = (rps: number): AxRateLimiterFunction => {
  const interval = 1000 / rps
  let nextAllowed = 0
  return async (reqFunc) => {
    const now = Date.now()
    const wait = Math.max(0, nextAllowed - now)
    // Reserve this slot on the shared clock BEFORE awaiting, so concurrent callers each
    // get a distinct, staggered start time (one forward begins every `interval` ms).
    nextAllowed = Math.max(now, nextAllowed) + interval
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    return reqFunc()
  }
}
// The shared limiter instance — attached in agent.ts's setOptions (the ONE setOptions call,
// since setOptions reassigns every field). Exported so the live harness's standalone service
// can attach the SAME throttle and the bounded-fan-out gate exercises the real limited path.
export const rateLimiter: AxRateLimiterFunction = minIntervalRateLimiter(MAX_RPS)

// The capable base system prompt shared by the MAIN agent (agent.ts re-exports it)
// and every orchestration NODE (orch-tools.ts nodeGen). Lives HERE — the neutral
// cycle-breaker module that imports neither agent.ts nor orch-tools.ts — so a node can
// be as capable as the main agent MINUS orchestration without re-introducing the
// agent ⇄ orch-tools static init cycle (orch-tools.ts importing BASE_PROMPT from
// agent.ts deadlocked agent.ts's top-level `const chat = ax(...)` on ORCH_TOOLS). The
// orchestration overlay (the orchestrate/run_orch_script paragraphs) is appended ONLY
// to the main chat gen in agent.ts (ORCH_OVERLAY) — a node never sees it, since a node
// carries BASE_TOOLS only and must not be told it can orchestrate.
export const BASE_PROMPT = [
  "You are a capable coding agent running inside a terminal, in the user's project directory.",
  "Tools: bash, read_file, write_file, edit_file, glob, grep. When a request needs real work,",
  "USE the tools to inspect/modify files and run commands BEFORE answering — don't guess.",
  "Verify with a tool when unsure. Keep replies concise and concrete; show the result that matters.",
  "Format replies in GitHub-flavored markdown (use `code`, lists, and ```fences``` where helpful).",
].join(" ")

const MAX_STEPS = Number(process.env.AX2_MAX_STEPS ?? 50) // max tool-call iterations per turn
// Hard per-turn TOKEN ceiling, enforced by orch's Budget (charged after each node
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

// Node-lifecycle sink handed to the runNode() recipe. emit() is Effect<void> (an
// Effect.sync body: bus push + active-OTel-span addEvent). We run it synchronously
// at the session boundary — the recipe stays Promise-native and never touches
// Effect. runNode() runs inside otelContext.with(traceContext), so getActiveSpan()
// inside emit() resolves to the live chat.turn span (not a forked/empty context).
export const onEvent = (event: NodeEvent): void => Effect.runSync(emit(event))

// Generic usage reader: a getUsage() probe over any AxGen the orchestration drivers
// forward. Exported so a sub-run charges the shared Budget from each node's usage,
// exactly like turn().
export const readUsageOf = (gen: unknown): BudgetUsage | undefined => {
  const u = (gen as { getUsage?: () => unknown }).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return (last as { tokens?: BudgetUsage })?.tokens ?? (last as BudgetUsage | undefined)
}

// Tool-call iteration ceiling + per-orchestration token ceiling, so every
// orchestration driver builds LeafOpts/Budget with the same limits as turn().
export const limits = { maxSteps: MAX_STEPS, tokenBudget: TOKEN_BUDGET } as const
