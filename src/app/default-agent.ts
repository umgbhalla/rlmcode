// APP COMPOSITION LAYER — the DEFAULT agent + its turn boundary, wired for the in-repo TUI.
//
// This is the env-coupled glue the SDK must NOT carry: the SDK (src/core/sdk.ts) takes an
// injected AxAIService and has ZERO env branches. The app, by contrast, is allowed to read
// process.env and pick a concrete service — that decision lives HERE, not in core. Moving it
// out of agent.ts (hide #6) keeps the core agent factory pure DI.
//
// NARROW TEST-ONLY SEAM (off in prod): RLM_MOCK=1 swaps the CF service for the canned mock AI
// (mock-ai.ts — zero network), so the headless TUI gate drives the REAL turn loop with no
// Cloudflare env. The flag is read ONCE here; unset ⇒ the unchanged CF path. mock-ai.ts imports
// nothing from agent.ts, so the seam introduces no init cycle.
//
// LAYERING: src/app/* is the trusted composition layer (alongside src/core/*) — it may import
// core internals directly (the internal createAgent / makeRunTurn / sessions). Pure-presentation
// modules under src/tui/* may NOT; they consume the agent surface from THIS module and the public
// types from the src/core/sdk.ts barrel (enforced by the design-check 'crosscore' rule).
import { BASE_TOOLS } from "../core/tools.ts"
import { createAgent, projectDocLoaded } from "../core/agent.ts"
import { makeRunTurn } from "../core/run.ts"
import { makeMockAI, MOCK_MODEL } from "../core/mock-ai.ts"
import { MOCK_DIFF_TOOL, MOCK_ORCH_TOOL, MOCK_RATELIMIT_TOOL, MOCK_TRANSCRIPT_TOOL } from "../core/mock.ts"
import { llm, MODEL } from "../core/runtime.ts"
import { deleteSession, seedSession, sessionsRT } from "../core/sessions.ts"

// The DEFAULT app agent — constructed ONCE over the CF-Kimi `llm` (runtime.ts) at the app's
// default model, or the canned mock AI under RLM_MOCK. This is the single construction site the
// TUI pulls its turn boundary from.
const defaultAgent =
  process.env.RLM_MOCK === "1"
    ? createAgent({ ai: makeMockAI(process.env.RLM_MOCK_STREAM === "1"), model: MOCK_MODEL, tools: [...BASE_TOOLS, MOCK_ORCH_TOOL, MOCK_TRANSCRIPT_TOOL, MOCK_DIFF_TOOL, MOCK_RATELIMIT_TOOL] })
    : createAgent({ ai: llm, model: MODEL })

// The DEFAULT-agent turn boundary used by the TUI's sendAtom: a serializable AsyncGenerator of
// flat TurnEvents over the module default agent. (An SDK consumer builds its own via the barrel's
// createAgent → Agent.runTurn; this is the app's pre-wired equivalent.)
export const runTurn = makeRunTurn(defaultAgent)

// Cancel the default agent's in-flight turn for a session (wraps the agent's per-session abort).
export const abortTurn = defaultAgent.abortTurn

// Which project instruction file (AGENTS.md / CLAUDE.md) folded into the system prompt, if any —
// surfaced in the TUI header. App-display only; re-exported here so the TUI never reaches into core.
export { projectDocLoaded }

// Per-session runtime store (the non-serializable AxMemory + root-span Map) the TUI drives
// directly: newSessionAtom sets a richer chat.session root span, deleteSessionAtom releases it.
// App-internal plumbing — re-exported here so src/tui/* never deep-imports src/core/sessions.ts.
export { deleteSession, seedSession, sessionsRT }

// The model POOL (the two routable thinking models) + its name type — surfaced for the TUI's model
// picker (dialogs.tsx). App-display only; re-exported through this composition layer so src/tui/*
// reads the pool WITHOUT deep-importing src/core/models.ts (the crosscore boundary). The picker maps
// a chosen ModelName → MODELS[name].id for the composer's model label.
export { MODELS } from "../core/models.ts"
export type { ModelName } from "../core/models.ts"
