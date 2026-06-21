#!/usr/bin/env bun
// Real semantic design analysis on yuku-analyzer (not comment-grep). One
// cross-file pass over src/, reporting design smells that tsc doesn't:
//   delete: dead export      — exported symbol referenced nowhere (cross-file)
//   delete: unused import     — imported binding never used
//   cycle:  circular dep      — import cycle between modules
//   shrink: complex function  — cyclomatic complexity over budget
//   shrink: deep nesting      — block nesting depth over budget
//   yagni:  long param list   — too many parameters
import { Analyzer, SymbolFlags } from "yuku-analyzer"

const ENTRY = new Set(["src/chat.tsx"]) // exports here are reachability roots
const CC_BUDGET = 18 // cyclomatic complexity per function
const NEST_BUDGET = 5 // block nesting depth per function
const PARAM_BUDGET = 6 // parameters per function

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

const a = new Analyzer()
for await (const p of new Bun.Glob("src/**/*.{ts,tsx}").scan(".")) a.addFile(p, await Bun.file(p).text())
a.link()

type Finding = { tag: "delete" | "cycle" | "shrink" | "yagni"; msg: string }
const out: Finding[] = []

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

for (const m of a.modules.values()) {
  // 1. dead exports (cross-file). Skip entry roots + type-only (referencesOf undercounts type uses).
  if (!ENTRY.has(m.path)) {
    for (const s of m.symbols) {
      if (!s.has(SymbolFlags.Exported)) continue
      if (s.has(SymbolFlags.TypeSpace) && !s.has(SymbolFlags.ValueSpace)) continue
      if (a.referencesOf(s).length === 0) out.push({ tag: "delete", msg: `${m.path}: dead export "${s.name}". Referenced nowhere — drop it.` })
    }
  }

  // 2. unused imports (value bindings with zero uses; type-only/side-effect excluded).
  for (const imp of m.imports) {
    if (imp.isSideEffect || imp.typeOnly || !imp.local) continue
    if (imp.local.references.length === 0) out.push({ tag: "delete", msg: `${m.path}: unused import "${imp.local.name}". Remove it.` })
  }

  // 3. per-function complexity, nesting, param count (real AST walk + function stack).
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
}

// 4. circular dependencies (DFS over the resolved import graph).
{
  const edges = new Map<string, string[]>()
  for (const m of a.modules.values()) {
    edges.set(
      m.path,
      m.imports.map((i) => i.resolvedModule?.path).filter((p): p is string => Boolean(p)),
    )
  }
  const seen = new Set<string>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const reported = new Set<string>()
  const dfs = (node: string) => {
    seen.add(node)
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      if (onStack.has(next)) {
        const cycle = [...stack.slice(stack.indexOf(next)), next]
        const key = [...cycle].sort().join("|")
        if (!reported.has(key)) {
          reported.add(key)
          out.push({ tag: "cycle", msg: `circular import: ${cycle.join(" → ")}. Break the cycle.` })
        }
      } else if (!seen.has(next)) dfs(next)
    }
    stack.pop()
    onStack.delete(node)
  }
  for (const node of edges.keys()) if (!seen.has(node)) dfs(node)
}

if (out.length === 0) {
  console.log("design-check: lean. ✓")
  process.exit(0)
}
const order = { delete: 0, cycle: 1, shrink: 2, yagni: 3 }
for (const f of out.sort((x, y) => order[x.tag] - order[y.tag])) console.error(`  ${f.tag}: ${f.msg}`)
console.error(`\ndesign-check: ${out.length} finding(s).`)
process.exit(1)
