#!/usr/bin/env bun
// Headless PER-NODE TOOL ROUTING test (ponytail: non-trivial logic leaves a check). Plain
// asserts, no framework — same assert-fixture style as orch-cost.test / orch.test.
//
// Pins the routing fix end-to-end WITHOUT an LLM. The BUG it guards: a parallel NODE is its
// OWN sub-agent (own forward + BASE_TOOLS — it OWNS its tools), but tool events used to render
// under the MAIN transcript because the logger was global+untagged. The fix: runNode() binds a
// nodeId-TAGGED logger (makeNodeLogger) onto the node's forward opts, so every tool/result
// activity carries that node's id; the atoms reducer attaches a tagged tool to THAT node's
// tools list (untagged → main transcript). This test proves, with FAKE gens whose forward()
// drives ax's native logger feed (ChatResponseResults/FunctionResults) exactly as the real
// provider would:
//   (1) a node's tools are TAGGED with its own nodeId (the logger closes over the right id);
//   (2) the atoms-style reducer routes tagged tools to the owning node, untagged to transcript;
//   (3) THREE CONCURRENT nodes firing tools at once each land under their OWN node — never
//       interleaved into one stream (concurrency-correct: per-node logger closures, no global).
import type { AxAIService, AxGen, AxGenIn, AxGenOut, AxLoggerData } from "@ax-llm/ax"
import { AxMemory } from "@ax-llm/ax"
import { type Activity, setActivitySink } from "../src/activity.ts"
import { runNode } from "../src/orch-recipes.ts"
import type { LeafOpts } from "../src/orch.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

const fakeAi = {} as AxAIService
const optsFor = (): LeafOpts =>
  ({
    mem: new AxMemory(),
    sessionId: "test",
    tracer: undefined,
    traceContext: undefined,
    maxSteps: 1,
    stream: false,
    abortSignal: new AbortController().signal,
  }) as unknown as LeafOpts

// A FAKE AxGen whose forward() drives the per-call logger (opts.logger) with ax's native step
// feed: one ChatResponseResults carrying a tool call, then one FunctionResults carrying its
// result — EXACTLY the AxLoggerData shapes ax emits during a real forward(). This is what a
// node's nodeId-tagged logger maps onto tagged tool/result activities. The reply is fixed.
const toolingGen = (toolName: string, callId: string): AxGen<AxGenIn, AxGenOut> =>
  ({
    forward: async (_ai: unknown, _input: unknown, opts?: { logger?: (m: AxLoggerData) => void }) => {
      const log = opts?.logger
      if (log !== undefined) {
        // a step that calls one tool (ax's ChatResponseResults)
        log({ name: "ChatResponseResults", value: [{ content: "", functionCalls: [{ id: callId, function: { name: toolName, params: { q: "x" } } }] }] } as unknown as AxLoggerData)
        // the tool's result (ax's FunctionResults)
        log({ name: "FunctionResults", value: [{ functionId: callId, result: `${toolName} ok`, isError: false }] } as unknown as AxLoggerData)
      }
      return { reply: `done ${toolName}` } as AxGenOut
    },
  }) as unknown as AxGen<AxGenIn, AxGenOut>

// The atoms reducer's tool/result routing, reproduced here (atoms.installSink is module-private
// inside the atom closures). Tagged (nodeId) tools attach to that node's tools list; untagged go
// to the main transcript. This is the SAME branch the UI uses — pinning it here proves the wire.
type ToolStep = { id: string; name: string; status: string; result: string; nodeId?: string }
const makeRouter = () => {
  const transcript: ToolStep[] = []
  const nodeTools: Record<string, ToolStep[]> = {}
  const sink = (a: Activity) => {
    if (a.kind === "tool") {
      const step: ToolStep = { id: a.id, name: a.name, status: "running", result: "", nodeId: a.nodeId }
      if (a.nodeId !== undefined) (nodeTools[a.nodeId] ??= []).push(step)
      else transcript.push(step)
    } else if (a.kind === "result") {
      const list = a.nodeId !== undefined ? (nodeTools[a.nodeId] ?? []) : transcript
      for (const s of list) if (s.id === a.id) (s.status = a.isError ? "error" : "ok"), (s.result = a.result)
    }
  }
  return { transcript, nodeTools, sink }
}

