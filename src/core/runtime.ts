// Neutral low-level runtime helpers shared by the agent and the orchestration
// modules. Extracted here so agent.ts (the turn() owner) and rlm-workflow.ts /
// orch-load.ts / orch-run.ts (the orchestration drivers) all pull the SAME model
// id, AI service, budget ceilings, node-event sink and usage reader from a module
// that imports NONE of them — breaking the old agent ⇄ rlm-workflow static cycle.
import { ai, type AxAIService, type AxRateLimiterFunction } from "@ax-llm/ax"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Semaphore from "effect/Semaphore"
import { type ActivitySink, type BudgetUsage, emit, type NodeEvent } from "./orch.ts"
// CYCLE-BREAKER RE-EXPORT: clip + tokensOf are defined ONCE in orch.ts; runtime.ts re-exports
// them so the orchestration drivers (workflow.ts / rlm-node.ts) — which already import runtime.ts
// but must NOT deep-import orch internals across the layer boundary — share the single copy.
export { clip, tokensOf } from "./orch.ts"
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
// EFFECT-NATIVE CONFIG (adoption #2/#3): ONE validated parse of every RLM_* env knob +
// the redacted CF token at boot, instead of eight inline `Number(process.env.X)` reads that
// each re-clamp on access (the old processEnvInEffect smell). `Config.number(name).pipe(
// withDefault(d))` reads the env via the default ConfigProvider (fromEnv → process.env) and
// falls back to `d` on a MISSING key; a PRESENT-but-non-numeric value yields NaN here (Config
// does not throw for it), so the existing clamp helpers below still map a bad value to its
// default — preserving the prior "a bad env never throws" behaviour BYTE-FOR-BYTE. The token is
// Config.redacted → a Redacted<string> (opaque, safe-to-log); unwrapped ONLY at the ai() boundary.
// withDefault("") keeps the old `?? undefined`-then-`!` shape: absent ⇒ "" (the CF call errors at
// request time exactly as the old `process.env.CLOUDFLARE_API_TOKEN!` did when unset).
const ENV = Effect.runSync(
  Config.all({
    maxRps: Config.number("RLM_MAX_RPS").pipe(Config.withDefault(12)),
    maxBacklog: Config.number("RLM_MAX_BACKLOG").pipe(Config.withDefault(8)),
    nodeMaxRps: Config.number("RLM_NODE_MAX_RPS").pipe(Config.withDefault(Number.NaN)),
    maxSteps: Config.number("RLM_MAX_STEPS").pipe(Config.withDefault(24)),
    tokenBudget: Config.number("RLM_TOKEN_BUDGET").pipe(Config.withDefault(2_000_000)),
    cfApiToken: Config.redacted("CLOUDFLARE_API_TOKEN").pipe(Config.withDefault(Redacted.make(""))),
    cfAccountId: Config.string("CLOUDFLARE_ACCOUNT_ID").pipe(Config.withDefault("")),
    mock: Config.string("RLM_MOCK").pipe(Config.withDefault("")),
  }),
)

