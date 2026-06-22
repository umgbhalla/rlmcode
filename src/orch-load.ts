// dyn-load — ultracode scriptPath parity. WRITE an orchestration script to a
// TRUSTED scripts dir, then LOAD + RUN it at runtime against the live engine,
// rendering nodes through the SAME emit()/OrchTree path as orch-run. Bun executes
// .ts natively, so a runtime dynamic import() of a script module is enough.
//
// SECURITY BOUNDARY: in-process import() = FULL TRUST. We resolve ONLY within the
// configured scripts dir (.ax/orch/) and REJECT any reference that escapes it
// (path traversal, absolute paths outside the root). Never import() a path the
// model can author outside this root.
//
// ponytail: in-process import is trusted-only. Loaded JS runs with the host's full
// authority (fs/net/process). Ceiling: an LLM-authored or otherwise untrusted
// script could do anything the agent process can. Upgrade: execute untrusted
// orchestration JS in an isolate via AxJSRuntime — the @ax-llm/ax sandbox over a
// Bun smol Worker. Construct it as `new AxJSRuntime({ permissions: [], outputMode:
// "return", blockDynamicImport: true, freezeIntrinsics: true })` (ctor at
// node_modules/@ax-llm/ax/index.d.ts:10346; AxJSRuntimePermission enum at :10296 —
// grant NETWORK/FILESYSTEM/etc. explicitly per-script) or the axCreateJSRuntime()
// factory (:10489), then session.eval the script text instead of import()ing it.
import { resolve as resolvePath, sep as pathSep } from "node:path"
import { context as otelContext, trace as otelTrace, type Context as OtelContext, type Tracer } from "@opentelemetry/api"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import * as Effect from "effect/Effect"
import type { AnySpan } from "effect/Tracer"
import { ax, type AxAIService, AxMemory, type AxGen } from "@ax-llm/ax"
import { limits, llm, MODEL, onEvent, readUsageOf } from "./runtime.ts"
import { adversarialVerify, judge, loopUntilDry, runNode, structuredPipeline, untilGate, verifiedStep, verifyHarden, type AgentNode, type EmitSink, type PipelineStage } from "./orch-recipes.ts"
import { journaledNode, type Journal, type JournaledNodeSpec, loadJournal, saveJournal } from "./orch-journal.ts"
import {
  allocate,
  type Budget,
  type BudgetExhaustedError,
  type BudgetUsage,
  emit,
  type EmitOpts,
  type LeafOpts,
  node,
  type NodeEvent,
  parallel,
  pipeline,
} from "./orch.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"

// The trusted scripts root. Resolved once, absolute. ONLY modules under here load.
export const ORCH_SCRIPTS_DIR = resolvePath(process.cwd(), ".ax/orch")

// The toolkit injected into a loaded script: the 5 CORE prims (orch.ts) + the 4
// userland recipes (orch-recipes.ts) + a gen factory for building nodes inline.
// A script composes these — it never re-imports the engine, so the core stays exactly
// 5 prims (gen is a toolkit convenience that wraps ax()). The script can't smuggle a 6th.
// UNIFIED VOCABULARY: the unit is a NODE — node() is the core prim; runNode() runs one.
export type OrchPrims = {
  // 5 core
  readonly node: typeof node
  readonly parallel: typeof parallel
  readonly pipeline: typeof pipeline
  readonly emit: typeof emit
  readonly allocate: typeof allocate
  // generator factory (wraps ax() + setDescription)
  readonly gen: (signature: string, description?: string) => AxGen
  // 5 recipes
  readonly runNode: typeof runNode
  readonly judge: typeof judge
  readonly loopUntilDry: typeof loopUntilDry
  readonly adversarialVerify: typeof adversarialVerify
  // structuredPipeline — thread TYPED structured stage outputs through pipeline().
  readonly structuredPipeline: typeof structuredPipeline
  // verified-step recipes: gate-loop, adversarial harden, and the composed verifiedStep.
  readonly untilGate: typeof untilGate
  readonly verifyHarden: typeof verifyHarden
  readonly verifiedStep: typeof verifiedStep
  // resume-journal: opt-in crash/network-resilient node wrapper + its load/save helpers.
  // OFF unless a script passes { enabled: true } + a Journal — normal nodes are unaffected.
  readonly journaledNode: typeof journaledNode
  readonly loadJournal: typeof loadJournal
  readonly saveJournal: typeof saveJournal
}

