#!/usr/bin/env bun
// Oxlint gate + tiered upgrade path. Tier 1 (ship) = correctness errors; tier 2 =
// suspicious + perf (both error today); tier 3 (preview via --upgrade-report) =
// pedantic + restriction + promise/node import hardening. `runOxlint` is exported for
// oxlint-check.test.ts — ponytail: non-trivial logic leaves a runnable check.
//
// COORDINATION (yuku): oxlint does NOT duplicate design-check's crosscore seam,
// complexity budgets, or mutate/capture write-flow — complementary, not competing.
// scripts/lint-coordination.test.ts proves both gates pass together on the real tree.
//
// Upgrade: bump `oxlint` (bun run oxlint:upgrade), re-run `bun run oxlint:report`, then
// promote tier 3 per the preview when ready.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

export type OxlintDiag = { path: string; line: number; severity: "error" | "warning"; rule: string; message: string }

export const OXLINT_TIERS = [
  {
    id: 1,
    name: "ship",
    note: "correctness → error (blocks commit/CI)",
    promote: "already enforced in .oxlintrc.json categories.correctness",
  },
  {
    id: 2,
    name: "harden",
    note: "suspicious + perf → error (promoted); keep at zero — next promote tier 3",
    promote: "tier 2 is live; when clean, add pedantic + restriction per tier-3 preview",
  },
  {
    id: 3,
    name: "strict",
    note: "pedantic + restriction + selected promise/import/node rules",
    promote: "run `bun run oxlint:report` after tier 2 is clean; add categories + rules from preview",
  },
  {
    id: 4,
    name: "experimental",
    note: "nursery + --type-aware (needs oxlint version that supports it)",
    promote: "bun run oxlint:upgrade && oxlint --type-aware on a branch; not in CI yet",
  },
] as const

const SCAN = ["src", "scripts", "examples", "smoke-emit.ts"]
const OXLINT = `${process.cwd()}/node_modules/.bin/oxlint`

export const parseOxlintJson = (raw: string): Array<OxlintDiag> => {
  const parsed = JSON.parse(raw) as { diagnostics?: Array<{ filename: string; labels: Array<{ line: number }>; severity: string; code: string; message: string }> }
  return (parsed.diagnostics ?? []).map((d) => ({
    path: d.filename.replace(`${process.cwd()}/`, ""),
    line: d.labels[0]?.line ?? 0,
    severity: d.severity === "warning" ? "warning" : "error",
    rule: d.code,
    message: d.message,
  }))
}

export const runOxlint = (args: Array<string>): { ok: boolean; stdout: string; stderr: string; exitCode: number } => {
  const r = spawnSync(OXLINT, args, { encoding: "utf8", cwd: process.cwd() })
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 }
}

const tier3PreviewArgs = (): Array<string> => [
  ...SCAN,
  "-f",
  "json",
  "--deny-warnings",
  "-D",
  "pedantic",
  "-D",
  "restriction",
  "-D",
  "promise/no-return-wrap",
  "-D",
  "import/no-cycle",
  "-D",
  "node/no-deprecated-api",
]

const stagedPaths = (): Set<string> => {
  const r = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" })
  return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
}

const filterStaged = (diags: Array<OxlintDiag>, stage: Set<string>): Array<OxlintDiag> =>
  diags.filter((d) => stage.has(d.path) || stage.has(d.path.replace(/^\.\//, "")))

if (import.meta.main) {
  const staged = process.argv.includes("--staged")
  const upgradeReport = process.argv.includes("--upgrade-report")

  if (upgradeReport) {
    console.log("oxlint tiers (promote top → bottom when the prior tier is clean):\n")
    for (const t of OXLINT_TIERS) console.log(`  tier ${t.id} ${t.name}: ${t.note}\n    → ${t.promote}`)
    console.log("")
    const cur = runOxlint([...SCAN, "-f", "json", "-c", ".oxlintrc.json"])
    const curDiags = parseOxlintJson(cur.stdout || "{}")
    const errs = curDiags.filter((d) => d.severity === "error").length
    const warns = curDiags.filter((d) => d.severity === "warning").length
    console.log(`current (.oxlintrc.json): ${errs} error(s), ${warns} warning(s)`)
    const next = runOxlint([...tier3PreviewArgs(), "-c", ".oxlintrc.json"])
    const nextDiags = parseOxlintJson(next.stdout || "{}")
    console.log(`tier-3 preview (not enforced): ${nextDiags.length} additional diagnostic(s)`)
    if (nextDiags.length) {
      const byRule = new Map<string, number>()
      for (const d of nextDiags) byRule.set(d.rule, (byRule.get(d.rule) ?? 0) + 1)
      const top = [...byRule.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 8)
      for (const [rule, n] of top) console.log(`  ${rule}: ${n}`)
    }
    process.exit(0)
  }

  const r = runOxlint([...SCAN, "-f", "json", "-c", ".oxlintrc.json"])
  const diags = parseOxlintJson(r.stdout || "{}")
  const errors = diags.filter((d) => d.severity === "error")
  const warnings = diags.filter((d) => d.severity === "warning")
  const stage = staged ? stagedPaths() : null
  const blocking = stage ? filterStaged(errors, stage) : errors

  console.log(
    `oxlint: ${errors.length} error(s), ${warnings.length} warning(s)${stage ? ` (${blocking.length} blocking in staged files)` : ""}.`,
  )
  if (blocking.length) {
    for (const d of blocking.slice(0, 20)) console.log(`  ${d.path}:${d.line}  ${d.rule}  ${d.message}`)
    if (blocking.length > 20) console.log(`  … +${blocking.length - 20} more`)
  }
  if (warnings.length && !stage) console.log(`  (tier-2 warnings — promote when clean: bun run oxlint:report)`)

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { devDependencies?: Record<string, string> }
  const ver = pkg.devDependencies?.oxlint?.replace(/^\^/, "") ?? "?"
  console.log(`oxlint@${ver}`)

  process.exit(blocking.length > 0 ? 1 : 0)
}