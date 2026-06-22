#!/usr/bin/env bun
// Real semantic design analysis on yuku-analyzer (not comment-grep). One
// cross-file pass over src/, reporting design smells that tsc doesn't:
//   broken:  unresolvable / ambiguous import or re-export (link diagnostic)
//   delete:  dead export / unused import / unused dependency
//   native:  a dependency that duplicates a platform/runtime native
//   cycle:   import cycle between modules
//   shrink:  cyclomatic complexity / nesting depth over budget
//   yagni:   too many parameters
//   mutate:  exported mutable binding reassigned / local written but never read
//   capture: closure writes a shared module-level binding
//
// Core logic is exported (buildAnalyzer/analyze/unusedDeps) so scripts/
// design-check.test.ts can assert it on fixtures — ponytail: non-trivial
// logic leaves a runnable check.
import { Analyzer, SymbolFlags } from "yuku-analyzer"

export type Finding = { tag: "broken" | "delete" | "native" | "cycle" | "shrink" | "yagni" | "mutate" | "capture"; msg: string }

// Reachability roots: their exports are public API / entrypoints, not dead.
// chat.tsx = app entry; orch.ts = orchestration-core library surface; orch-recipes.ts
// = userland recipe surface (runNode() by turn(); judge/loopUntilDry/adversarialVerify
// by orch-run.orchestrate()) — kept a root so the recipe library surface isn't pruned
// to only its current callers.
const ENTRY = new Set(["src/chat.tsx", "src/orch.ts", "src/orch-recipes.ts"])
const CC_BUDGET = 20 // cyclomatic complexity per function (UI render fns with several display states idiomatically reach ~19; >20 = real tangle)
const NEST_BUDGET = 5 // block nesting depth per function
const PARAM_BUDGET = 6 // parameters per function
const LINE_BUDGET = 500 // source lines per file

// Existing oversized files grandfathered in. New files must stay under LINE_BUDGET.
const OVERSIZED_ALLOWLIST = new Set(["src/chat.tsx", "build-viz.ts"])

// Dependencies that duplicate a Bun/modern-JS native. Curated (low false
// positive) — flags the package, not "you wrote a manual loop".
const NATIVE_DUPES: Record<string, string> = {
  moment: "Intl.DateTimeFormat / Temporal",
  dayjs: "Intl.DateTimeFormat",
  uuid: "crypto.randomUUID()",
  "node-fetch": "global fetch",
  axios: "fetch",
  dotenv: "Bun --env-file",
  "lodash.get": "?. optional chaining",
  classnames: "template literal",
  "left-pad": "String.prototype.padStart",
  querystring: "URLSearchParams",
  rimraf: "fs.rm({ recursive: true })",
}

const BRANCH = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "ConditionalExpression",
  "LogicalExpression",
  "SwitchCase",
  "CatchClause",
])
const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])

