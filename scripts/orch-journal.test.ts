#!/usr/bin/env bun
// Headless resume-journal test — NO LLM, NO network. Plain asserts, same fixture
// style as orch-core.test / orch.test. Proves the crash-resilience contract:
//
//   record a node's result → "restart" (drop the in-memory journal, RELOAD from disk)
//   → re-run with the SAME key → the cached result REPLAYS and the fake model fn is
//   NOT called again. Also pins: OFF-by-default pass-through, deterministic keying
//   (no Date.now / object-key order in the key), and atomic persistence to disk.
import type { AxAIService, AxGen } from "@ax-llm/ax"
import { rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import {
  journaledNode,
  journalKey,
  journalPath,
  loadJournal,
  saveJournal,
} from "../src/orch-journal.ts"
import type { NodeOpts } from "../src/orch.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

// A FAKE AxGen whose forward() COUNTS how many times it ran — the journal's whole job is
// to drive this count to ZERO on a replay. Returns a deterministic reply per input.
// ponytail: structural fake over the AxGen surface (only forward() is exercised by node()).
// Upgrade: a typed double implementing the full AxGen interface if node() calls more methods.
const countingGen = (reply: string) => {
  let calls = 0
  const gen = {
    forward: async (_ai: unknown, _input: unknown, _o: unknown): Promise<{ reply: string }> => {
      calls++
      return { reply }
    },
    get calls() {
      return calls
    },
  }
  return { gen: gen as unknown as AxGen<{ message: string }, { reply: string }>, get calls() { return calls } }
}

const fakeAi = {} as AxAIService

// A minimal NodeOpts — the fake forward() ignores most fields; maxSteps/stream feed the key.
const opts = (over: Partial<NodeOpts> = {}): NodeOpts =>
  ({
    mem: {},
    sessionId: "journal-test",
    tracer: undefined,
    traceContext: undefined,
    maxSteps: 7,
    stream: false,
    abortSignal: new AbortController().signal,
    ...over,
  }) as unknown as NodeOpts

// A unique sessionId per run so a stale file from a prior run can't mask a regression.
const SESSION = `journal-test-${process.pid}`

await (async () => {
  // Clean slate: remove any prior journal file for this session.
  await rm(journalPath(SESSION), { force: true })

  // 1) DETERMINISTIC KEY: same (nodeId, input, opts) ⇒ same key across calls; object-key
  // ORDER in the input does NOT change the key (stable serialization); a different input
  // or a different output-determining opt DOES change it.
  {
    const a = journalKey("n", { message: "hi", x: 1 } as any, opts())
    const b = journalKey("n", { x: 1, message: "hi" } as any, opts()) // keys reordered
    assert(a === b, `key is stable under object-key reordering, got ${a} vs ${b}`)
    const c = journalKey("n", { message: "bye" } as any, opts())
    assert(a !== c, "a different input yields a different key")
    const d = journalKey("n", { message: "hi", x: 1 } as any, opts({ maxSteps: 99 }))
    assert(a !== d, "a different output-determining opt (maxSteps) yields a different key")
    const e = journalKey("other", { message: "hi", x: 1 } as any, opts())
    assert(a !== e, "a different nodeId yields a different key")
  }

  // 2) OFF BY DEFAULT: with enabled omitted (or no journal), journaledNode is a pure
  // pass-through — it runs the model and writes NOTHING to disk.
  {
    const c = countingGen("plain")
    const out = await journaledNode(c.gen, opts(), { nodeId: "off" })(fakeAi, { message: "q" })
    assert(out.reply === "plain", `disabled journaledNode returns the live reply, got ${JSON.stringify(out)}`)
    assert(c.calls === 1, `disabled journaledNode calls the model once, got ${c.calls}`)
    assert(!existsSync(journalPath(SESSION)), "disabled journaledNode persists NOTHING")
  }

  // 3) THE HEADLINE: record → restart → REPLAY (model fn NOT called again).
  {
    // --- run 1: fresh journal, key MISS → real forward, record + persist to disk. ---
    const journal1 = await loadJournal(SESSION)
    assert(journal1.entries.size === 0, "first load is an empty journal (no file yet)")
    const c1 = countingGen("the-real-answer")
    const input = { message: "expensive question" }
    const out1 = await journaledNode(c1.gen, opts(), { journal: journal1, nodeId: "leaf-1", enabled: true })(fakeAi, input)
    assert(out1.reply === "the-real-answer", `run 1 returns the live reply, got ${JSON.stringify(out1)}`)
    assert(c1.calls === 1, `run 1 calls the model exactly once, got ${c1.calls}`)
    assert(existsSync(journalPath(SESSION)), "run 1 persisted the journal to disk (survives a crash)")

    // --- "RESTART": drop journal1 entirely, RELOAD from disk (simulates a new process). ---
    const journal2 = await loadJournal(SESSION)
    assert(journal2 !== journal1, "the reloaded journal is a NEW object (fresh process)")
    assert(journal2.entries.size === 1, `reloaded journal carries the 1 recorded entry, got ${journal2.entries.size}`)

    // --- run 2: SAME key → REPLAY from cache. The fake model fn must NOT run again. ---
    const c2 = countingGen("SHOULD-NOT-BE-RETURNED")
    const out2 = await journaledNode(c2.gen, opts(), { journal: journal2, nodeId: "leaf-1", enabled: true })(fakeAi, input)
    assert(c2.calls === 0, `REPLAY: the model fn is NOT called again on a cache hit, got ${c2.calls} call(s)`)
    assert(out2.reply === "the-real-answer", `REPLAY returns the CACHED result, not the live gen, got ${JSON.stringify(out2)}`)
  }

  // 4) A NEW key (different input) on the reloaded journal is a MISS → runs the model and
  // appends a second entry (the journal grows; old entries survive).
  {
    const journal = await loadJournal(SESSION)
    const before = journal.entries.size
    const c = countingGen("second-answer")
    const out = await journaledNode(c.gen, opts(), { journal, nodeId: "leaf-1", enabled: true })(fakeAi, { message: "a different question" })
    assert(c.calls === 1, `a NEW key is a MISS → the model runs, got ${c.calls}`)
    assert(out.reply === "second-answer", "new-key miss returns the freshly produced result")
    const reloaded = await loadJournal(SESSION)
    assert(reloaded.entries.size === before + 1, `the new entry was persisted alongside the old, ${reloaded.entries.size} vs ${before + 1}`)
  }

  // 5) saveJournal is a no-op when not dirty (nothing new to write) — a pure load then
  // save must not churn the file. We assert dirty stays false across a save.
  {
    const journal = await loadJournal(SESSION)
    assert(journal.dirty === false, "a freshly loaded journal is not dirty")
    await saveJournal(journal) // no-op
    assert(journal.dirty === false, "saveJournal leaves a clean journal clean (no-op when not dirty)")
  }

  // cleanup the test's journal file.
  await rm(journalPath(SESSION), { force: true })
})()

if (failed > 0) {
  console.error(`orch-journal.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("orch-journal.test: all pass ✓")
