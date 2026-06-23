#!/usr/bin/env bun
// Runnable check for the design gate (ponytail: non-trivial logic leaves a
// check behind). Plain asserts, no framework. One fixture per finding tag:
// if the walker/heuristics drift, this fails instead of silently passing.
import { analyze, buildAnalyzer, coreBarrelFromPkg, type Finding, pkgRoot, unusedDeps } from "./design-check.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}
const has = (f: Finding[], tag: Finding["tag"], sub: string) => f.some((x) => x.tag === tag && x.msg.includes(sub))
const an = (files: { path: string; source: string }[]) => analyze(buildAnalyzer(files))

// dead export
assert(has(an([{ path: "src/x.ts", source: "export const dead = 1" }]), "delete", "dead export"), "dead export not flagged")

// unused import (a is imported into b but never used in b)
assert(
  has(an([{ path: "src/a.ts", source: "export const a = 1" }, { path: "src/b.ts", source: 'import { a } from "./a.ts"\nexport const b = 2' }]), "delete", "unused import"),
  "unused import not flagged",
)

// native dependency dupe
assert(has(an([{ path: "src/x.ts", source: 'import moment from "moment"\nexport const z = moment' }]), "native", "moment"), "native dupe not flagged")

// complex function — 40 branches, intentionally far over any sane budget so
// tuning CC_BUDGET doesn't false-fail this (decoupled from the exact number).
const ifs = Array.from({ length: 40 }, (_, i) => `if (x === ${i}) {}`).join("\n")
assert(has(an([{ path: "src/x.ts", source: `export function big(x: number) { ${ifs}; return x }` }]), "shrink", "cyclomatic"), "complexity not flagged")

// long parameter list (7 > budget 6)
assert(has(an([{ path: "src/x.ts", source: "export function p(a, b, c, d, e, f, g) { return a }" }]), "yagni", "params"), "long params not flagged")

// circular dependency
assert(
  has(an([{ path: "src/a.ts", source: 'import "./b.ts"\nexport const a = 1' }, { path: "src/b.ts", source: 'import "./a.ts"\nexport const b = 1' }]), "cycle", "circular"),
  "cycle not flagged",
)

// mutate: local written but never read (dead write) — tsc-invisible.
assert(
  has(an([{ path: "src/x.ts", source: "export function f() { let n = 1; n = 2; return 0 }" }]), "mutate", "never read"),
  "dead write not flagged",
)

// mutate: exported mutable binding reassigned.
assert(
  has(an([{ path: "src/x.ts", source: "export let counter = 0\nexport function bump() { counter++ }" }]), "mutate", "exported mutable"),
  "mutable export not flagged",
)

// capture: closure writes a shared module-level binding.
assert(
  has(an([{ path: "src/x.ts", source: "let total = 0\nexport function add(n: number) { total += n }" }]), "capture", "shared module binding"),
  "mutable capture not flagged",
)

// crosscore: a presentation file (src/tui/*) deep-importing a core module other than the
// src/core/sdk.ts barrel is flagged — even a type-only import couples it to engine internals.
const crosscoreFixture = [
  { path: "src/core/agent.ts", source: "export const x = 1" },
  { path: "src/core/run.ts", source: "export type T = number" },
  { path: "src/core/sdk.ts", source: "export const s = 1" },
  { path: "src/tui/bad.ts", source: 'import { x } from "../core/agent.ts"\nimport type { T } from "../core/run.ts"\nexport const y: T = x' },
  { path: "src/tui/good.ts", source: 'import { s } from "../core/sdk.ts"\nexport const z = s' },
  { path: "src/app/wire.ts", source: 'import { x } from "../core/agent.ts"\nexport const w = x' },
]
const cc = an(crosscoreFixture)
assert(has(cc, "crosscore", 'src/tui/bad.ts: deep import of core module "src/core/agent.ts"'), "crosscore value deep-import not flagged")
assert(has(cc, "crosscore", 'src/tui/bad.ts: deep import of core module "src/core/run.ts"'), "crosscore type-only deep-import not flagged")
assert(!cc.some((f) => f.tag === "crosscore" && f.msg.startsWith("src/tui/good.ts")), "barrel import false-flagged as crosscore")
assert(!cc.some((f) => f.tag === "crosscore" && f.msg.startsWith("src/app/wire.ts")), "trusted app-layer core import false-flagged as crosscore")