await (async () => {
  console.log("orch-route.test: per-node tool routing (headless, no LLM)")

  // THREE CONCURRENT nodes, each running its OWN tooling gen with a DISTINCT tool + call id.
  const router = makeRouter()
  setActivitySink(router.sink)

  const specs = [
    { nodeId: "orch:root/branch-0", gen: toolingGen("bash", "c0") },
    { nodeId: "orch:root/branch-1", gen: toolingGen("read_file", "c1") },
    { nodeId: "orch:root/branch-2", gen: toolingGen("grep", "c2") },
  ]
  // Run them CONCURRENTLY (Promise.all) — the real fan-out shape. With a global logger their
  // tools would interleave into one stream; with per-node logger closures each lands under its
  // own node. (FAKE forwards are synchronous-ish, but concurrency-correctness is structural: the
  // logger is bound per-node in runNode, never a shared global currentNodeId.)
  await Promise.all(
    specs.map((s) => runNode({ nodeId: s.nodeId, parentId: "orch:root", gen: s.gen, opts: optsFor(), onEvent: () => {} }, fakeAi, { message: "go" })),
  )
  setActivitySink(null)

  // (1)+(3): each node has EXACTLY its own one tool, tagged with its own id — no interleave.
  for (const s of specs) {
    const tools = router.nodeTools[s.nodeId] ?? []
    assert(tools.length === 1, `node ${s.nodeId} owns exactly 1 tool, got ${tools.length}`)
    assert(tools.every((t) => t.nodeId === s.nodeId), `node ${s.nodeId}'s tools are all tagged with ITS id (no interleave)`)
  }
  // The branch-0 tool is bash and settled ok — proves call→result correlated under the right node.
  const b0 = router.nodeTools["orch:root/branch-0"] ?? []
  assert(b0[0]?.name === "bash" && b0[0]?.status === "ok" && b0[0]?.result === "bash ok", `branch-0 owns the 'bash' tool, settled ok with its result, got: ${JSON.stringify(b0[0])}`)
  // (2): NOTHING leaked into the main transcript — every tool here belonged to a node.
  assert(router.transcript.length === 0, `no tagged tool leaked into the main transcript, got ${router.transcript.length}`)

  // (2 inverse): the MAIN turn (nodeId `turn:<sessionId>`) must NOT get a tagged per-node logger
  // — its tools stay UNTAGGED and route to the transcript via the service-level global logger
  // (liveLogger), exactly as before the fix. A node, by contrast, MUST get a tagged logger. We
  // capture the forward opts each path receives and assert: turn:* → no injected logger; an
  // orch node → a logger present (so its tool activities carry the node id). This is the precise
  // guard for "don't regress the single-turn transcript while routing node tools per-node".
  const captureGen = (): { gen: AxGen<AxGenIn, AxGenOut>; seen: { logger?: unknown } } => {
    const seen: { logger?: unknown } = {}
    const gen = {
      forward: async (_ai: unknown, _input: unknown, opts?: { logger?: unknown }) => {
        seen.logger = opts?.logger
        return { reply: "ok" } as AxGenOut
      },
    } as unknown as AxGen<AxGenIn, AxGenOut>
    return { gen, seen }
  }

  const mainCap = captureGen()
  await runNode({ nodeId: "turn:s1", gen: mainCap.gen, opts: optsFor(), onEvent: () => {} }, fakeAi, { message: "go" })
  assert(mainCap.seen.logger === undefined, `main turn (turn:*) gets NO injected per-node logger (tools stay untagged → transcript), got: ${typeof mainCap.seen.logger}`)

  const nodeCap = captureGen()
  await runNode({ nodeId: "orch:root/branch-9", gen: nodeCap.gen, opts: optsFor(), onEvent: () => {} }, fakeAi, { message: "go" })
  assert(typeof nodeCap.seen.logger === "function", `an orch node gets a tagged per-node logger injected on its forward, got: ${typeof nodeCap.seen.logger}`)
})()

if (failed > 0) {
  console.error(`orch-route.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-route.test: all pass ✓")
