// pipeline — TYPED structuredPipeline over THREE stages (stage k's TYPED output threads
// straight into stage k+1's input). TRUSTED, loaded from .ax/orch/ by src/orch-load.ts
// via runtime import(). NO runtime ax imports — everything comes through `prims`.
//
// THE POINT: stages DEPEND on each other, so this is a PIPELINE, not a parallel fan-out.
// Each stage is a gen typed by its OWN signature; the typed structured output of stage k
// feeds stage k+1's input with NO string flattening between stages. ax's forward() parses/
// validates/retries each stage's JSON against its signature, so a stage yields a real typed
// object. structuredPipeline threads them via the core pipeline() prim (no barrier needed —
// it's serial), so the engine core stays exactly 5 prims. Each stage runs over its OWN
// forked memory (optsFor()) and is charged to the shared advisory budget.
//
// THE KEY INVARIANT: stage k's OUTPUT field name MUST equal stage k+1's INPUT field name:
//   stage 1:  message:string  -> facts:json      (the `facts` out ...)
//   stage 2:  facts:json       -> outline:json    (... is the `facts` in; `outline` out ...)
//   stage 3:  outline:json     -> summary:string  (... is the `outline` in)
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { gen, structuredPipeline } = prims

  const extract = gen("message:string -> facts:json", "Extract the key facts as JSON: { topic: string, points: string[] }. Terse, concrete.")
  const organise = gen("facts:json -> outline:json", "Organise the facts into a JSON outline: { sections: { heading: string, bullets: string[] }[] }.")
  const render = gen("outline:json -> summary:string", "Render the outline as a tight markdown summary with section headings.")

  const out = (await structuredPipeline(
    [
      { gen: extract, opts: optsFor(), nodeId: `${rootId}/extract`, phase: "extract facts", budget, usageOf: (g) => usageOf(g) },
      { gen: organise, opts: optsFor(), nodeId: `${rootId}/organise`, phase: "organise", budget, usageOf: (g) => usageOf(g) },
      { gen: render, opts: optsFor(), nodeId: `${rootId}/render`, phase: "render", budget, usageOf: (g) => usageOf(g) },
    ],
    ai,
    { message },
    onEvent,
    rootId,
  )) as { summary?: string }

  return { reply: out.summary ?? "(pipeline produced no summary)" }
}
