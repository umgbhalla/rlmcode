// @effect/vitest port of scripts/workflow-timeout.test.ts — the workflow({script}) wall-clock
// timeout. NO network, NO CF creds: drives the REAL workflow tool (WORKFLOW_TOOLS[0]) with
// scripts that make ZERO LLM calls, so the only thing under test is the timeout race in
// workflow.ts (runScript wrapped in withTimeout, NodeTimeoutError → a partial string).
//
// Uses REAL timers → it.live. The TINY ceiling is set BEFORE the dynamic import (the constant is
// read at module load; a static import hoists above the assignment).
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

process.env.RLM_WORKFLOW_TIMEOUT_MS = "300"

const { WORKFLOW_TOOLS } = await import("../src/core/workflow.ts")

const tool = WORKFLOW_TOOLS.find((t) => t.name === "workflow")
if (!tool?.func) throw new Error("workflow tool not found in WORKFLOW_TOOLS")
const wfFunc = tool.func

const run = (script: string): Promise<string> =>
  Promise.resolve(wfFunc({ script }, { sessionId: "wf-timeout-unit", abortSignal: new AbortController().signal })).then((o) =>
    String(o ?? ""),
  )

const ceilingMs = 300
const guardMs = ceilingMs * 5
const outerGuard = <T,>(p: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not return within ${guardMs}ms — IT HUNG (timeout fix regressed)`)), guardMs),
    ),
  ])

it.live("a HANG script returns the timeout PARTIAL within the wall-clock bound (no hang)", () =>
  Effect.promise(async () => {
    const t0 = Date.now()
    const hangReply = await outerGuard(run("await new Promise(() => {}); return 'never';"), "hang script")
    const elapsed = Date.now() - t0
    expect(/timed out/i.test(hangReply), "hang returns the timeout partial").toBe(true)
    expect(/partial/i.test(hangReply), "the timeout reply is explicitly a PARTIAL").toBe(true)
    expect(elapsed, `returned within the wall-clock bound (${elapsed}ms < ${guardMs}ms)`).toBeLessThan(guardMs)
  }),
)

it.live("a NORMAL good script returns its real value, unchanged", () =>
  Effect.promise(async () => {
    const okReply = await outerGuard(run("return 'hello-' + (1 + 1);"), "normal script")
    expect(/hello-2/.test(okReply), "a normal script still returns its real value verbatim").toBe(true)
    expect(/timed out/i.test(okReply), "a normal script is NOT timed out").toBe(false)
  }),
)
