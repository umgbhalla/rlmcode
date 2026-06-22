// verify — ADVERSARIAL VERIFY: produce an answer ONCE, then fan N skeptic nodes that
// each vote accept/reject, and tally the votes (DEFAULT-REFUTED: accepted only if the
// votes carry it). TRUSTED, loaded from .ax/orch/ by src/orch-load.ts via runtime
// import(). NO runtime ax imports — everything comes through `prims`.
//
// THE POINT: a single answer is cheap to produce but easy to get subtly wrong, so we
// HARDEN it — each skeptic is an independent reasoning node (a forked memory) that tries
// to refute the answer; adversarialVerify() runs them via parallelLimit (bounded fan-out,
// failed skeptic → null/dropped) and `accept` tallies the booleans. Use for "is this
// migration safe?", "does this patch actually fix the bug?" — verdicts, not authorship.
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

const N_SKEPTICS = 3

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { runNode, adversarialVerify, gen } = prims

  // produce() — ONE node that answers the task end-to-end (it carries the file tools).
  const produce = async (): Promise<string> => {
    const nodeId = `${rootId}/produce`
    onEvent({ type: "start", nodeId, parentId: rootId, phase: "produce" })
    const out = await runNode(
      {
        nodeId,
        parentId: rootId,
        gen: gen("message:string -> reply:string", "Answer the task directly and concretely in markdown."),
        opts: optsFor(),
        onEvent,
        phase: "produce",
        budget,
        usageOf: (g) => usageOf(g),
      },
      ai,
      { message },
    )
    return (out as { reply?: string }).reply ?? ""
  }

  // Each skeptic is an independent reasoning node: read the answer, vote one word. A fresh
  // forked memory per skeptic (optsFor()) so their reasoning never interleaves.
  const skeptic = (i: number) => async (answer: string): Promise<boolean> => {
    const nodeId = `${rootId}/skeptic-${i}`
    onEvent({ type: "start", nodeId, parentId: rootId, phase: `skeptic ${i + 1}` })
    const out = await runNode(
      {
        nodeId,
        parentId: rootId,
        gen: gen("message:string, answer:string -> verdict:string", "You are a skeptical reviewer. Decide whether the answer truly addresses the task. Reply EXACTLY one word: 'accept' or 'reject'."),
        opts: optsFor(),
        onEvent,
        phase: `skeptic ${i + 1}`,
        budget,
        usageOf: (g) => usageOf(g),
      },
      ai,
      { message, answer },
    )
    return /accept/i.test(String((out as { verdict?: string }).verdict ?? ""))
  }

  const verdict = await adversarialVerify(
    produce,
    Array.from({ length: N_SKEPTICS }, (_, i) => skeptic(i)),
  )
  const tag = verdict.votes.length === 0 ? "unverified" : verdict.accepted ? "accepted" : "rejected"
  const reply = `${verdict.value}\n\n— verification: ${tag} (${verdict.votes.filter(Boolean).length}/${verdict.votes.length} skeptics accepted)`
  return { reply, accepted: verdict.accepted }
}
