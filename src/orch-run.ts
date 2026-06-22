// demo-wire — a REAL multi-node orchestration over the user's message, proving the
// whole stack end-to-end: the core primitives (node/parallel/emit/allocate) and the
// recipes built on them (runNode/judge/adversarialVerify/loopUntilDry) actually fan
// out, judge, and verify, emitting NodeEvents the live tree (chat.tsx NodeView)
// renders as it runs.
//
// Flow, all under ONE chat.orchestrate span parented to the session root (so the
// one-trace-per-session discipline holds):
//   orchestrate (root node)
//     ├─ candidate 1   ┐  parallel() fan-out — each node forwards over a FORKED
//     ├─ candidate 2   ┘  AxMemory (never the session mem, never shared between
//     ├─ judge            concurrent nodes), so two branches can't corrupt each
//     ├─ skeptic 1     ┐  other's multi-turn history. The merge (reading results
//     └─ skeptic 2     ┘  back, charging the budget) is single-threaded — it runs
//                         only on this boundary fiber, never inside a node.
//
// Effect lives ONLY here at the boundary (the Effect.fn span + Effect.tryPromise);
// the recipes stay Promise-native.
import { ax, type AxGen, type AxGenIn, type AxGenOut, AxMemory } from "@ax-llm/ax"
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import * as Effect from "effect/Effect"
import type { AnySpan } from "effect/Tracer"
import { limits, llm, MODEL, onEvent, readUsageOf } from "./runtime.ts"
import { adversarialVerify, judge, loopUntilDry, runNode } from "./orch-recipes.ts"
import { allocate, type Budget, type LeafOpts, parallel } from "./orch.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"

// Tool-free single-shot gens: the demo proves orchestration, not tool loops — the
// nodes answer straight from the prompt.
const candidate = (persona: string) => {
  const g = ax("message:string -> reply:string")
  g.setDescription(`${persona} Answer the user's message directly and concisely in GitHub-flavored markdown.`)
  return g
}
const candidateGens = [
  candidate("You are a terse, no-nonsense senior engineer."),
  candidate("You are a thorough, explanatory teacher."),
] as const

const judgeGen = ax("message:string, candidates:string -> reply:string")
judgeGen.setDescription(
  "You are an impartial judge. Given the user's message and several candidate answers (numbered), pick the single best answer and return it VERBATIM as your reply — do not blend or rewrite.",
)

const skepticGen = ax("message:string, answer:string -> verdict:string")
skepticGen.setDescription(
  "You are a skeptical reviewer. Decide whether the answer actually addresses the message. Reply with exactly one word: 'accept' or 'reject'.",
)

export type OrchestrateResult = { reply: string; candidates: number; accepted: boolean; votes: number }

// Tagged boundary error: keeps the orchestration failure distinct in the Effect
// error channel and wraps the original in `cause` (mirrors agent.ts's ChatError).
class OrchestrateError {
  readonly _tag = "OrchestrateError"
  constructor(readonly cause: unknown) {}
}

const numbered = (xs: readonly string[]) => xs.map((c, i) => `#${i + 1}:\n${c}`).join("\n\n")

/**
 * Run the demo orchestration for one user message. `parent` is the session root
 * ExternalSpan (the same handle turn() uses) so chat.orchestrate joins the
 * session's one trace. Returns the judged-and-verified best answer plus a small
 * tally the UI surfaces. Individual node failures degrade gracefully — parallel()
 * resolves them to null and they are filtered out single-threaded.
 */
export const orchestrate = (parent: AnySpan, sessionId: string, message: string) =>
  Effect.fn("chat.orchestrate", {
    kind: "client",
    parent,
    attributes: {
      "gen_ai.operation.name": "orchestrate",
      "gen_ai.request.model": MODEL,
      "session.id": sessionId,
    },
  })(function* () {
    const provider = yield* OtelTracer.OtelTracerProvider
    const tracer = provider.getTracer(SERVICE_NAME, SERVICE_VERSION)
    const otelSpan = yield* OtelTracer.currentOtelSpan
    const traceContext = otelTrace.setSpan(otelContext.active(), otelSpan)
    const aborter = new AbortController()
    const budget = allocate(limits.tokenBudget)
    const rootId = `orch:${sessionId}`

    // Per-branch LeafOpts: each call returns a FRESH AxMemory (a fork) so concurrent
    // nodes never mutate a shared history. The session's real mem is owned by turn().
    const optsFor = (): LeafOpts => ({
      mem: new AxMemory(),
      sessionId,
      tracer,
      traceContext,
      maxSteps: limits.maxSteps,
      stream: false,
      abortSignal: aborter.signal,
    })

    yield* Effect.logInfo("orchestrate.start").pipe(
      Effect.annotateLogs({ "session.id": sessionId, "message.chars": message.length }),
    )

    const out = yield* Effect.tryPromise({
      try: () =>
        otelContext.with(traceContext, () => run(rootId, message, optsFor, budget)),
      catch: (e) => new OrchestrateError(e),
    })

    yield* Effect.annotateCurrentSpan({
      "orch.candidates": out.candidates,
      "orch.accepted": out.accepted,
      "orch.votes": out.votes,
    })
    yield* Effect.logInfo("orchestrate.done").pipe(Effect.annotateLogs({ "reply.chars": out.reply.length }))
    return out
  })

