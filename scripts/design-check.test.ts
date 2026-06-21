#!/usr/bin/env bun
// Runnable check for the design gate (ponytail: non-trivial logic leaves a
// check behind). Plain asserts, no framework. One fixture per finding tag:
// if the walker/heuristics drift, this fails instead of silently passing.
import { analyze, buildAnalyzer, type Finding, pkgRoot, unusedDeps } from "./design-check.ts"

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

// complex function (20 branches > budget 18)
const ifs = Array.from({ length: 20 }, (_, i) => `if (x === ${i}) {}`).join("\n")
assert(has(an([{ path: "src/x.ts", source: `export function big(x: number) { ${ifs}; return x }` }]), "shrink", "cyclomatic"), "complexity not flagged")

// long parameter list (7 > budget 6)
assert(has(an([{ path: "src/x.ts", source: "export function p(a, b, c, d, e, f, g) { return a }" }]), "yagni", "params"), "long params not flagged")

// circular dependency
assert(
  has(an([{ path: "src/a.ts", source: 'import "./b.ts"\nexport const a = 1' }, { path: "src/b.ts", source: 'import "./a.ts"\nexport const b = 1' }]), "cycle", "circular"),
  "cycle not flagged",
)

// unused dependency (+ used dep not false-flagged, + allow-list honored)
const u = unusedDeps(new Set(["effect"]), ["effect", "leftover-pkg", "@otel/peer"], new Set(["@otel/peer"]))
assert(u.some((x) => x.msg.includes("leftover-pkg")), "unused dep not flagged")
assert(!u.some((x) => x.msg.includes('"effect"')), "used dep false-flagged")
assert(!u.some((x) => x.msg.includes("@otel/peer")), "allow-listed dep flagged")

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
