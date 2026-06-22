// Live activity bus fed by ax's NATIVE logger (AxLoggerFunction). ax calls the
// logger during forward() as steps happen — agent narration, tool calls, tool
// results — so the TUI renders step-by-step (NOT token-by-token). sendAtom
// installs a sink for the duration of a turn.
export type Activity =
  | { readonly kind: "text"; readonly text: string } // agent narration for a step
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly args: string } // call, in-flight
  | { readonly kind: "result"; readonly id: string; readonly result: string; readonly isError: boolean } // updates the call in place
  | { readonly kind: "node"; readonly nodeId: string; readonly event: string; readonly parentId?: string | undefined; readonly detail?: string | undefined } // orchestration node lifecycle (orch.emit)

// ponytail: single global sink — assumes one in-flight turn (the UI gates this).
// Ceiling: concurrent turns would interleave events. Upgrade: Effect PubSub/Queue scoped per turn.
const sinkState: { sink: ((a: Activity) => void) | null } = { sink: null }

export const setActivitySink = (f: ((a: Activity) => void) | null) => {
  sinkState.sink = f
}

export const emitActivity = (a: Activity) => {
  try {
    sinkState.sink?.(a)
  } catch {
    /* never let UI plumbing break the agent */
  }
}