// The Promise-native body: pure recipe composition (no Effect). Brackets the whole
// run as the root node, then fan-out → judge → verify under it.
const run = async (
  rootId: string,
  message: string,
  optsFor: () => LeafOpts,
  budget: Budget,
): Promise<OrchestrateResult> => {
  onEvent({ type: "start", nodeId: rootId, phase: "orchestrate" })
  try {
    // 1) FAN-OUT under loopUntilDry: regenerate the candidate set until the
    // surviving-count converges (or max attempts). Each attempt is a parallel()
    // fan-out of runNode() nodes, each over its own forked memory.
    const survivors = await loopUntilDry(
      () => fanOut(rootId, message, optsFor, budget),
      (prev, next) => prev.length === next.length,
      2,
    )
    if (survivors.length === 0) throw new Error("all candidate nodes failed")

    // 2) JUDGE: one node picks the best candidate verbatim. Bracketed so a throw
    // closes the judge node with an error event (never orphaned under the root).
    onEvent({ type: "start", nodeId: `${rootId}/judge`, parentId: rootId, phase: "judge" })
    let best: string
    try {
      const judged = await judge(
        llm,
        survivors,
        judgeGen,
        optsFor(),
        (cs) => ({ message, candidates: numbered(cs as readonly string[]) }),
      )
      budget.charge(readUsageOf(judgeGen))
      best = judged.reply
      onEvent({ type: "done", nodeId: `${rootId}/judge`, result: best })
    } catch (cause) {
      onEvent({ type: "error", nodeId: `${rootId}/judge`, cause })
      throw cause
    }

    // 3) ADVERSARIAL VERIFY: two skeptics vote accept/reject in parallel. Bracketed
    // so a throw in verify itself closes the verify node (its skeptic children own
    // their own lifecycle events via runNode()).
    onEvent({ type: "start", nodeId: `${rootId}/verify`, parentId: rootId, phase: "verify" })
    let verdict: { accepted: boolean; votes: readonly boolean[] }
    try {
      verdict = await adversarialVerify<string>(
        async () => best,
        [0, 1].map((i) => (answer: string) => skeptic(rootId, i, message, answer, optsFor(), budget)),
      )
      onEvent({
        type: "done",
        nodeId: `${rootId}/verify`,
        result: { votes: verdict.votes.length, accepted: verdict.accepted },
      })
    } catch (cause) {
      onEvent({ type: "error", nodeId: `${rootId}/verify`, cause })
      throw cause
    }

    const result: OrchestrateResult = {
      reply: best,
      candidates: survivors.length,
      accepted: verdict.accepted,
      votes: verdict.votes.length,
    }
    onEvent({ type: "done", nodeId: rootId, result: { ...result, reply: undefined } })
    return result
  } catch (cause) {
    onEvent({ type: "error", nodeId: rootId, cause })
    throw cause
  }
}

// One parallel() fan-out of candidate runNode() nodes. Each branch pre-emits its own
// parent edge (runNode()'s start carries no parentId), runs the node over a forked
// memory, charges the shared budget single-threaded, and yields its reply string.
const fanOut = async (
  rootId: string,
  message: string,
  optsFor: () => LeafOpts,
  budget: Budget,
): Promise<string[]> => {
  const raw = await parallel(
    candidateGens.map((gen, i) => () => {
      const nodeId = `${rootId}/cand-${i}`
      // Establish the edge first so the live tree nests this under the root even if
      // runNode()'s own (parentId-less) start lands second; atoms preserves parentId.
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `candidate ${i + 1}` })
      return runNodeAt(nodeId, gen, optsFor(), budget, { message }).then((o) => (o as { reply?: string }).reply ?? "")
    }),
  )
  return raw.filter((r): r is string => typeof r === "string" && r.length > 0)
}

// A single skeptic node voting on the answer. Bracketed as its own node so the tree
// shows the verify fan-out; true only on an explicit 'accept'.
const skeptic = async (
  rootId: string,
  i: number,
  message: string,
  answer: string,
  opts: LeafOpts,
  budget: Budget,
): Promise<boolean> => {
  const nodeId = `${rootId}/skeptic-${i}`
  onEvent({ type: "start", nodeId, parentId: rootId, phase: `skeptic ${i + 1}` })
  const out = await runNodeAt(nodeId, skepticGen, opts, budget, { message, answer })
  return /accept/i.test(String((out as { verdict?: string }).verdict ?? ""))
}

// Thin wrapper over the runNode() recipe: same nodeId so its done/error updates the
// edge node in place, with budget charging wired (usageOf reads the node's usage).
// ponytail: the two candidate / two skeptic nodes share ONE AxGen instance each and
// run concurrently under parallel(); usageOf reads that gen's LAST getUsage() entry,
// so the Budget charge is approximate when concurrent forwards interleave (memory is
// still correctly forked per branch — only token attribution is fuzzy). Ceiling:
// over/under-charge by up to one node's usage under contention. Upgrade: construct a
// fresh AxGen per branch (one instance per concurrent forward) so getUsage() is 1:1.
const runNodeAt = <I extends AxGenIn, O extends AxGenOut>(
  nodeId: string,
  gen: AxGen<I, O>,
  opts: LeafOpts,
  budget: Budget,
  input: I,
): Promise<O> =>
  runNode({ nodeId, gen, opts, onEvent, budget, usageOf: (g) => readUsageOf(g) }, llm, input)