const MAX_RPS = (() => {
  const v = ENV.maxRps
  return Number.isFinite(v) && v > 0 ? Math.max(0.1, v) : 12
})()
// CONTENTION (FIX B / STUCK-ANALYSIS R2+R5): chat turns AND background workflow nodes USED to share
// this ONE limiter (nodes reuse the same `llm` service — workflow.ts `extra.ai ?? llm`), a single
// global `nextAllowed` clock. The defect: `nextAllowed` grew UNBOUNDED — a `parallel` burst of N
// node starts pushes the clock to now+N*interval, so the INTERACTIVE chat turn's NEXT forward
// reserves BEHIND all N and waits ~N*interval. With N up to parallelLimit's cap that starves a
// user's turn behind a background fan-out (the "crawl" amplifier). Two guards, COMPOSED:
//   (1) BACKLOG CAP (within a lane): `nextAllowed` may run at most RLM_MAX_BACKLOG intervals ahead of
//       `now`, so ANY single caller waits AT MOST backlog*interval no matter how large the burst.
//       Steady-state RPS is unchanged (one start per interval); only the WORST-CASE wait behind a
//       flood is bounded — anti-thundering-herd staggering kept, unbounded starvation removed.
//   (2) SEPARATE LANES (chat priority): the chat turn keeps the fast `rateLimiter` (bound on the
//       shared service via agent.ts setOptions); every background workflow NODE forward instead
//       carries `nodeRateLimiter` on its forward opts (workflow-prims optsFor) — its OWN clock, at
//       RLM_NODE_MAX_RPS (default = half MAX_RPS, a courteous background lane). ax lets a forward's
//       rateLimiter override the service one (same as logger/debug/fetch). So a background `parallel`
//       burst reserves slots on the NODE clock — it can NEVER push the chat clock's `nextAllowed`
//       forward — and the interactive turn's next step is throttled ONLY by its own (private) lane +
//       the backlog cap, not by N*interval of the fan-out. The per-call latency the chat turn sees
//       under concurrent background load is now bounded by its own lane alone.
// This realizes the upgrade the old ponytail named (a second AxRateLimiterFunction on the node
// forward opts so background nodes throttle on a SEPARATE clock); the node call site now threads it.
// ponytail: the chat lane is the SERVICE-level limiter (every non-node forward on the shared service
// shares it); a node is distinguished structurally (it carries `nodeRateLimiter` on its forward opts,
// the chat turn does not). Upgrade: a first-class per-forward `priority` field if ax ever surfaces
// caller identity in the limiter `info` arg, so lanes need no out-of-band opts wiring.
const MAX_BACKLOG = (() => {
  const v = ENV.maxBacklog
  return Number.isFinite(v) && v > 0 ? Math.max(1, Math.floor(v)) : 8
})()
// BACKGROUND-NODE lane RPS: background workflow nodes throttle on their OWN clock (nodeRateLimiter
// below) at this rate, separate from the chat turn's MAX_RPS lane — so a node fan-out can't starve a
// user's interactive turn. Default = half MAX_RPS (the background lane yields to the interactive one);
// RLM_NODE_MAX_RPS overrides. Same clamp as MAX_RPS (>= 0.1 so a bad env never divides by zero).
const NODE_MAX_RPS = (() => {
  const v = ENV.nodeMaxRps
  return Number.isFinite(v) && v > 0 ? Math.max(0.1, v) : MAX_RPS / 2
})()
// EFFECT-NATIVE (adoption #4/#12): the min-interval stagger is computed over the Effect Clock
// (Clock.currentTimeMillis) and the wait is an Effect.sleep — NOT Date.now() + a raw setTimeout.
// So the throttle interval is DETERMINISTIC under `TestClock.adjust` (the rate-limiter unit proves
// "two starts are >= one interval apart" + "the backlog cap bounds the worst-case wait" INSTANTLY,
// zero real wall-clock), while production runs it on the live clock for identical behaviour.
//
// SEMAPHORE (adoption #4): the slot RESERVATION (the read-then-write of `nextAllowed`) runs under a
// 1-permit `Semaphore.withPermits(1)` so concurrent callers reserve ATOMICALLY — no two forwards
// can interleave the clock read + advance and claim the SAME slot (the old bare closure mutation
// was only correct because JS is single-threaded between awaits; the permit makes the invariant
// explicit and composable with retry/timeout). Each makeRateLimiter() mints its OWN semaphore, so
// the two lanes (chat vs node) reserve on SEPARATE clocks AND separate permits — the two-lane
// behaviour is preserved exactly. reserveSlot returns the wait ms so a test can assert the schedule
// without the sleep; the semaphore is a no-op for a single sequential reserver (the test path).
export const makeRateLimiter = (
  rps: number,
  maxBacklog: number,
): { readonly limiter: AxRateLimiterFunction; readonly reserveSlot: Effect.Effect<number> } => {
  const interval = 1000 / rps
  const cap = maxBacklog * interval // the clock may lead `now` by at most this many ms
  let nextAllowed = 0
  // ONE permit per lane: serializes the reservation so the `nextAllowed` claim+advance is atomic.
  const gate = Semaphore.makeUnsafe(1)
  // reserveSlot: claim this caller's start slot against the shared `nextAllowed` clock and RETURN
  // the ms to wait. Clamp the start to within `cap` of now: a flood can't push this caller's slot
  // (or any later one — incl. the interactive turn) arbitrarily far into the future. `start` is the
  // SOONEST free slot that respects both the per-interval stagger and the backlog cap; the NEXT
  // slot is reserved one interval past it so concurrent callers still stagger. Wrapped in the
  // 1-permit gate so concurrent reservations are atomic (no two callers claim the same slot).
  const reserveSlot: Effect.Effect<number> = gate.withPermits(1)(
    Effect.map(Clock.currentTimeMillis, (now) => {
      const start = Math.min(Math.max(now, nextAllowed), now + cap)
      nextAllowed = start + interval
      return start - now
    }),
  )
  const limiter: AxRateLimiterFunction = (reqFunc) =>
    Effect.runPromise(
      Effect.flatMap(reserveSlot, (wait) =>
        wait > 0 ? Effect.as(Effect.sleep(Duration.millis(wait)), undefined) : Effect.succeed(undefined),
      ),
    ).then(() => reqFunc())
  return { limiter, reserveSlot }
}
// The CHAT-lane limiter instance — attached in agent.ts's setOptions (the ONE setOptions call,
// since setOptions reassigns every field). Exported so the live harness's standalone service
// can attach the SAME throttle and the bounded-fan-out gate exercises the real limited path.
export const rateLimiter: AxRateLimiterFunction = makeRateLimiter(MAX_RPS, MAX_BACKLOG).limiter

// The BACKGROUND-NODE lane limiter — a SEPARATE clock (its own `nextAllowed`) from the chat lane,
// so a background workflow fan-out reserves slots here and can never push the chat lane forward.
// Threaded onto every node forward's opts at the single chokepoint (workflow-prims optsFor); a
// per-forward rateLimiter overrides the service-level one (FIX B / STUCK-ANALYSIS R2). Same backlog
// cap so a within-lane burst is also bounded. Exported for the wiring + the contention measure.
export const nodeRateLimiter: AxRateLimiterFunction = makeRateLimiter(NODE_MAX_RPS, MAX_BACKLOG).limiter

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
const MAX_STEPS = ENV.maxSteps
// Hard per-turn TOKEN ceiling, enforced by orch's Budget (charged after each node
// from the forward result's usage). Distinct from MAX_STEPS (tool-call iterations,
// still recovered by turn() in agent.ts): this is a real token gate that throws
// BudgetExhaustedError when a turn's cumulative usage crosses it.
const TOKEN_BUDGET = ENV.tokenBudget

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
export const llm: AxAIService = ENV.mock === "1"
  ? makeMockAI()
  : ai({
      name: "openai",
      // SECRET BOUNDARY (adoption #3): the token rode here as an opaque Redacted<string>
      // (never logged, never on a span) — Redacted.value() unwraps it ONLY at this ax service
      // construction call, the single point that needs the raw secret.
      apiKey: Redacted.value(ENV.cfApiToken),
      apiURL: `https://api.cloudflare.com/client/v4/accounts/${ENV.cfAccountId}/ai/v1`,
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
