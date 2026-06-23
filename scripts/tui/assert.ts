// Tiny shared assert kit for the headless TUI frame tests — rlmcode fixture style (plain
// asserts, no framework; see scripts/orch-tree-render.test.ts). Each test file imports
// `report()` and exits non-zero on any failure, so `bun scripts/tui/*.test.ts` is a gate.
//
// Frame assertions match STABLE STRUCTURE (connectors, labels, the ❯ focus gutter, the Σ
// footer), NOT a byte-exact grid: the busy spinner glyph cycles and the status line wraps,
// so an exact-frame golden would flake. Substring/predicate matches over the captured text
// are the right granularity — they pin what the eye reads, immune to spinner phase.
export type Asserter = {
  ok(cond: boolean, msg: string): void
  has(frame: string, needle: string | RegExp, msg: string): void
  hasNot(frame: string, needle: string | RegExp, msg: string): void
  done(): number
}

export const makeAsserter = (suite: string): Asserter => {
  let failed = 0
  const fail = (msg: string, extra?: string) => {
    console.error(`  FAIL [${suite}]: ${msg}${extra ? `\n${extra}` : ""}`)
    failed++
  }
  const test = (frame: string, needle: string | RegExp) =>
    typeof needle === "string" ? frame.includes(needle) : needle.test(frame)
  return {
    ok: (cond, msg) => void (cond || fail(msg)),
    has: (frame, needle, msg) => void (test(frame, needle) || fail(msg, indent(frame))),
    hasNot: (frame, needle, msg) => void (!test(frame, needle) || fail(msg, indent(frame))),
    done: () => failed,
  }
}

const indent = (frame: string) =>
  frame
    .split("\n")
    .map((l) => `      │ ${l}`)
    .join("\n")

// Run a suite body, print the result line, and propagate the failure count as the exit code
// so the test file is a real gate. Always tears the driver down (the body owns launch/stop).
export const report = async (suite: string, body: (a: Asserter) => Promise<void>): Promise<void> => {
  const a = makeAsserter(suite)
  try {
    await body(a)
  } catch (e) {
    console.error(`  FAIL [${suite}]: threw ${e instanceof Error ? e.message : String(e)}`)
    if (e instanceof Error && e.cause) console.error(`    cause: ${String(e.cause)}`)
    process.exit(1)
  }
  const failed = a.done()
  if (failed > 0) {
    console.error(`${suite}: ${failed} failure(s).`)
    process.exit(1)
  }
  console.log(`${suite}: all pass ✓`)
}
