// Per-session runtime objects that can't live in serializable atom state.
// Each session owns its own AxMemory (isolated multi-turn history) and a reusable
// parent span handle (an ExternalSpan built from the session root span's IDs).
// Every turn parents to it -> all turns share one traceId -> motel renders the
// whole session as a single trace tree.
import { AxMemory } from "@ax-llm/ax"
import type { AnySpan } from "effect/Tracer"

export type SessionRT = {
  readonly mem: AxMemory
  readonly parent: AnySpan
}

export const sessionsRT = new Map<string, SessionRT>()

// LEAK FIX: drop a closed session's runtime objects (its AxMemory + the ExternalSpan
// handle) so a long-lived process doesn't accumulate dead sessions' memory. The Map is
// the ONLY non-serializable session store (atoms holds the serializable view); closing a
// session in the UI must call this so its mem is released. Returns whether an entry existed.
export const deleteSession = (id: string): boolean => sessionsRT.delete(id)
