#!/usr/bin/env bun
import { OXLINT_TIERS, parseOxlintJson } from "./oxlint-check.ts"

let failed = 0
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  } else console.log(`ok: ${msg}`)
}

ok(OXLINT_TIERS.length >= 3, "upgrade path documents at least 3 tiers")
ok(OXLINT_TIERS[0]!.id === 1 && OXLINT_TIERS[0]!.name === "ship", "tier 1 is the ship gate")

const sample = JSON.stringify({
  diagnostics: [
    {
      filename: "/repo/src/a.ts",
      labels: [{ line: 4 }],
      severity: "error",
      code: "eslint(no-unused-vars)",
      message: "unused",
    },
  ],
})
const diags = parseOxlintJson(sample)
ok(diags.length === 1 && diags[0]!.severity === "error" && diags[0]!.line === 4, "parseOxlintJson maps severity + line")

process.exit(failed ? 1 : 0)