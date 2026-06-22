#!/usr/bin/env bun
// Runnable check for the debt harvester (ponytail: non-trivial logic leaves a
// check). Plain asserts, no framework.
import { harvest } from "./ponytail-debt.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

// good marker (single-line, has Upgrade:) + bad marker (no trigger) + a
// continuation-line Upgrade: + the convention placeholder (must be skipped).
const fixture = [
  "const a = 1 // code line",
  "// ponytail: global lock. Upgrade: per-turn queue.", // good
  "// ponytail: brittle regex with no escape hatch.", // bad (no upgrade)
  "// ponytail: file-level metric only.", // marker...
  "// Upgrade: per-function walk.", // ...trigger on continuation line -> good
  "// Marker convention: ponytail: <ceiling>, <upgrade path>", // placeholder -> skipped
].join("\n")

const r = harvest("fix.ts", fixture)
assert(r.markers.length === 3, `expected 3 markers, got ${r.markers.length}`)
assert(r.noTrigger === 1, `expected 1 no-trigger, got ${r.noTrigger}`)
assert(r.markers.some((m) => m.includes("[no-trigger]")), "no-trigger marker not tagged")
assert(r.loc === 1, `expected 1 code line, got ${r.loc}`)

// empty input
const e = harvest("e.ts", "")
assert(e.markers.length === 0 && e.noTrigger === 0, "empty file should yield no markers")

// block comment marker (the old line-regex missed these) with Upgrade: inside.
const block = harvest("b.ts", "const a = 1\n/* ponytail: sync write.\n   Upgrade: queue. */")
assert(block.markers.length === 1, `block marker not harvested: ${block.markers.length}`)
assert(block.noTrigger === 0, "block marker Upgrade: not detected")

// orphan: a marker whose comment guards no code (attaches to the program root)
// — the shortcut it described was deleted, the note rotted. Has Upgrade:, so the
// only thing wrong is the orphaning.
const orph = harvest("o.ts", "// ponytail: dangling note. Upgrade: remove me.")
assert(orph.orphan === 1, `expected 1 orphan, got ${orph.orphan}`)
assert(orph.markers.some((m) => m.includes("[orphan]")), "orphan marker not tagged")

// a marker sitting on real code is NOT an orphan.
const live = harvest("l.ts", "// ponytail: shortcut. Upgrade: later.\nexport const x = 1")
assert(live.orphan === 0, `live marker wrongly flagged orphan: ${live.orphan}`)

if (failed > 0) {
  console.error(`ponytail-debt.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("ponytail-debt.test: all pass ✓")
