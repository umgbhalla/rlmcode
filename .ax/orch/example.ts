// example dyn-load orchestration script — TRUSTED, loaded from .ax/orch/ by
// src/orch-load.ts via runtime import(). It receives the run ctx + the injected
// prims toolkit (5 core prims + 4 recipes) and composes them; its nodes render live
// in the SAME OrchTree as orch-run (because ctx.onEvent is wired to emit()).
//
// This one exercises parallel() + agent(): it fans out two persona candidates over
// FORKED memories (ctx.optsFor() returns a fresh AxMemory per call — never shared
// across concurrent leaves), then returns the first non-empty reply. No new engine
// imports: everything comes through `prims`, so the core stays exactly 5 prims.
import { ax } from "@ax-llm/ax"
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

const persona = (p: string) => {
  const g = ax("message:string -> reply:string")
  g.setDescription(`${p} Answer the user's message directly and concisely in GitHub-flavored markdown.`)
  return g
}

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { parallel, agent } = prims

  const gens = [persona("You are a terse senior engineer."), persona("You are a patient teacher.")]

  // parallel() fan-out of agent() nodes. Each branch pre-emits its parent edge so the
  // live tree nests it under the script root, then runs agent() over a forked memory.
  const replies = await parallel(
    gens.map((gen, i) => async () => {
      const nodeId = `${rootId}/cand-${i}`
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `candidate ${i + 1}` })
      const out = await agent(
        { nodeId, gen, opts: optsFor(), onEvent, phase: `candidate ${i + 1}`, budget, usageOf: (g) => usageOf(g) },
        ai,
        { message },
      )
      return (out as { reply?: string }).reply ?? ""
    }),
  )

  const reply = replies.find((r): r is string => typeof r === "string" && r.length > 0) ?? "(no candidate produced a reply)"
  return { reply, candidates: replies.filter((r) => typeof r === "string" && r.length > 0).length }
}
