#!/usr/bin/env bun
// Ponytail debt ledger. Zero runtime deps beyond yuku-analyzer. Harvests
// `ponytail:` shortcut markers from PARSED comments (not a line regex), so it
// sees block comments and JSX comments too, with exact source spans. FAILS on:
//   - any marker that names no upgrade trigger (`Upgrade:`) — silent rot, and
//   - any ORPHANED marker whose comment attaches to the program root, i.e. the
//     code it guarded was deleted and the note was left dangling.
// Optional LOC budget gate (LOC_BUDGET env; 0 = measure only). `harvest` is
// exported so ponytail-debt.test.ts can assert it — ponytail: non-trivial logic
// leaves a check.
//
// Marker convention: `// ponytail: <ceiling>, <upgrade path>` (Upgrade: may be
// on a following continuation comment line).
import type { Node } from "@yuku-toolchain/types"
import { Analyzer, type Module } from "yuku-analyzer"

export type DebtResult = { markers: string[]; noTrigger: number; orphan: number; loc: number }

// Anchored at the comment start (after optional ws / block-comment `*`), so a
// prose mention mid-comment ("…— ponytail: non-trivial logic leaves a check")
// is NOT harvested as a marker — only `// ponytail: …` lines are.
const MARKER = /^[\s*]*ponytail:\s*(.+)/is
const PLACEHOLDER = /<ceiling>|<upgrade/

// Map every attached comment back to its host node (AttachedComment carries no
// offset, so we key on its text). A marker whose host is the Program root guards
// no code — it's an orphan.
const hostByComment = (m: Module): Map<string, Node> => {
  const map = new Map<string, Node>()
  m.walk({
    enter: (node) => {
      for (const c of node.comments ?? []) if (!map.has(c.value)) map.set(c.value, node)
    },
  })
  return map
}

export const harvest = (path: string, text: string): DebtResult => {
  const a = new Analyzer()
  const m = a.addFile(path, text, { attachComments: true })
  const hosts = hostByComment(m)
  const comments = m.comments

  const markers: string[] = []
  let noTrigger = 0
  let orphan = 0
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i]!
    const match = c.value.match(MARKER)
    if (!match) continue
    if (PLACEHOLDER.test(match[1]!)) continue // skip the convention-doc placeholder

    // Body = this comment's text plus any following CONTIGUOUS line comments
    // (the upgrade path may live on the next `//` line). Block comments already
    // carry their full multi-line body in `value`.
    let body = match[1]!.trim()
    let prevLine = m.locOf(c.end).line
    for (let j = i + 1; c.type === "Line" && j < comments.length; j++) {
      const cj = comments[j]!
      if (cj.type !== "Line" || m.locOf(cj.start).line !== prevLine + 1) break
      if (MARKER.test(cj.value)) break // next marker — don't swallow its body
      body += ` ${cj.value.trim()}`
      prevLine = m.locOf(cj.end).line
    }

    const hasTrigger = /upgrade:/i.test(body)
    const host = hosts.get(c.value)
    const isOrphan = !host || host.type === "Program"
    if (!hasTrigger) noTrigger++
    if (isOrphan) orphan++
    const flags = `${hasTrigger ? "" : "  [no-trigger]"}${isOrphan ? "  [orphan]" : ""}`
    markers.push(`  ${path}:${m.locOf(c.start).line}  ${match[1]!.trim()}${flags}`)
  }

  // Code lines: non-blank source lines that are not wholly a comment.
  const lines = text.split("\n")
  let loc = 0
  for (const line of lines) {
    const t = line.trim()
    if (t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) loc++
  }
  return { markers, noTrigger, orphan, loc }
}

if (import.meta.main) {
  const BUDGET = Number(process.env.LOC_BUDGET ?? 0)
  const staged = process.argv.includes("--staged")
  const SCAN_DIRS = ["src", "scripts"]
  const SCAN_FILES: string[] = []

  // As a pre-commit gate, only block on markers in STAGED files, so one agent's
  // WIP marker can't fail another's commit. Whole-tree otherwise.
  let stage: Set<string> | null = null
  if (staged) {
    const r = Bun.spawnSync(["git", "diff", "--cached", "--name-only"])
    stage = new Set(r.success ? r.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean) : [])
  }

  const files: string[] = [...SCAN_FILES]
  // skip *.test.ts — their fixtures contain deliberate marker strings.
  for (const dir of SCAN_DIRS)
    for await (const p of new Bun.Glob("**/*.{ts,tsx}").scan(dir)) if (!p.endsWith(".test.ts")) files.push(`${dir}/${p}`)

  const markers: string[] = []
  let noTrigger = 0
  let orphan = 0
  let stagedBlocking = 0
  let loc = 0
  for (const path of files) {
    const r = harvest(path, await Bun.file(path).text().catch(() => ""))
    markers.push(...r.markers)
    noTrigger += r.noTrigger
    orphan += r.orphan
    if (!stage || stage.has(path)) stagedBlocking += r.noTrigger + r.orphan
    loc += r.loc
  }

  console.log(
    `ponytail-debt: ${markers.length} marker(s), ${noTrigger} no-trigger, ${orphan} orphan${stage ? ` (${stagedBlocking} blocking in staged files)` : ""}.`,
  )
  if (markers.length) console.log(markers.join("\n"))
  console.log(`loc: ${loc} code lines${BUDGET ? ` (budget ${BUDGET})` : ""}`)
  const blocking = stage ? stagedBlocking : noTrigger + orphan
  process.exit(blocking > 0 || (BUDGET > 0 && loc > BUDGET) ? 1 : 0)
}
