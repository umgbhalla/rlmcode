#!/usr/bin/env bun
// UNIT proof for D2/D5 — the workflow({script}) wall-clock timeout. NO network, NO CF creds:
// it drives the REAL workflow tool (WORKFLOW_TOOLS[0], the exact AxFunction the model calls)
// with scripts that make ZERO LLM calls, so the only thing under test is the timeout race
// added in workflow.ts (runScript wrapped in withTimeout, NodeTimeoutError → a partial string).
//
// The DEFECT (ENGINE-HARDEN.md D2): runScript ran the model-authored body with NO wall-clock
// cap, so an infinite/CPU-bound script HUNG the turn forever (the token budget is blind to a
// pure-JS loop — D5 — so the HARD ceiling never tripped). The FIX: race the body against
// RLM_WORKFLOW_TIMEOUT_MS; on timeout the tool returns "workflow timed out after Ns — partial"
// and the turn returns, never hangs.
//
// Set a TINY ceiling so the test is fast, then assert:
//   1) a HANG script (an await-yielding loop that never resolves) returns the timeout PARTIAL
//      WITHIN the ceiling (a generous wall-clock bound, not a hang) — the repro no longer repros.
//   2) a NORMAL good script returns its real value, identical behavior (the fix is additive).
// Runs in `bun run test` (the lint gate); no RLM_LIVE flag needed.

// A tiny ceiling makes the timeout fire fast. Set BEFORE importing workflow.ts (the constant is
// read at module load). 300ms is comfortably above the event-loop scheduling jitter yet tiny.
process.env.RLM_WORKFLOW_TIMEOUT_MS = "300"

const { WORKFLOW_TOOLS } = await import("../src/core/workflow.ts")

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

const tool = WORKFLOW_TOOLS.find((t) => t.name === "workflow")
if (!tool?.func) {
  console.error("workflow tool not found in WORKFLOW_TOOLS")
  process.exit(1)
}

const run = (script: string): Promise<string> =>
  Promise.resolve(
    tool.func(
      { script },
      { sessionId: "wf-timeout-unit", abortSignal: new AbortController().signal },
    ),
  ).then((o) => String(o ?? ""))

// 1) HANG — an await-yielding infinite wait. This NEVER resolves on its own; before the fix the
//    turn hung forever. With the fix the withTimeout race rejects with NodeTimeoutError at the
//    ceiling and the handler returns the partial. We add an OUTER guard (5x the ceiling) that
//    fails loudly if the tool ever hangs past it — so a regression (the timeout removed) is a
//    test FAILURE, not a stuck CI job.
const ceilingMs = 300
const guardMs = ceilingMs * 5
const outerGuard = <T,>(p: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not return within ${guardMs}ms — IT HUNG (timeout fix regressed)`)), guardMs)),
  ])

console.log("(1) HANG script — an await-yielding loop that never resolves")
const t0 = Date.now()
let hangReply = ""
try {
  // `await new Promise(()=>{})` yields to the event loop forever (interruptible by the race) —
  // the realistic model hang shape (a loop awaiting a prim that never completes / a sleep loop).
  hangReply = await outerGuard(run("await new Promise(() => {}); return 'never';"), "hang script")
} catch (e) {
  failures += 1
  console.error(`  ✗ ${String((e as Error).message)}`)
}
const elapsed = Date.now() - t0
console.log(`    elapsed ${elapsed}ms — reply: ${JSON.stringify(hangReply)}`)
assert(/timed out/i.test(hangReply), "(1) hang returns the timeout partial (not a hang, not a crash)")
assert(/partial/i.test(hangReply), "(1) the timeout reply is explicitly a PARTIAL")
assert(elapsed < guardMs, `(1) returned within the wall-clock bound (${elapsed}ms < ${guardMs}ms), not a hang`)

// 2) NORMAL — a good script with no nodes returns its real value, UNCHANGED. The fix must keep
//    good scripts identical; it only adds the timeout on the runaway path.
console.log("(2) NORMAL good script — returns its value identically (no node, no LLM)")
const okReply = await outerGuard(run("return 'hello-' + (1 + 1);"), "normal script")
console.log(`    reply: ${JSON.stringify(okReply)}`)
assert(/hello-2/.test(okReply), "(2) a normal script still returns its real value verbatim")
assert(!/timed out/i.test(okReply), "(2) a normal script is NOT timed out")

if (failures > 0) {
  console.error(`\nworkflow-timeout.test: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log("\nworkflow-timeout.test: all pass ✓")