export const pkgRoot = (spec: string): string | null => {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null
  const parts = spec.split("/")
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

export const buildAnalyzer = (files: { path: string; source: string }[]): Analyzer => {
  const a = new Analyzer()
  for (const f of files) a.addFile(f.path, f.source)
  a.link()
  return a
}

export const importedRoots = (a: Analyzer): Set<string> => {
  const roots = new Set<string>()
  for (const m of a.modules.values()) for (const imp of m.imports) {
    const root = pkgRoot(imp.specifier)
    if (root) roots.add(root)
  }
  return roots
}

const lineOf = (m: any, node: any): number => {
  const off = node?.start ?? node?.range?.[0]
  if (typeof off !== "number" || !m.lineStarts) return 0
  let lo = 0
  let hi = m.lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (m.lineStarts[mid] <= off) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

const countLines = (source: string): number => source.split(/\r?\n/).length

export const analyze = (a: Analyzer): Finding[] => {
  const out: Finding[] = []
  for (const m of a.modules.values()) {
    // file-size budget: 1000 lines per source file, with an allow-list for
    // existing oversized files so the rule only blocks new growth.
    if (!OVERSIZED_ALLOWLIST.has(m.path)) {
      const lines = countLines(m.source)
      if (lines > LINE_BUDGET) out.push({ tag: "shrink", msg: `${m.path}: ${lines} lines (budget ${LINE_BUDGET}). Split the file.` })
    }
    // dead exports (cross-file). Skip entry roots + type-only (referencesOf undercounts type uses).
    if (!ENTRY.has(m.path)) {
      for (const s of m.symbols) {
        if (!s.has(SymbolFlags.Exported)) continue
        if (s.has(SymbolFlags.TypeSpace) && !s.has(SymbolFlags.ValueSpace)) continue
        if (a.referencesOf(s).length === 0) out.push({ tag: "delete", msg: `${m.path}: dead export "${s.name}". Referenced nowhere — drop it.` })
      }
    }
    // unused imports + native-duplicating dependencies.
    for (const imp of m.imports) {
      const root = pkgRoot(imp.specifier)
      if (root && NATIVE_DUPES[root]) out.push({ tag: "native", msg: `${m.path}: "${root}" duplicates a native — use ${NATIVE_DUPES[root]}.` })
      if (imp.isSideEffect || imp.typeOnly || !imp.local) continue
      if (imp.local.references.length === 0) out.push({ tag: "delete", msg: `${m.path}: unused import "${imp.local.name}". Remove it.` })
    }
    // per-function complexity, nesting, param count (AST walk + function stack).
    const stack: { name: string; line: number; cc: number; params: number; startDepth: number; maxDepth: number }[] = []
    let depth = 0
    const fnHooks = {
      enter: (n: any) => stack.push({ name: n.id?.name ?? "(anonymous)", line: lineOf(m, n), cc: 1, params: n.params?.length ?? 0, startDepth: depth, maxDepth: 0 }),
      leave: () => {
        const f = stack.pop()!
        const where = `${m.path}:${f.line} ${f.name}`
        if (f.cc > CC_BUDGET) out.push({ tag: "shrink", msg: `${where}: cyclomatic complexity ${f.cc} (budget ${CC_BUDGET}). Extract / flatten.` })
        if (f.maxDepth > NEST_BUDGET) out.push({ tag: "shrink", msg: `${where}: nesting depth ${f.maxDepth} (budget ${NEST_BUDGET}). Early-return / extract.` })
        if (f.params > PARAM_BUDGET) out.push({ tag: "yagni", msg: `${where}: ${f.params} params (budget ${PARAM_BUDGET}). Pass an options object.` })
      },
    }
    const visitors: Record<string, unknown> = {}
    for (const t of FN) visitors[t] = fnHooks
    for (const t of BRANCH) visitors[t] = () => stack.length && stack[stack.length - 1]!.cc++
    visitors.BlockStatement = {
      enter: () => {
        depth++
        if (stack.length) {
          const f = stack[stack.length - 1]!
          f.maxDepth = Math.max(f.maxDepth, depth - f.startDepth)
        }
      },
      leave: () => depth--,
    }
    m.walk(visitors as any)

    // write-flow smells (Reference.isWrite — tsc can't see these). A binding
    // written but never read is a dead write; an exported `let`/`var` that is
    // reassigned is shared mutable module state.
    for (const s of m.symbols) {
      if (s.has(SymbolFlags.Import) || s.has(SymbolFlags.Function) || s.has(SymbolFlags.Class)) continue
      let reads = 0
      let writes = 0
      for (const r of s.references) r.isWrite ? writes++ : reads++
      const line = s.declarations[0] ? lineOf(m, s.declarations[0]) : 0
      const mutableExport = s.has(SymbolFlags.Exported) && s.has(SymbolFlags.BlockScopedVariable) && !s.has(SymbolFlags.Const)
      if (mutableExport && writes >= 1)
        out.push({ tag: "mutate", msg: `${m.path}:${line} "${s.name}": exported mutable binding is reassigned. Export a const, or a getter — importers can't see the mutation.` })
      // dead write: only local (non-exported) variables — an exported binding may be read in another module.
      else if (!s.has(SymbolFlags.Exported) && s.has(SymbolFlags.Variable) && writes > 0 && reads === 0)
        out.push({ tag: "mutate", msg: `${m.path}:${line} "${s.name}": written but never read. Dead write — drop the assignment.` })
    }

    // closures that WRITE a shared module-level binding (capturesOf + isWritten).
    // Hidden coupling tsc is blind to: two call sites mutate the same outer state.
    for (const fn of m.findAll(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])) {
      for (const cap of m.capturesOf(fn)) {
        if (!cap.isWritten) continue
        const k = cap.symbol.scope.kind
        if (k !== "module" && k !== "global") continue
        out.push({ tag: "capture", msg: `${m.path}:${lineOf(m, fn)}: closure writes shared module binding "${cap.symbol.name}". Hidden coupling — thread the state through args/return instead.` })
      }
    }
  }

  // broken links: unresolvable / ambiguous imports & re-exports the linker found.
  // tsc reports these too, but surfacing them here keeps the one gate authoritative.
  for (const d of a.diagnostics) {
    if (d.severity !== "error" && d.severity !== "warning") continue
    out.push({ tag: "broken", msg: `${d.module}: ${d.message}` })
  }

  // circular dependencies (DFS over the resolved import graph).
  const edges = new Map<string, string[]>()
  for (const m of a.modules.values()) {
    edges.set(m.path, m.imports.map((i) => i.resolvedModule?.path).filter((p): p is string => Boolean(p)))
  }
  const seen = new Set<string>()
  const path: string[] = []
  const onPath = new Set<string>()
  const reported = new Set<string>()
  const dfs = (node: string) => {
    seen.add(node)
    path.push(node)
    onPath.add(node)
    for (const next of edges.get(node) ?? []) {
      if (onPath.has(next)) {
        const cycle = [...path.slice(path.indexOf(next)), next]
        const key = [...cycle].sort().join("|")
        if (!reported.has(key)) {
          reported.add(key)
          out.push({ tag: "cycle", msg: `circular import: ${cycle.join(" → ")}. Break the cycle.` })
        }
      } else if (!seen.has(next)) dfs(next)
    }
    path.pop()
    onPath.delete(node)
  }
  for (const node of edges.keys()) if (!seen.has(node)) dfs(node)

  // nested closures make capturesOf report the same shared-write from several
  // enclosing functions; dedup on the exact message.
  const uniq = new Set<string>()
  return out.filter((f) => !uniq.has(f.msg) && uniq.add(f.msg))
}

// Dependencies that are real but never statically imported (loaded by a peer /
// side effect). Without this allow-list they'd false-positive as unused.
const RUNTIME_ONLY = new Set(["@opentelemetry/sdk-trace-node", "@opentelemetry/resources"])

export const unusedDeps = (imported: Set<string>, deps: string[], allow = RUNTIME_ONLY): Finding[] =>
  deps
    .filter((d) => !imported.has(d) && !allow.has(d))
    .map((d) => ({ tag: "delete" as const, msg: `package.json: dependency "${d}" is never imported. Remove it.` }))

// Files a finding refers to (multiple for cycles). Cross-file analysis needs the
// WHOLE tree, but as a pre-commit gate we only BLOCK on findings in files the
// committer actually staged — so one agent's WIP can't fail another's commit.
export const findingFiles = (msg: string): string[] => msg.match(/(?:src|scripts)\/[^\s:→]+|package\.json/g) ?? []

const stagedSet = (): Set<string> => {
  const r = Bun.spawnSync(["git", "diff", "--cached", "--name-only"])
  if (!r.success) return new Set()
  return new Set(r.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean))
}

