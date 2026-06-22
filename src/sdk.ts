// Public SDK surface for ax2 core. External callers import ONLY from here.
//
// This module is a pure RE-EXPORT seam — zero logic of its own. It collects the
// public value + type surface from its real homes (orch.ts, orch-recipes.ts,
// tools.ts, agent.ts, …) so a caller in another repo can
// `import { createAgent, node, judge, ... } from '<ax2>/src/sdk.ts'`
// without reaching into internal modules. Nothing here changes runtime behaviour.

// ── orch core: the EXACTLY-5 primitives + the typed budget surface ──────────────
// node() is the engine's "node": the ONLY thing that calls ax.forward(). parallel/
// pipeline/allocate are the other core prims. emit() is Effect<void> and is
// SESSION-BOUNDARY only (run it where an Effect runtime exists, e.g. inside turn()).
// BudgetExhaustedError is the typed throwable — re-exported from orch.ts, never redefined.
export {
  /** Core prim: ADVISORY token gate (soft/hard ceilings). */
  allocate,
  /** Core prim: the typed throwable budget breach (from orch.ts, never redefined). */
  BudgetExhaustedError,
  /** Core prim: thin Effect<void> hook over the activity bus + active OTel span — SESSION-BOUNDARY only. */
  emit,
  /** Core prim ("node"): the only thing that calls ax.forward(); curried (gen, opts) -> (ai, input). */
  node,
  /** Core prim: the only fan-out — failed slots resolve to null. */
  parallel,
  /** Core prim: the only sequence — async-generator stage fan-through. */
  pipeline,
} from "./orch.ts"
export type {
  /** Advisory token-gate handle (soft/hard ceilings, charge/spent/remaining). */
  Budget,
  /** A node's token-usage triple charged into a Budget. */
  BudgetUsage,
  EmitOpts,
  /** The forward()-opts superset threaded to node() (mem, tracer, maxSteps, fetch, …). */
  NodeOpts,
  /** A node lifecycle event (start | delta | done | error) over the activity bus. */
  NodeEvent,
} from "./orch.ts"

// ── orch recipes (USERLAND, not core): composition over the 5 prims ─────────────
export {
  /** Recipe: produce once, then skeptics vote accept/reject in parallel. */
  adversarialVerify,
  /** Recipe: N candidates -> one node picks the best verbatim. */
  judge,
  /** Recipe: run body until isDry(prev,next) converges (or max). */
  loopUntilDry,
  /** Recipe: run ONE node bracketed by start->done|error lifecycle events. */
  runNode,
} from "./orch-recipes.ts"
export type {
  /** The node-spec shape runNode() consumes. */
  AgentNode,
  /** A sink that records a NodeEvent (the session boundary supplies the real emit()). */
  EmitSink,
} from "./orch-recipes.ts"

// ── default tool registry + the ax function type ────────────────────────────────
/** The default tool registry (bash/read/write/edit/glob/grep). */
export { BASE_TOOLS as tools } from "./tools.ts"
export type { AxFunction } from "@ax-llm/ax"

// ── agent factory: the INJECTION SEAM ───────────────────────────────────────────
// Pass your OWN AxAIService (OpenAI, Ollama, a stub), tools, model + limits and run
// turns with NO Cloudflare env. createAgent returns { turn, abortTurn }; turn() is an
// Effect-returning session entry — run it at the boundary (Effect.runPromise).
export {
  /** Cancel the default agent's in-flight turn for a session (the app's abortTurn). */
  abortTurn,
  /** Build an agent over an injected AxAIService + tools/model/limits. */
  createAgent,
  /** The app default agent (CF-Kimi) — convenience for callers that want today's wiring. */
  defaultAgent,
} from "./agent.ts"
export type {
  /** createAgent input: { ai, model, maxSteps?, tokenBudget?, tools?, logger? }. */
  AxAgentConfig,
  /** createAgent output: { turn, abortTurn }. */
  AxAgentSDK,
  /** A single turn's result (reply + tokens + reasoning + finishReason + budget flag). */
  TurnResult,
} from "./agent.ts"

// ── ax re-exports so a caller types config + builds session memory without a direct
// ax import ──────────────────────────────────────────────────────────────────────
/** Per-session conversation memory — pass `new AxMemory()` to turn(). */
export { AxMemory } from "@ax-llm/ax"
/** The AI-service interface createAgent's `ai` field expects (inject your provider). */
export type { AxAIService } from "@ax-llm/ax"
