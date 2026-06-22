// FIRST-CLASS structured-pipeline orchestration script — TRUSTED, loaded from
// .ax/orch/ by src/orch-load.ts via runtime import(). It receives the run ctx + the
// injected prims toolkit and composes structuredPipeline() over typed gen() leaves;
// its stages render live in the SAME OrchTree as orch-run (ctx.onEvent → emit()).
//
// THE POINT (leap 2): orchestration nodes are NOT string-only. Each stage is a gen
// typed by its OWN signature, and the TYPED structured output of stage k feeds stage
// k+1's input — no string flattening between stages. ax's forward() parses/validates/
// retries each stage's JSON against its signature, so a stage yields a real typed
// object (here `facts:json`), not a blob. structuredPipeline threads them via the core
// pipeline() prim, so the engine core stays exactly 5 prims.
//
// Stage chain for this demo (extract → summarise):
//   stage 1:  message:string            -> facts:json     (pull structured facts)
//   stage 2:  facts:json                -> summary:string (render a prose summary)
// The KEY invariant: stage 1's OUTPUT field name (`facts`) MUST equal stage 2's INPUT
// field name (`facts`) so pipeline() threads the typed object straight through.
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { gen, structuredPipeline } = prims

  // Stage 1 — TYPED structured extraction: a string message in, a JSON `facts` object out.
  const extract = gen(
    "message:string -> facts:json",
    "Extract the key facts from the message as a JSON object: { topic: string, points: string[] }. Be terse and concrete.",
  )
  // Stage 2 — consume the TYPED `facts` object (not a string) and render a prose summary.
  const summarise = gen(
    "facts:json -> summary:string",
    "Given the structured facts JSON, write a tight one-paragraph summary in GitHub-flavored markdown.",
  )

  // structuredPipeline threads stage 1's typed `facts` output straight into stage 2's
  // `facts` input. Each stage runs over its OWN forked memory (optsFor()) and is charged
  // to the shared advisory budget. The whole chain renders as nested nodes under rootId.
  const out = (await structuredPipeline(
    [
      { gen: extract, opts: optsFor(), nodeId: `${rootId}/extract`, phase: "extract facts", budget, usageOf: (g) => usageOf(g) },
      { gen: summarise, opts: optsFor(), nodeId: `${rootId}/summarise`, phase: "summarise", budget, usageOf: (g) => usageOf(g) },
    ],
    ai,
    { message },
    onEvent,
    rootId,
  )) as { summary?: string }

  return { reply: out.summary ?? "(structured pipeline produced no summary)" }
}
