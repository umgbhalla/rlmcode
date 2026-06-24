// @effect/vitest port of scripts/orch-route.test.ts — PER-NODE TOOL ROUTING. Pins the routing
// fix end-to-end WITHOUT an LLM: runNode() binds a nodeId-TAGGED logger onto a node's forward
// opts so every tool/result activity carries that node's id; the atoms reducer routes tagged
// tools to the owning node, untagged to the main transcript.
import type { AxAIService, AxGen, AxGenIn, AxGenOut, AxLoggerData } from "@ax-llm/ax"
import { AxMemory } from "@ax-llm/ax"
import { effect, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Activity } from "../src/core/activity.ts"
import { runNode } from "../src/core/orch-recipes.ts"
import type { ActivitySink, NodeOpts } from "../src/core/orch.ts"

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

const fakeAi = {} as AxAIService
// The per-turn activity sink rides NodeOpts.emit (the per-turn closure); withNodeLogger builds
// makeNodeLogger(opts.emit, nodeId) so a node's tool rows tag with its id.
const optsFor = (emit?: ActivitySink): NodeOpts =>
  ({
    mem: new AxMemory(),
    sessionId: "test",
    tracer: undefined,
    traceContext: undefined,
    maxSteps: 1,
    stream: false,
    abortSignal: new AbortController().signal,
    ...(emit !== undefined ? { emit } : {}),
  }) as unknown as NodeOpts

// A FAKE AxGen whose forward() drives the per-call logger (opts.logger) with ax's native step
// feed: a ChatResponseResults carrying a tool call, then a FunctionResults carrying its result.
const toolingGen = (toolName: string, callId: string): AxGen<AxGenIn, AxGenOut> =>
  ({
    forward: async (_ai: unknown, _input: unknown, opts?: { logger?: (m: AxLoggerData) => void }) => {
      const log = opts?.logger
      if (log !== undefined) {
        log({ name: "ChatResponseResults", value: [{ content: "", functionCalls: [{ id: callId, function: { name: toolName, params: { q: "x" } } }] }] } as unknown as AxLoggerData)
        log({ name: "FunctionResults", value: [{ functionId: callId, result: `${toolName} ok`, isError: false }] } as unknown as AxLoggerData)
      }
      return { reply: `done ${toolName}` } as AxGenOut
    },
  }) as unknown as AxGen<AxGenIn, AxGenOut>

// The atoms reducer's tool/result routing, reproduced (atoms.installSink is module-private).
type ToolStep = { id: string; name: string; status: string; result: string; nodeId?: string }
const makeRouter = () => {
  const transcript: Array<ToolStep> = []
  const nodeTools: Record<string, Array<ToolStep>> = {}
  const sink = (a: Activity) => {
    if (a.kind === "tool") {
      const step: ToolStep = { id: a.id, name: a.name, status: "running", result: "", nodeId: a.nodeId }
      if (a.nodeId !== undefined) (nodeTools[a.nodeId] ??= []).push(step)
      else transcript.push(step)
    } else if (a.kind === "result") {
      const list = a.nodeId !== undefined ? (nodeTools[a.nodeId] ?? []) : transcript
      for (const s of list)
        if (s.id === a.id) {
          s.status = a.isError ? "error" : "ok"
          s.result = a.result
        }
    }
  }
  return { transcript, nodeTools, sink }
}

it.effect("three concurrent nodes each tag their tool with their own id; nothing leaks to transcript", () =>
  Effect.promise(async () => {
    const router = makeRouter()
    const specs = [
      { nodeId: "orch:root/branch-0", gen: toolingGen("bash", "c0") },
      { nodeId: "orch:root/branch-1", gen: toolingGen("read_file", "c1") },
      { nodeId: "orch:root/branch-2", gen: toolingGen("grep", "c2") },
    ]
    await Promise.all(
      specs.map((s) => runNode({ nodeId: s.nodeId, parentId: "orch:root", gen: s.gen, opts: optsFor(router.sink), onEvent: () => {} }, fakeAi, { message: "go" })),
    )
    for (const s of specs) {
      const tools = router.nodeTools[s.nodeId] ?? []
      expect(tools.length, `node ${s.nodeId} owns exactly 1 tool`).toBe(1)
      expect(tools.every((t) => t.nodeId === s.nodeId), `node ${s.nodeId}'s tools are all tagged with ITS id`).toBe(true)
    }
    const b0 = router.nodeTools["orch:root/branch-0"] ?? []
    expect(b0[0]?.name === "bash" && b0[0]?.status === "ok" && b0[0]?.result === "bash ok", "branch-0 owns 'bash', settled ok with its result").toBe(true)
    expect(router.transcript.length, "no tagged tool leaked into the main transcript").toBe(0)
  }),
)

it.effect("main turn (turn:*) gets NO injected per-node logger; an orch node DOES", () =>
  Effect.promise(async () => {
    const mainCap = captureGen()
    await runNode({ nodeId: "turn:s1", gen: mainCap.gen, opts: optsFor(), onEvent: () => {} }, fakeAi, { message: "go" })
    expect(mainCap.seen.logger, "main turn (turn:*) gets NO injected per-node logger").toBeUndefined()

    const nodeCap = captureGen()
    await runNode({ nodeId: "orch:root/branch-9", gen: nodeCap.gen, opts: optsFor(), onEvent: () => {} }, fakeAi, { message: "go" })
    expect(typeof nodeCap.seen.logger, "an orch node gets a tagged per-node logger injected on its forward").toBe("function")
  }),
)
