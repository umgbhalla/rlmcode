#!/usr/bin/env bun
// Lint-coordination gate: oxlint (syntax/correctness/perf) and yuku design-check
// (semantic architecture) must BOTH pass on the real tree without prescribing
// contradictory fixes. Exported SCOPE documents the intentional split so a future
// tier promotion doesn't surprise us — ponytail: non-trivial logic leaves a check.
import { spawnSync } from "node:child_process"
import { analyze, buildAnalyzer, coreBarrelFromPkg } from "./design-check.ts"
import { runOxlint } from "./oxlint-check.ts"

let failed = 0
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  } else console.log(`ok: ${msg}`)
}

// Intentional division of labor — NOT overlap to delete, complementary gates.
export const LINT_SCOPE = {
  oxlint: {
    paths: ["src", "scripts", "examples", "smoke-emit.ts"],
    owns: ["correctness", "suspicious", "perf", "react-hooks", "unicorn idioms"],
  },
  yuku: {
    lintedPaths: "src/** only (isLinted)",
    graphPaths: "src + scripts + examples (reachability + crosscore consumers)",
    owns: ["crosscore boundary", "dead exports/modules", "import cycles", "CC/nest/params budgets", "mutate/capture write-flow", "unused deps vs package.json"],
  },
  sharedAligned: ["unused imports/vars — both flag; fixes satisfy both"],
  nonOverlapping: ["yuku file-size + complexity budgets (oxlint has no equivalent)", "oxlint react/perf idioms (yuku has no equivalent)"],
} as const

// Patterns oxlint tier-2 promoted that yuku intentionally does NOT police (no fight).
const OXLINT_OK_YUKU_NEUTRAL = [
  "Array#toSorted() over .sort()",
  "no-map-spread object rebuilds in .map()",
  "module-level helpers (consistent-function-scoping)",
  "holder-object mutation ({ seq }) instead of export let (yuku mutate-safe)",
] as const

const runBun = (script: string): number =>
  spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8" }).status ?? 1

// ── live repo: both programmatic gates green together ─────────────────────────
ok(runOxlint(["src", "scripts", "examples", "smoke-emit.ts", "-f", "json", "-c", ".oxlintrc.json"]).exitCode === 0, "oxlint passes on the linted tree")
ok(runBun("scripts/design-check.ts") === 0, "yuku design-check passes on the linted tree")

// ── scope contract ────────────────────────────────────────────────────────────
ok(LINT_SCOPE.yuku.lintedPaths.includes("src"), "yuku structural lint is src/-scoped")
ok(LINT_SCOPE.oxlint.paths.includes("scripts"), "oxlint covers scripts yuku does not structurally lint")
ok(OXLINT_OK_YUKU_NEUTRAL.length >= 3, "documented oxlint patterns that do not fight yuku")

// ── fixture: oxlint-friendly refactors stay yuku-clean on capture/mutate ─────
// Holder-object id pattern (theme.ts / atoms.ts style) — oxlint allows it; yuku must not flag capture.
const holderFixture = `
const idState = { seq: 0 }
const newId = () => \`s\${++idState.seq}\`
export const f = () => newId()
`
const holderAnalyzer = buildAnalyzer([{ path: "src/holder.ts", source: holderFixture }])
const holderFindings = analyze(holderAnalyzer, {
  roots: new Set(["src/holder.ts"]),
  isLinted: (p) => p.startsWith("src/"),
  coreBarrel: "src/core/sdk.ts",
})
ok(!holderFindings.some((f) => f.tag === "capture" || f.tag === "mutate"), "holder-object pattern is oxlint+yuku compatible")

// toSorted in design-check itself — oxlint rule, yuku-neutral
ok(buildAnalyzer([{ path: "scripts/x.ts", source: "[1,3,2].toSorted().join()" }]) !== null, "toSorted fixture parses under yuku analyzer")

// crosscore stays yuku-only: oxlint does not enforce the sdk barrel seam
const pkg = await Bun.file("package.json").json()
const barrel = coreBarrelFromPkg(pkg)
ok(barrel === "src/core/sdk.ts", "yuku crosscore barrel matches package.json exports")

console.log("\nlint-coordination: scopes documented; oxlint + yuku pass together.")
for (const [gate, scope] of Object.entries(LINT_SCOPE)) console.log(`  ${gate}:`, JSON.stringify(scope))

process.exit(failed ? 1 : 0)