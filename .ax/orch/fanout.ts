// fanout — PARALLEL fan-out over DISTINCT subtasks (division of labour). TRUSTED,
// loaded from .ax/orch/ by src/orch-load.ts via runtime import(). Receives the run
// ctx + the injected prims toolkit and composes them; nodes render live in the SAME
// OrchTree as orch-run (ctx.onEvent → emit()). NO runtime ax imports — everything
// comes through `prims`, so the engine core stays exactly 5 prims.
//
// THE POINT: each branch works a DIFFERENT, independent piece of the work concurrently
// — NOT N redundant copies of the same task. parallel() fans them out; each branch runs
// runNode() over its OWN forked memory (ctx.optsFor() returns a fresh AxMemory per call,
// never shared across concurrent nodes); failed slots resolve to null and are dropped.
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

// The DISTINCT subtasks — division of labour, one per branch. Hard-coded here for a
// reusable flow; a real script could derive them from ctx.message.
const SUBTASKS = [
  "Audit src/auth for security bugs and report concrete findings.",
  "Check whether the tests cover the auth edge cases (expiry, replay, missing token).",
  "Review the error-handling paths in the auth flow for leaks or swallowed errors.",
] as const

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { parallel, runNode, gen } = prims

  // One node per distinct subtask. parallel() runs them concurrently; each gets a FRESH
  // forked memory via optsFor() so their tool histories never interleave/corrupt.
  const replies = await parallel(
    SUBTASKS.map((subtask, i) => async () => {
      const nodeId = `${rootId}/branch-${i}`
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `branch ${i + 1}` })
      const out = await runNode(
        {
          nodeId,
          parentId: rootId,
          gen: gen("message:string -> reply:string", "Do the task end-to-end and report your findings concisely in markdown."),
          opts: optsFor(),
          onEvent,
          phase: `branch ${i + 1}`,
          budget,
          usageOf: (g) => usageOf(g),
        },
        ai,
        { message: subtask },
      )
      return (out as { reply?: string }).reply ?? ""
    }),
  )

  // parallel() maps a failed branch to null; keep the non-empty replies and number them.
  const kept = replies.filter((r): r is string => typeof r === "string" && r.length > 0)
  if (kept.length === 0) return { reply: "(all branches failed)" }
  const reply = kept.map((r, i) => `### ${SUBTASKS[i] ?? `branch ${i + 1}`}\n\n${r}`).join("\n\n")
  return { reply, branches: kept.length }
}
