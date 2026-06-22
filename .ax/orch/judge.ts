// judge — BEST-OF-N: run N REDUNDANT attempts at the SAME task, then one judge node
// picks the single best VERBATIM. TRUSTED, loaded from .ax/orch/ by src/orch-load.ts
// via runtime import(). NO runtime ax imports — everything comes through `prims`.
//
// THE POINT: this is the ONE case where N copies of the same task is correct — you want
// redundancy, not division of labour. parallel() fans out N candidate nodes (each over a
// FORKED memory via optsFor()), then the judge() recipe runs ONE judge node that reads
// all candidates and returns the best one verbatim. Contrast fanout.ts (DISTINCT work).
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

const N = 3

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { parallel, runNode, judge, gen } = prims

  // N redundant candidate nodes — SAME task, fresh forked memory each (never shared
  // across concurrent nodes). A distinct persona per branch diversifies the attempts.
  const personas = ["a terse senior engineer", "a thorough investigator", "a careful reviewer"]
  const candidates = await parallel(
    Array.from({ length: N }, (_, i) => async () => {
      const nodeId = `${rootId}/cand-${i}`
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `candidate ${i + 1}` })
      const out = await runNode(
        {
          nodeId,
          parentId: rootId,
          gen: gen("message:string -> reply:string", `You are ${personas[i % personas.length]}. Answer the task directly in markdown.`),
          opts: optsFor(),
          onEvent,
          phase: `candidate ${i + 1}`,
          budget,
          usageOf: (g) => usageOf(g),
        },
        ai,
        { message },
      )
      return (out as { reply?: string }).reply ?? ""
    }),
  )
  const kept = candidates.filter((c): c is string => typeof c === "string" && c.length > 0)
  if (kept.length === 0) return { reply: "(all candidates failed)" }
  if (kept.length === 1) return { reply: kept[0]! }

  // judge() runs ONE judge node: a pure reasoning gen that reads the numbered candidates
  // and returns the single best VERBATIM (it must not blend/rewrite). toInput maps the
  // candidate array onto the judge gen's signature inputs.
  const judgeId = `${rootId}/judge`
  onEvent({ type: "start", nodeId: judgeId, parentId: rootId, phase: "judge" })
  const judgeGen = gen(
    "message:string, candidates:string -> reply:string",
    "You are an impartial judge. Given the task and several numbered candidate answers, pick the single best one and return it VERBATIM — do not blend or rewrite.",
  )
  const judged = await judge(
    ai,
    kept,
    judgeGen,
    optsFor(),
    (cs) => ({ message, candidates: (cs as readonly string[]).map((c, i) => `#${i + 1}:\n${c}`).join("\n\n") }),
  )
  budget.charge(usageOf(judgeGen))
  onEvent({ type: "done", nodeId: judgeId, result: "picked best candidate" })
  return { reply: String((judged as { reply?: string }).reply ?? kept[0]!), branches: kept.length }
}
