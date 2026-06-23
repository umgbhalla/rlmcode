// PUBLIC SDK SURFACE — the ONLY importable module (package.json "exports" points here). A thin
// barrel: zero engine logic, just the createAgent factory + the public types. An external
// consumer imports `{ createAgent }` and types, injects its OWN AxAIService, and drives turns as a
// plain AsyncGenerator — NO Effect, NO @effect/atom, NO OTel wiring, NO @ax-llm/ax beyond the two
// type re-exports below. Everything Effect/Cause/AxMemory/AxSpan stays behind this seam.
//
// SDK-GRADE TARGET (claude_code QueryEngine model): single process, ONE in-flight turn per session
// (the consumer serializes; the engine does not multiplex). The AsyncGenerator IS the remote seam
// — only the fully-serializable TurnEvent crosses it; the only input is (sessionId, message).
import type { AxAIService, AxFunction } from "@ax-llm/ax"
import { BASE_TOOLS } from "./tools.ts"
import { CHAT_TOOLS, createAgent as createInternalAgent, SYSTEM_PROMPT_CHARS } from "./agent.ts"
import { makeRunTurn, type TurnEvent, type TurnOptions } from "./run.ts"
import { deleteSession } from "./sessions.ts"

// Re-export the serializable event/result vocabulary + the two ax types a consumer needs to build
// its AxAIService and tool list. NOTHING else from ax (no AxMemory/AxGen/AxSpan) crosses.
export type { TurnEvent, TurnOptions, TurnResult } from "./run.ts"
export type { StopReason, TokenUsage, TurnError } from "./run.ts"
export type { AxAIService, AxFunction } from "@ax-llm/ax"

// A clean, serializable log line — NOT ax's AxLoggerFunction (which carries ax-internal shapes).
export type LogLine = {
  readonly level: "debug" | "info" | "warn" | "error"
  readonly msg: string
  readonly sessionId?: string
  readonly fields?: Record<string, string | number | boolean>
}

// createAgent input. `ai` + `model` are required; everything else defaults to today's app values.
// tools: 'default' = the full chat toolset (file/shell + the `workflow` self-orchestration tool);
// 'base' = file/shell only (a node-grade agent that cannot orchestrate); or an explicit list.
export interface AgentOptions {
  readonly ai: AxAIService
  readonly model: string
  readonly maxSteps?: number
  readonly tokenBudget?: number
  readonly tools?: "default" | "base" | readonly AxFunction[]
  readonly systemPromptAppend?: string
  readonly loadProjectDoc?: boolean
  // Telemetry is ALWAYS ON: the engine runs on the shared coreRuntime (TracingLive), which
  // best-effort exports OTel spans/logs/metrics to the local motel and silently no-ops when
  // motel is absent — so an embedded consumer needs ZERO OTel wiring and pays nothing when no
  // collector listens. There is no opt-out knob by design (one runtime, one trace tree).
  // ponytail: onLog accepted on the surface but not yet fed — the engine logs via Effect.log to
  // OTel today. Upgrade: a per-turn log tap that maps Effect log records to LogLine (Seal phase).
  readonly onLog?: (line: LogLine) => void
}

export interface AgentInfo {
  readonly model: string
  readonly maxSteps: number
  readonly tokenBudget: number
  readonly toolNames: readonly string[]
  readonly systemPromptChars: number
  readonly version: string
  readonly axVersion: string
}

export interface Agent {
  // Drive ONE turn as a serializable event stream. Effect runs INSIDE on the app runtime; the
  // final yield is ALWAYS {type:'reply'} — even on error/abort. Plain async-gen, for-await-of.
  runTurn(sessionId: string, message: string, opts?: TurnOptions): AsyncGenerator<TurnEvent, void, void>
  // Cancel this session's in-flight turn. Returns whether a turn was actually aborted.
  abort(sessionId: string): boolean
  // Drop a session's runtime objects (AxMemory + root span). Returns whether an entry existed.
  closeSession(sessionId: string): boolean
  // Read-only agent metadata.
  info(): AgentInfo
}

const RLM_VERSION = "0.1.0"
const AX_VERSION = "22.0.5"

// Resolve the tools option to a concrete AxFunction[] (the internal createAgent's input).
const resolveTools = (tools: AgentOptions["tools"]): AxFunction[] | undefined =>
  tools === undefined || tools === "default" ? undefined : tools === "base" ? [...BASE_TOOLS] : [...tools]

/**
 * Build an agent over an injected AxAIService. Returns the public Agent — a plain runTurn
 * AsyncGenerator + abort/closeSession/info. NO Effect / @effect/atom / OTel wiring required.
 */
export function createAgent(options: AgentOptions): Agent {
  const maxSteps = options.maxSteps ?? 50
  const tokenBudget = options.tokenBudget ?? 2_000_000
  const tools = resolveTools(options.tools)

  // Build the internal Effect-backed agent and bind the turn boundary to ITS driver (turn +
  // abortTurn). createInternalAgent returns exactly the TurnDriver shape makeRunTurn consumes.
  const internal = createInternalAgent({
    ai: options.ai,
    model: options.model,
    maxSteps,
    tokenBudget,
    ...(tools !== undefined ? { tools } : {}),
  })
  const runTurn = makeRunTurn(internal)

  // info().toolNames mirrors the internal gen's registered tools: the resolved list, or the
  // default chat toolset when 'default'/unset.
  const toolNames = (tools ?? CHAT_TOOLS).map((f) => f.name)

  return {
    runTurn,
    abort: (sessionId: string): boolean => internal.abortTurn(sessionId),
    closeSession: (sessionId: string): boolean => deleteSession(sessionId),
    info: (): AgentInfo => ({
      model: options.model,
      maxSteps,
      tokenBudget,
      toolNames,
      systemPromptChars: SYSTEM_PROMPT_CHARS,
      version: RLM_VERSION,
      axVersion: AX_VERSION,
    }),
  }
}
