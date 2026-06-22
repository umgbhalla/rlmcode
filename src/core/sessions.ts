// Per-session runtime objects that can't live in serializable atom state.
// Each session owns its own AxMemory (isolated multi-turn history) and a reusable
// parent span handle (an ExternalSpan built from the session root span's IDs).
// Every turn parents to it -> all turns share one traceId -> motel renders the
// whole session as a single trace tree.
import { AxMemory } from "@ax-llm/ax"
import * as Tracer from "effect/Tracer"
import type { AnySpan } from "effect/Tracer"

export type SessionRT = {
  readonly mem: AxMemory
  readonly parent: AnySpan
}

export const sessionsRT = new Map<string, SessionRT>()

// LAZY session open for the SDK path: the TUI pre-creates a session (newSessionAtom builds a
// real chat.session root span on appRuntime), but a headless SDK consumer just calls
// runTurn(sessionId, …) — so ensure the runtime objects exist on first use. The parent here is a
// detached external span (no live session-root trace), which is fine for an embedded consumer
// that doesn't run motel; a turn still parents to it, so a session's turns share one traceId.
// Idempotent: returns the existing entry if already opened (so the TUI's richer span is kept).
export const ensureSession = (id: string): SessionRT => {
  const existing = sessionsRT.get(id)
  if (existing !== undefined) return existing
  const parent = Tracer.externalSpan({ traceId: "0".repeat(32), spanId: "0".repeat(16), sampled: false })
  const rt: SessionRT = { mem: new AxMemory(), parent }
  sessionsRT.set(id, rt)
  return rt
}

// LEAK FIX: drop a closed session's runtime objects (its AxMemory + the ExternalSpan
// handle) so a long-lived process doesn't accumulate dead sessions' memory. The Map is
// the ONLY non-serializable session store (atoms holds the serializable view); closing a
// session in the UI must call this so its mem is released. Returns whether an entry existed.
export const deleteSession = (id: string): boolean => sessionsRT.delete(id)
