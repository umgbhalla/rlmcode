// example dyn-load orchestration script — TRUSTED, loaded from .ax/orch/ by
// src/orch-load.ts via runtime import(). It receives the run ctx + the injected
// prims toolkit (5 core prims + gen factory + 4 recipes) and composes them; its
// nodes render live in the SAME OrchTree as orch-run (because ctx.onEvent is wired
// to emit()).
//
// This one exercises parallel() + runNode(): it fans out two persona candidates over
// FORKED memories (ctx.optsFor() returns a fresh AxMemory per call — never shared
// across concurrent nodes), then returns the first non-empty reply. No runtime ax
// imports: everything comes through `prims`, so the core stays exactly 5 prims.
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

const persona = (p: string, gen: OrchPrims["gen"]) =>
  gen(
    "message:string -> reply:string",
    `${p} Answer the user's message directly and concisely in GitHub-flavored markdown.`,
  )

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { parallel, runNode, gen } = prims

  const gens = [persona("You are a terse senior engineer.", gen), persona("You are a patient teacher.", gen)]

  // parallel() fan-out of runNode() nodes. Each branch pre-emits its parent edge so the
  // live tree nests it under the script root, then runs runNode() over a forked memory.
  const replies = await parallel(
    gens.map((g, i) => async () => {
      const nodeId = `${rootId}/cand-${i}`
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `candidate ${i + 1}` })
      const out = await runNode(
        { nodeId, gen: g, opts: optsFor(), onEvent, phase: `candidate ${i + 1}`, budget, usageOf: (gen) => usageOf(gen) },
        ai,
        { message },
      )
      return (out as { reply?: string }).reply ?? ""
    }),
  )

  const reply = replies.find((r): r is string => typeof r === "string" && r.length > 0) ?? "(no candidate produced a reply)"
  return { reply, candidates: replies.filter((r) => typeof r === "string" && r.length > 0).length }
}