// broken: ambiguous re-export (same name via two `export *`) is a link error.
assert(
  has(
    an([
      { path: "src/a.ts", source: 'export * from "./b.ts"\nexport * from "./c.ts"' },
      { path: "src/b.ts", source: "export const dup = 1" },
      { path: "src/c.ts", source: "export const dup = 2" },
      { path: "src/d.ts", source: 'import { dup } from "./a.ts"\nexport const use = dup' },
    ]),
    "broken",
    "",
  ),
  "ambiguous re-export not surfaced",
)

// unused dependency (+ used dep not false-flagged, + allow-list honored)
const u = unusedDeps(new Set(["effect"]), ["effect", "leftover-pkg", "@otel/peer"], new Set(["@otel/peer"]))
assert(u.some((x) => x.msg.includes("leftover-pkg")), "unused dep not flagged")
assert(!u.some((x) => x.msg.includes('"effect"')), "used dep false-flagged")
assert(!u.some((x) => x.msg.includes("@otel/peer")), "allow-listed dep flagged")

// reachability: a dead CLUSTER (a<->b, nothing reaches it) is flagged unreachable
// even though each side keeps the other's per-symbol refcount > 0 — the precise
// win over a refcount-only dead-export check.
const reachFiles = [
  { path: "src/entry.ts", source: 'import { live } from "./live.ts"\nexport const e = live' },
  { path: "src/live.ts", source: "export const live = 1" },
  { path: "src/deadA.ts", source: 'import { b } from "./deadB.ts"\nexport const a = b' },
  { path: "src/deadB.ts", source: 'import { a } from "./deadA.ts"\nexport const b = a' },
]
const reach = analyze(buildAnalyzer(reachFiles), { roots: new Set(["src/entry.ts"]) })
assert(has(reach, "delete", "src/deadA.ts: module unreachable"), "dead-cluster member A not flagged unreachable")
assert(has(reach, "delete", "src/deadB.ts: module unreachable"), "dead-cluster member B not flagged unreachable")
assert(!reach.some((f) => f.msg.startsWith("src/live.ts") && f.msg.includes("unreachable")), "reachable module false-flagged unreachable")
assert(!reach.some((f) => f.msg.startsWith("src/entry.ts") && f.msg.includes("unreachable")), "root false-flagged unreachable")

// reachability is OFF without roots (fixture default) — no "unreachable" findings,
// so the per-tag unit fixtures above drive analyze() exactly as before.
assert(!an(reachFiles).some((f) => f.msg.includes("unreachable")), "reachability ran without roots")

// a NON-LINTED consumer (test/example/script) reference makes a module reachable:
// a seam used only by tests is live with NO hand-maintained keep-alive entry, and the
// consumer file is itself neither linted nor reported (incl. its own link errors).
const consumerFiles = [
  { path: "src/entry.ts", source: "export const e = 1" },
  { path: "src/seam.ts", source: "export const seam = 1" },
  { path: "scripts/x.test.ts", source: 'import { seam } from "../src/seam.ts"\nimport { gone } from "../src/entry.ts"\nexport const t = [seam, gone]' },
]
const consumed = analyze(buildAnalyzer(consumerFiles), { roots: new Set(["src/entry.ts"]), isLinted: (p) => p.startsWith("src/") })
assert(!consumed.some((f) => f.msg.includes("src/seam.ts") && f.msg.includes("unreachable")), "consumer-only module false-flagged unreachable")
assert(!consumed.some((f) => f.msg.startsWith("scripts/")), "non-linted consumer was linted/reported")

// coreBarrelFromPkg: the cross-core seam is read from package.json "exports" "."
// (string OR conditional), falling back to the default so it can't silently drift.
assert(coreBarrelFromPkg({ exports: { ".": "./src/core/sdk.ts" } }) === "src/core/sdk.ts", "barrel from string export")
assert(coreBarrelFromPkg({ exports: { ".": { import: "./src/core/sdk.ts" } } }) === "src/core/sdk.ts", "barrel from import condition")
assert(coreBarrelFromPkg({}) === "src/core/sdk.ts", "barrel falls back to default")

// pkgRoot
assert(pkgRoot("@scope/pkg/sub") === "@scope/pkg", "scoped pkgRoot")
assert(pkgRoot("pkg/sub") === "pkg", "unscoped pkgRoot")
assert(pkgRoot("./rel") === null, "relative pkgRoot ignored")
assert(pkgRoot("node:fs") === null, "node: builtin ignored")

if (failed > 0) {
  console.error(`design-check.test: ${failed} failure(s).`)
  process.exit(1)
}
console.log("design-check.test: all pass ✓")
