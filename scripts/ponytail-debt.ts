#!/usr/bin/env bun
// Ponytail debt ledger. Zero deps. Harvests `ponytail:` shortcut markers and
// FAILS on any that names no upgrade trigger (those silently rot). Optional LOC
// budget gate (LOC_BUDGET env; 0 = measure only). `harvest` is exported so
// ponytail-debt.test.ts can assert it — ponytail: non-trivial logic leaves a check.
//
// Marker convention: `// ponytail: <ceiling>, <upgrade path>` (Upgrade: may be
// on a following continuation comment line).

export type DebtResult = { markers: string[]; noTrigger: number; loc: number }

export const harvest = (path: string, text: string): DebtResult => {
  const lines = text.split("\n")
  const markers: string[] = []
  let noTrigger = 0
  let loc = 0
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) loc++
    const m = line.match(/(?:\/\/|#)\s*ponytail:\s*(.+)/i)
    if (!m) return
    if (/<ceiling>|<upgrade/.test(m[1]!)) return // skip the convention-doc placeholder
    // A marker's body spans its line + following continuation comment lines, so
    // the upgrade path can live on the next line. Read the whole block.
    let body = m[1]!.trim()
    for (let j = i + 1; j < lines.length && lines[j]!.trim().startsWith("//"); j++) {
      if (/ponytail:/i.test(lines[j]!)) break // next marker — don't swallow its body
      body += ` ${lines[j]!.trim().replace(/^\/\/\s?/, "")}`
    }
    const hasTrigger = /upgrade:/i.test(body)
    if (!hasTrigger) noTrigger++
    markers.push(`  ${path}:${i + 1}  ${m[1]!.trim()}${hasTrigger ? "" : "  [no-trigger]"}`)
  })
  return { markers, noTrigger, loc }
}

if (import.meta.main) {
  const BUDGET = Number(process.env.LOC_BUDGET ?? 0)
  const SCAN_DIRS = ["src", "scripts"]
  const SCAN_FILES = ["smoke-emit.ts", "smoke-tools.ts", "build-viz.ts", "_turn_repro.ts"]

  const files: string[] = [...SCAN_FILES]
  // skip *.test.ts — their fixtures contain deliberate marker strings.
  for (const dir of SCAN_DIRS) for await (const p of new Bun.Glob("**/*.{ts,tsx}").scan(dir)) if (!p.endsWith(".test.ts")) files.push(`${dir}/${p}`)

  const markers: string[] = []
  let noTrigger = 0
  let loc = 0
  for (const path of files) {
    const r = harvest(
      path,
      await Bun.file(path)
        .text()
        .catch(() => ""),
    )
    markers.push(...r.markers)
    noTrigger += r.noTrigger
    loc += r.loc
  }

  console.log(`ponytail-debt: ${markers.length} marker(s), ${noTrigger} with no trigger.`)
  if (markers.length) console.log(markers.join("\n"))
  console.log(`loc: ${loc} code lines${BUDGET ? ` (budget ${BUDGET})` : ""}`)
  process.exit(noTrigger > 0 || (BUDGET > 0 && loc > BUDGET) ? 1 : 0)
}