// The run context handed to a loaded script's orchestrate(ctx, prims). Mirrors the
// boundary state orch-run builds: the LLM service, the shared budget, the lifecycle
// sink (already wired to emit() at the session boundary), a per-branch LeafOpts
// factory that FORKS a fresh AxMemory (never shared across concurrent nodes), the
// usage reader for budget charging, plus a stable rootId to nest nodes under.
export type OrchLoadCtx = {
  readonly sessionId: string
  readonly message: string
  readonly rootId: string
  // AxAIService (not the concrete `typeof llm`): the run_orch_script tool threads the
  // live service from the forward's `extra.ai`, which ax types as AxAIService. Recipes
  // only need AxAIService; the user-triggered /run path still passes `llm` (an AxAI,
  // assignable to AxAIService).
  readonly ai: AxAIService
  readonly model: string
  readonly budget: Budget
  readonly onEvent: EmitSink
  readonly optsFor: () => LeafOpts
  readonly usageOf: (gen: unknown) => BudgetUsage | undefined
}

// What a loaded script may return — anything serializable-ish; we clip it for the UI.
export type OrchLoadResult = { reply: string; detail?: unknown }

// A loaded orchestration module: `orchestrate(ctx, prims)` (named) or default.
type OrchScriptFn = (ctx: OrchLoadCtx, prims: OrchPrims) => Promise<unknown> | unknown
type OrchScriptModule = { orchestrate?: OrchScriptFn; default?: OrchScriptFn }

// re-export the prim TYPES so a script can `import type` them for annotations.
export type { AgentNode, Budget, BudgetExhaustedError, BudgetUsage, EmitOpts, EmitSink, Journal, JournaledNodeSpec, LeafOpts, NodeEvent, PipelineStage }

class OrchLoadError {
  readonly _tag = "OrchLoadError"
  constructor(readonly cause: unknown) {}
}

// Resolve a script reference to an absolute path INSIDE the trusted root, or throw.
// Accepts a bare name ("example", "example.ts") — never a path that escapes the root.
// Exported so the agent-callable run_orch_script tool (orch-tools.ts) reuses the SAME
// path-escape guard as the user-triggered /run path — one trusted boundary, no fork.
export const resolveScript = (scriptRef: string): string => {
  const ref = scriptRef.trim()
  if (ref.length === 0) throw new Error("empty script reference")
  if (ref.includes("/") || ref.includes("\\")) {
    throw new Error(`script '${ref}' must be a bare filename, no directories`)
  }
  const withExt = /\.[cm]?[jt]s$/.test(ref) ? ref : `${ref}.ts`
  // Resolve relative to the root, then assert containment. resolvePath collapses
  // any ../ so a traversal attempt lands OUTSIDE the prefix and is rejected.
  const abs = resolvePath(ORCH_SCRIPTS_DIR, withExt)
  const root = ORCH_SCRIPTS_DIR.endsWith(pathSep) ? ORCH_SCRIPTS_DIR : ORCH_SCRIPTS_DIR + pathSep
  if (abs !== ORCH_SCRIPTS_DIR && !abs.startsWith(root)) {
    throw new Error(`script '${ref}' escapes the trusted scripts dir (${ORCH_SCRIPTS_DIR})`)
  }
  return abs
}

const clip = (v: unknown, max = 256): string => {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } })()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// The 9-prim toolkit handed to every loaded script (5 core + gen factory + 4 recipes).
// Shared by the user-triggered /run path (loadAndRunOrch) and the agent-callable
// run_orch_script tool (orch-tools.ts) so both inject the IDENTICAL ambient engine.
export const orchPrims = (): OrchPrims => ({
  node,
  parallel,
  pipeline,
  emit,
  allocate,
  gen: (signature: string, description?: string): AxGen => {
    const g = ax(signature)
    if (description !== undefined) g.setDescription(description)
    return g
  },
  runNode,
  judge,
  loopUntilDry,
  adversarialVerify,
  structuredPipeline,
  untilGate,
  verifyHarden,
  verifiedStep,
  journaledNode,
  loadJournal,
  saveJournal,
})

