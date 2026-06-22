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
import { AxMemory } from "@ax-llm/ax"
import { limits, llm, MODEL, onEvent, readUsageOf } from "./agent.ts"
import { adversarialVerify, agent, judge, loopUntilDry, type AgentNode, type EmitSink } from "./orch-recipes.ts"
import {
  allocate,
  type Budget,
  type BudgetExhaustedError,
  type BudgetUsage,
  emit,
  type EmitOpts,
  leaf,
  type LeafOpts,
  type NodeEvent,
  parallel,
  pipeline,
} from "./orch.ts"
import { SERVICE_NAME, SERVICE_VERSION } from "./otel.ts"

// The trusted scripts root. Resolved once, absolute. ONLY modules under here load.
export const ORCH_SCRIPTS_DIR = resolvePath(process.cwd(), ".ax/orch")

// The toolkit injected into a loaded script: the 5 CORE prims (orch.ts) + the 4
// userland recipes (orch-recipes.ts). A script composes these — it never re-imports
// the engine, so the core stays exactly 5 prims and the script can't smuggle a 6th.
export type OrchPrims = {
  // 5 core
  readonly leaf: typeof leaf
  readonly parallel: typeof parallel
  readonly pipeline: typeof pipeline
  readonly emit: typeof emit
  readonly allocate: typeof allocate
  // 4 recipes
  readonly agent: typeof agent
  readonly judge: typeof judge
  readonly loopUntilDry: typeof loopUntilDry
  readonly adversarialVerify: typeof adversarialVerify
}

// The run context handed to a loaded script's orchestrate(ctx, prims). Mirrors the
// boundary state orch-run builds: the LLM service, the shared budget, the lifecycle
// sink (already wired to emit() at the session boundary), a per-branch LeafOpts
// factory that FORKS a fresh AxMemory (never shared across concurrent leaves), the
// usage reader for budget charging, plus a stable rootId to nest nodes under.
export type OrchLoadCtx = {
  readonly sessionId: string
  readonly message: string
  readonly rootId: string
  readonly ai: typeof llm
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
export type { AgentNode, Budget, BudgetExhaustedError, BudgetUsage, EmitOpts, EmitSink, LeafOpts, NodeEvent }

class OrchLoadError {
  readonly _tag = "OrchLoadError"
  constructor(readonly cause: unknown) {}
}

// Resolve a script reference to an absolute path INSIDE the trusted root, or throw.
// Accepts a bare name ("example", "example.ts") — never a path that escapes the root.
const resolveScript = (scriptRef: string): string => {
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

    const prims: OrchPrims = {
      leaf,
      parallel,
      pipeline,
      emit,
      allocate,
      agent,
      judge,
      loopUntilDry,
      adversarialVerify,
    }

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
      try: () =>
        otelContext.with(traceContext, async () => {
          const abs = resolveScript(scriptRef)
          const mod = (await import(abs)) as OrchScriptModule
          const fn = mod.orchestrate ?? mod.default
          if (typeof fn !== "function") {
            throw new Error(`script '${scriptRef}' must export an orchestrate(ctx, prims) function (or default)`)
          }
          // Bracket the whole script run as the root node so it nests in the tree
          // even if the script forgets to emit its own root.
          onEvent({ type: "start", nodeId: rootId, phase: `script:${scriptRef}` })
          try {
            const raw = await fn(ctx, prims)
            const res = toResult(raw)
            onEvent({ type: "done", nodeId: rootId, result: clip(res.reply) })
            return res
          } catch (cause) {
            onEvent({ type: "error", nodeId: rootId, cause })
            throw cause
          }
        }),
      catch: (e) => new OrchLoadError(e),
    })

    yield* Effect.logInfo("orchestrate.load.done").pipe(Effect.annotateLogs({ "reply.chars": out.reply.length }))
    return out
  })