if (import.meta.main) {
  const staged = process.argv.includes("--staged")
  const files: { path: string; source: string }[] = []
  for await (const p of new Bun.Glob("src/**/*.{ts,tsx}").scan(".")) files.push({ path: p, source: await Bun.file(p).text() })
  const a = buildAnalyzer(files)
  const pkg = await Bun.file("package.json").json()
  const out = [...analyze(a), ...unusedDeps(importedRoots(a), Object.keys(pkg.dependencies ?? {}))]

  // In --staged mode, a finding blocks only if it touches a staged file.
  const stage = staged ? stagedSet() : null
  const blocks = (f: Finding) => !stage || findingFiles(f.msg).some((p) => stage.has(p))

  if (out.length === 0) {
    console.log("design-check: lean. ✓")
    process.exit(0)
  }
  const order = { broken: 0, delete: 1, native: 2, cycle: 3, shrink: 4, yagni: 5, mutate: 6, capture: 7 }
  const blocking = out.filter(blocks)
  for (const f of out.sort((x, y) => order[x.tag] - order[y.tag])) {
    const tag = stage && !blocks(f) ? `${f.tag}*` : f.tag // * = other file, not blocking this commit
    console.error(`  ${tag}: ${f.msg}`)
  }
  console.error(`\ndesign-check: ${out.length} finding(s)${stage ? `, ${blocking.length} in staged files` : ""}.`)
  process.exit(blocking.length > 0 ? 1 : 0)
}
