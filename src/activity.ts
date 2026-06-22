import type { AxLoggerFunction } from "@ax-llm/ax"

// Live activity bus fed by ax's NATIVE logger (AxLoggerFunction). ax calls the
// logger during forward() as steps happen — agent narration, tool calls, tool
// results — so the TUI renders step-by-step (NOT token-by-token). sendAtom
// installs a sink for the duration of a turn.
export type Activity =
  | { readonly kind: "text"; readonly text: string } // agent narration for a step
  // PER-NODE TOOL ROUTING: an OPTIONAL `nodeId` tags a tool/result with the orchestration
  // NODE that OWNS it (a node is its own sub-agent — its own forward + BASE_TOOLS). When set,
  // the atoms reducer attaches the tool to THAT node's tool list (NodeView renders it under
  // the node) instead of the main transcript. Absent ⇒ the MAIN turn (tools → transcript, the
  // unchanged default). The tag is supplied by a per-node logger (makeNodeLogger) bound to the
  // node's id at its forward() — concurrency-correct: parallel nodes each close over their OWN
  // id, so their tools never interleave into one stream.
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly args: string; readonly nodeId?: string | undefined } // call, in-flight
  | { readonly kind: "result"; readonly id: string; readonly result: string; readonly isError: boolean; readonly nodeId?: string | undefined } // updates the call in place
  | { readonly kind: "node"; readonly nodeId: string; readonly event: string; readonly parentId?: string | undefined; readonly detail?: string | undefined; readonly tokens?: number | undefined } // orchestration node lifecycle (orch.emit) — `tokens` is the cost-meter per-node usage on a done event
  // STREAMING (stream:true): live deltas of the MAIN turn's final reply + reasoning, fed from
  // ax's per-chunk logger (ChatResponseResults / …StreamingDoneResult). `text` is the chunk
  // piece; atoms appends it to the in-flight agent message (reply grows / thinking fills). Only
  // the MAIN turn emits these (the per-node logger carries a nodeId and does NOT) so a node's
  // streamed text never leaks into the transcript. The final reply is reconciled to the
  // authoritative turn() result at turn end, so a coarse/absent live stream degrades to
  // "reply appears at the end" — never wrong, just less live.
  | { readonly kind: "replyDelta"; readonly text: string } // a piece of the streamed final reply
  | { readonly kind: "thinkingDelta"; readonly text: string } // a piece of the streamed reasoning_content

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

// Tool-call args as a string for the UI. ax hands params as a string or object; we
// stringify the object case. (Same logic the main-turn liveLogger uses — kept here so
// both the main and per-node loggers share ONE mapping.)
const argStr = (p: unknown) => (typeof p === "string" ? p : JSON.stringify(p ?? {}))

// Map ax's NATIVE step feed (AxLoggerData) onto the activity bus. ax calls this during
// forward() as steps complete: per-step agent narration, tool calls, tool results. The
// optional `nodeId` is STAMPED onto every tool/result activity this logger emits, so a
// node's tools land under THAT node (atoms routes by nodeId). id correlates a call with
// its result so the row updates in place.
const emitFromLog = (m: { name?: string; value?: unknown }, nodeId?: string) => {
  type Call = { id: string; function: { name: string; params?: string | object } }
  type StepResult = { content?: string; functionCalls?: ReadonlyArray<Call>; thought?: string }
  // The streamed reply + reasoning come from turn()'s streamingForward DRAIN (agent.ts) — the
  // ONLY live path (plain forward collapses to one done-result). Here we only surface step
  // narration + tool calls; the logger's once-at-end results never feed the reply/thinking.
  const emitStep = (results: ReadonlyArray<StepResult>) => {
    for (const r of results) {
      const calls = r.functionCalls ?? []
      if (calls.length > 0 && r.content && r.content.trim()) emitActivity({ kind: "text", text: r.content.trim() })
      for (const fc of calls) emitActivity({ kind: "tool", id: fc.id, name: fc.function.name, args: argStr(fc.function.params), nodeId })
    }
  }
  switch (m.name) {
    case "ChatResponseResults":
      emitStep(m.value as StepResult[])
      break
    case "ChatResponseStreamingDoneResult":
      emitStep([m.value as StepResult])
      break
    case "FunctionResults":
      for (const fr of m.value as ReadonlyArray<{ functionId: string; result: unknown; isError?: boolean }>)
        emitActivity({ kind: "result", id: fr.functionId, result: String(fr.result).slice(0, 4000), isError: Boolean(fr.isError), nodeId })
      break
    default:
      break
  }
}

// The MAIN-turn logger (no nodeId) — its tool/result activities go to the transcript.
// Bound onto the shared llm service in agent.ts (the default for the main chat gen).
export const liveLogger: AxLoggerFunction = (m) => emitFromLog(m)

// PER-NODE logger factory: returns an AxLoggerFunction that STAMPS every tool/result it
// emits with `nodeId`, so the node's own tools route to its OrchTree node (not the main
// transcript). Passed in a node's forward() opts (NodeOpts.logger) — concurrency-correct:
// each parallel node builds its OWN logger closing over its OWN id, so tools never interleave.
export const makeNodeLogger = (nodeId: string): AxLoggerFunction => (m) => emitFromLog(m, nodeId)