// Promise-native trusted-script core: resolve INSIDE the trusted root (path-escape
// rejected by resolveScript), dynamic-import the module, bracket the whole run as the
// root node so it nests in the OrchTree even if the script forgets to emit, run
// orchestrate(ctx, prims), and normalize the return. Shared by loadAndRunOrch's
// Effect.fn boundary AND the run_orch_script tool — one loader, one trust boundary.
export const runLoadedScript = async (scriptRef: string, ctx: OrchLoadCtx): Promise<OrchLoadResult> => {
  const abs = resolveScript(scriptRef)
  const mod = (await import(abs)) as OrchScriptModule
  const fn = mod.orchestrate ?? mod.default
  if (typeof fn !== "function") {
    throw new Error(`script '${scriptRef}' must export an orchestrate(ctx, prims) function (or default)`)
  }
  ctx.onEvent({ type: "start", nodeId: ctx.rootId, phase: `script:${scriptRef}` })
  try {
    const raw = await fn(ctx, orchPrims())
    const res = toResult(raw)
    ctx.onEvent({ type: "done", nodeId: ctx.rootId, result: clip(res.reply) })
    return res
  } catch (cause) {
    ctx.onEvent({ type: "error", nodeId: ctx.rootId, cause })
    throw cause
  }
}

// Normalize whatever the script returned into an OrchLoadResult for the transcript.
const toResult = (raw: unknown): OrchLoadResult => {
  if (typeof raw === "string") return { reply: raw }
  if (raw !== null && typeof raw === "object" && "reply" in raw && typeof (raw as { reply: unknown }).reply === "string") {
    return { reply: (raw as { reply: string }).reply, detail: raw }
  }
  return { reply: clip(raw), detail: raw }
}

/**
 * Load + run a trusted orchestration script for one user message. `parent` is the
 * session root ExternalSpan (same handle turn()/orchestrate() use) so this joins the
 * session's one trace under a chat.orchestrate.load span. The script's nodes render
 * live via the SAME onEvent()/emit() → OrchTree path as orch-run. Returns the script
 * result (normalized). Boundary errors are caught and tagged.
 */
export const loadAndRunOrch = (parent: AnySpan, sessionId: string, scriptRef: string, message: string) =>
  Effect.fn("chat.orchestrate.load", {
    kind: "client",
    parent,
    attributes: {
      "gen_ai.operation.name": "orchestrate.load",
      "gen_ai.request.model": MODEL,
      "session.id": sessionId,
      "orch.script": scriptRef,
    },
  })(function* () {
    const provider = yield* OtelTracer.OtelTracerProvider
    const tracer: Tracer = provider.getTracer(SERVICE_NAME, SERVICE_VERSION)
    const otelSpan = yield* OtelTracer.currentOtelSpan
    const traceContext: OtelContext = otelTrace.setSpan(otelContext.active(), otelSpan)
    const aborter = new AbortController()
    const budget = allocate(limits.tokenBudget)
    const rootId = `orch:${sessionId}:${scriptRef}`

    const optsFor = (): LeafOpts => ({
      mem: new AxMemory(),
      sessionId,
      tracer,
      traceContext,
      maxSteps: limits.maxSteps,
      stream: false,
      abortSignal: aborter.signal,
    })

    const ctx: OrchLoadCtx = {
      sessionId,
      message,
      rootId,
      ai: llm,
      model: MODEL,
      budget,
      onEvent,
      optsFor,
      usageOf: readUsageOf,
    }

    yield* Effect.logInfo("orchestrate.load.start").pipe(
      Effect.annotateLogs({ "session.id": sessionId, "orch.script": scriptRef }),
    )

    const out = yield* Effect.tryPromise({
      try: () => otelContext.with(traceContext, () => runLoadedScript(scriptRef, ctx)),
      catch: (e) => new OrchLoadError(e),
    })

    yield* Effect.logInfo("orchestrate.load.done").pipe(Effect.annotateLogs({ "reply.chars": out.reply.length }))
    return out
  })
