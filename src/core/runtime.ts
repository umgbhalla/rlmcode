// Neutral low-level runtime helpers shared by the agent and the orchestration
// modules. Extracted here so agent.ts (the turn() owner) and rlm-workflow.ts /
// orch-load.ts / orch-run.ts (the orchestration drivers) all pull the SAME model
// id, AI service, budget ceilings, node-event sink and usage reader from a module
// that imports NONE of them — breaking the old agent ⇄ rlm-workflow static cycle.
import { ai, type AxAIService, type AxRateLimiterFunction } from "@ax-llm/ax"
import * as Effect from "effect/Effect"
import { type ActivitySink, type BudgetUsage, emit, type NodeEvent } from "./orch.ts"
import { makeMockAI } from "./mock-ai.ts"
import { KIMI, MODEL_DOC } from "./models.ts"

// MODEL — the DEFAULT session model id (Kimi K2.7), sourced from the model registry
// (src/models.ts) so the default and the routing pool can never drift apart.
export const MODEL = KIMI

// SERVICE-LEVEL throttle: a min-interval (token-free) rate limiter attached to the CF-Kimi
// service so even an unbounded `parallel` fan-out (or many concurrent turns) never fires
// faster than RLM_MAX_RPS requests/second at the CF API. This is the SECOND throttle layer
// under parallelLimit (orch-recipes.ts) — parallelLimit caps how many forwards are IN FLIGHT;
// this caps how FAST they start. minIntervalRateLimiter serializes the start of each forward
// behind a shared `next-allowed` clock: each reqFunc waits until at least 1/RPS seconds after
// the previous one began, then runs. AxRateLimiterFunction must return the reqFunc's result
// (Promise or stream) — we just delay, then call through. Default 12 RPS (sensible for CF
// Workers AI); RLM_MAX_RPS overrides. Clamped to >= 0.1 so a bad env never divides by zero.
const MAX_RPS = (() => {
  const v = Number(process.env.RLM_MAX_RPS ?? 12)
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
// and every orchestration NODE (rlm-workflow.ts nodeGen). Lives HERE — the neutral
// cycle-breaker module that imports neither agent.ts nor rlm-workflow.ts — so a node can
// be as capable as the main agent MINUS orchestration without re-introducing the
// agent ⇄ rlm-workflow static init cycle (rlm-workflow.ts importing BASE_PROMPT from
// agent.ts deadlocked agent.ts's top-level `const chat = ax(...)` on RLM_WORKFLOW_TOOLS). The
// orchestration overlay (the rlm_workflow paragraphs) is appended ONLY
// to the main chat gen in agent.ts (RLM_WORKFLOW_OVERLAY) — a node never sees it, since a node
// carries BASE_TOOLS only and must not be told it can orchestrate.
export const BASE_PROMPT = [
  "You are a capable coding agent running inside a terminal, in the user's project directory.",
  "Tools: bash, read_file, write_file, edit_file, glob, grep. When a request needs real work,",
  "USE the tools to inspect/modify files and run commands BEFORE answering — don't guess.",
  "Verify with a tool when unsure. Keep replies concise and concrete; show the result that matters.",
  // DIRECT-ANSWER STEER (FIX C / over-exploration): a thinking model tends to over-explore — many
  // tool steps on a trivial ask. Steer it to match effort to the task: a simple question gets a
  // direct answer in ONE turn; only dig into files/commands when the task actually needs it.
  "Match effort to the task: answer a simple/trivial ask DIRECTLY in one turn — do NOT read files or run commands a trivial question doesn't need. Take only the tool steps the task truly requires; stop once you can answer.",
  "Format replies in GitHub-flavored markdown (use `code`, lists, and ```fences``` where helpful).",
  // MULTI-MODEL: tell the agent (and every node) the two-model pool + thinking-level knobs.
  MODEL_DOC,
].join(" ")

// max tool-call iterations per turn. Default 24 (FIX C / over-exploration): a thinking model was
// doing ~12 steps on a TRIVIAL ask under the old 50 ceiling — a tighter default bounds the blast
// radius of a runaway explore while leaving real multi-step work ample room. RLM_MAX_STEPS overrides
// (raise it for a genuinely long task). The ceiling is enforced GRACEFULLY in-loop (agent.ts
// finalizeOnMaxSteps forces a final reply with tools stripped), never a hard throw.
const MAX_STEPS = Number(process.env.RLM_MAX_STEPS ?? 24)
// Hard per-turn TOKEN ceiling, enforced by orch's Budget (charged after each node
// from the forward result's usage). Distinct from MAX_STEPS (tool-call iterations,
// still recovered by turn() in agent.ts): this is a real token gate that throws
// BudgetExhaustedError when a turn's cumulative usage crosses it.
const TOKEN_BUDGET = Number(process.env.RLM_TOKEN_BUDGET ?? 2_000_000)

// The shared AI service. Exported so turn() (agent.ts) and the rlm-workflow driver
// (rlm-workflow.ts) drive the SAME provider — one
// client, one trace. agent.ts attaches the live logger + rateLimiter via setOptions
// (inside createAgent) when it builds the default agent (mutating this shared instance
// in place). The finish-reason capture fetch is NO LONGER set here — it is now a
// PER-TURN forward option (a per-turn capture wrapper threaded into each turn's
// forward opts), so the latch is per-turn (concurrency-safe), not a service mutation.
// NARROW TEST-ONLY SEAM (off in prod): RLM_MOCK=1 swaps the eagerly-constructed CF
// service for the canned mock AI (mock-ai.ts — zero network). Without this, `ai({…})`
// throws "OpenAI API key not set" at module load when the CF env is absent, so a headless
// harness (no .env) can't even boot chat.tsx. Unset ⇒ the unchanged CF construction.
export const llm: AxAIService = process.env.RLM_MOCK === "1"
  ? makeMockAI()
  : ai({
      name: "openai",
      apiKey: process.env.CLOUDFLARE_API_TOKEN!,
      apiURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      config: { model: MODEL as any },
    })

// PER-TURN node-lifecycle sink factory handed to the runNode() recipe. Builds a NodeEvent sink
// closing over THIS turn's ActivitySink (the per-turn emit closure from runTurn) — REPLACING the
// old module-global onEvent that pushed into the deleted global activity sink. emit() is
// Effect<void> (an Effect.sync body: per-turn sink push + active-OTel-span addEvent); we run it
// synchronously at the session boundary so the recipe stays Promise-native and never touches
// Effect. runNode() runs inside otelContext.with(traceContext), so getActiveSpan() inside emit()
// resolves to the live chat.turn span (not a forked/empty context). The tool handlers
// (workflow.ts) build their onEvent from the per-turn emit recovered via getTurnEmit(sessionId).
export const makeOnEvent =
  (sink: ActivitySink) =>
  (event: NodeEvent): void =>
    Effect.runSync(emit(event, sink))

// PER-TURN emit registry, keyed by sessionId. ax forwards a FIXED extra to a tool handler
// (sessionId/ai/abortSignal/…) — NOT arbitrary forward opts — so a workflow/mock tool cannot
// read the turn's `emit` off `extra`. turn() stashes THIS turn's emit here by sessionId; the tool
// handler recovers it via getTurnEmit(extra.sessionId). This is the SAME sessionId-keyed per-turn
// store pattern as orch-spans' setTurnContext (also needed because ax drops the traceContext).
// Concurrency-correct: each session has its own entry; serialized turns (busyAtom) never collide.
// LEAK FIX (D3): this Map is keyed by a never-reused sessionId, so without an explicit drop on
// session close it accumulates one dead ActivitySink closure per session for the process lifetime.
// deleteSession (sessions.ts) calls clearTurnEmit alongside the sessionsRT drop so a closed
// session frees its entry — turns are serialized (busyAtom), so the entry is never live at close.
// ponytail: module Map keyed by sessionId. Upgrade: a context object threaded end-to-end if ax
// ever forwards arbitrary tool extras. Absent ⇒ no-op (a standalone tool call with no turn).
const turnEmits = new Map<string, ActivitySink>()
export const setTurnEmit = (sessionId: string, sink: ActivitySink): void => {
  turnEmits.set(sessionId, sink)
}
export const getTurnEmit = (sessionId: string | undefined): ActivitySink =>
  (sessionId !== undefined ? turnEmits.get(sessionId) : undefined) ?? (() => {})
// LEAK FIX (D3): drop a closed session's emit closure. Called from deleteSession so the per-turn
// emit registry never accumulates dead sessions. Returns whether an entry existed (for the test).
export const clearTurnEmit = (sessionId: string): boolean => turnEmits.delete(sessionId)

// Generic usage reader: a getUsage() probe over any AxGen the orchestration drivers
// forward. Exported so a sub-run charges the shared Budget from each node's usage,
// exactly like turn().
export const readUsageOf = (gen: unknown): BudgetUsage | undefined => {
  const u = (gen as { getUsage?: () => unknown }).getUsage?.()
  const last = Array.isArray(u) ? u[u.length - 1] : u
  return (last as { tokens?: BudgetUsage })?.tokens ?? (last as BudgetUsage | undefined)
}

// COST-METER: ask the AI service to estimate USD cost for a token total, when ax exposes
// it. getEstimatedCost(modelUsage) (AxAIService, node_modules/@ax-llm/ax/index.d.ts:1352)
// returns a per-1K-token estimate from the provider's model-info table; CF-Kimi has no
// price entry, so this is 0 there — we return undefined for 0/NaN so the UI shows nothing
// rather than "$0.00". `tokens` is the run total (the Budget's spent()); we synthesize a
// minimal AxModelUsage (only `tokens.totalTokens` is read by the estimator). Real ax type,
// no `any`: the estimator tolerates a partial usage with just the totals.
export const estimatedCostOf = (tokens: number): number | undefined => {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined
  try {
    const usage = { ai: "openai", model: MODEL, tokens: { promptTokens: 0, completionTokens: tokens, totalTokens: tokens } }
    const cost = llm.getEstimatedCost(usage)
    return Number.isFinite(cost) && cost > 0 ? cost : undefined
  } catch {
    return undefined
  }
}

// Tool-call iteration ceiling + per-orchestration token ceiling, so every
// orchestration driver builds NodeOpts/Budget with the same limits as turn().
export const limits = { maxSteps: MAX_STEPS, tokenBudget: TOKEN_BUDGET } as const
