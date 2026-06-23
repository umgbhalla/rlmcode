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

export type Finding = { tag: "broken" | "crosscore" | "delete" | "native" | "cycle" | "shrink" | "yagni" | "mutate" | "capture"; msg: string }

// CROSS-CORE BOUNDARY: src/core/* is the engine; its ONLY public seam is the src/core/sdk.ts
// barrel (package.json "exports" points there). A file OUTSIDE the trusted layers below that
// deep-imports any core module other than the barrel has reached past the SDK seam — flagged.
// Trusted layers (may import core internals): src/core/ itself, and src/app/ (the app composition
// layer that wires the default agent over a concrete AxAIService). Pure presentation (src/tui/*)
// and any external consumer must go through src/core/sdk.ts.
const CORE_DIR = "src/core/"
const CORE_BARREL = "src/core/sdk.ts"
const isTrustedCoreImporter = (path: string): boolean => path.startsWith(CORE_DIR) || path.startsWith("src/app/")

// Resolve an import specifier to a src/-relative module path (for the crosscore check). Prefer the
// linker's resolvedModule; fall back to normalizing a relative specifier against the importer dir
// so the rule still fires on a deep import the linker couldn't fully resolve.
const resolveCoreTarget = (importerPath: string, specifier: string, resolved?: string): string | null => {
  if (resolved && resolved.startsWith(CORE_DIR)) return resolved
  if (!specifier.startsWith(".")) return null
  const dir = importerPath.split("/").slice(0, -1)
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue
    if (part === "..") dir.pop()
    else dir.push(part)
  }
  const p = dir.join("/")
  return p.startsWith(CORE_DIR) ? p : null
}

// Reachability roots: their exports are public API / entrypoints, not dead.
// chat.tsx = app entry; orch.ts = orchestration-core library surface; orch-recipes.ts
// = userland recipe surface (runNode() by turn(); judge/loopUntilDry/adversarialVerify
// by orch-run.orchestrate()) — kept a root so the recipe library surface isn't pruned
// to only its current callers.
// sdk.ts = the public SDK re-export seam (the external entrypoint, consumed by
// examples/sdk-usage.ts, outside the src/-only scan) — a root so its public-API
// re-exports aren't flagged dead.
// src/mock.ts + src/mock-ai.ts = the NARROW test-only mock seam (the deterministic AI +
// canned node feed). Consumed by scripts/tui/*.test.ts and the agent.ts AX2_MOCK runtime
// swap — the tests OUTSIDE the src/-only scan — so they're roots, like sdk.ts, lest their
// seam surface (MOCK_NODES / makeMockAI / MOCK_FIXTURE) be pruned to its in-src callers.
// src/tui/ui/* = the lifted termcast UI atoms (Spinner / Row / useEvent / useAnimationTick) —
// a presentation foundation landed AHEAD of its chat.tsx wiring and exercised by the frame
// gate fixture scripts/tui/ui-atoms-demo.tsx (mounted by ui-atoms.test.ts, OUTSIDE the
// src/-only scan). Roots like sdk.ts/mock.ts so the atom surface isn't pruned to its (empty,
// pending integration) in-src callers before the sequential chat.tsx re-skin consumes it.
const ENTRY = new Set(["src/tui/chat.tsx", "src/core/orch.ts", "src/core/orch-recipes.ts", "src/core/sdk.ts", "src/core/run.ts", "src/core/mock.ts", "src/core/mock-ai.ts", "src/tui/ui/spinner.tsx", "src/tui/ui/row.tsx", "src/tui/ui/hooks.tsx", "src/tui/ui/animation-tick.tsx"])
const CC_BUDGET = 20 // cyclomatic complexity per function (UI render fns with several display states idiomatically reach ~19; >20 = real tangle)
const NEST_BUDGET = 8 // block nesting depth per function
const PARAM_BUDGET = 6 // parameters per function
// File-size budget is CONDITIONED on the file's role: a top-level INDEX/barrel
// (a public re-export surface — index.ts / sdk.ts, mostly `export … from`) must stay
// TIGHT (300) so the public API surface can't sprawl; an internal implementation file
// gets the looser 500. A barrel doing real work or an impl file masquerading as an index
// both trip the wrong budget — which is the signal.
const INDEX_LINE_BUDGET = 300 // barrel / public-index file (mostly re-exports)
const LINE_BUDGET = 500 // internal implementation file

// A file is a BARREL (public index surface) if it is named index.ts/sdk.ts OR it only
// re-exports (`export … from`) with no local value export of its own. Type-only barrels count.
const isBarrel = (path: string, source: string): boolean =>
  /(^|\/)(index|sdk)\.ts$/.test(path) ||
  (/^export\s+(\*|type\s+\*|type\s+\{|\{)[^]*?\bfrom\b/m.test(source) &&
    !/^export\s+(const|function|async|class|enum|default)\b/m.test(source))

// Existing oversized files grandfathered in. New files must stay under LINE_BUDGET.
const OVERSIZED_ALLOWLIST = new Set(["src/tui/chat.tsx", "build-viz.ts"])

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
    // file-size budget: CONDITIONED on role — 300 for a public-index/barrel, 500 for an
    // internal impl file — with an allow-list for existing oversized files so the rule
    // only blocks new growth.
    if (!OVERSIZED_ALLOWLIST.has(m.path)) {
      const lines = countLines(m.source)
      const budget = isBarrel(m.path, m.source) ? INDEX_LINE_BUDGET : LINE_BUDGET
      if (lines > budget) {
        const role = budget === INDEX_LINE_BUDGET ? "index/barrel" : "impl"
        out.push({ tag: "shrink", msg: `${m.path}: ${lines} lines (${role} budget ${budget}). Split the file.` })
      }
    }
    // dead exports (cross-file). Skip entry roots + type-only (referencesOf undercounts type uses).
    if (!ENTRY.has(m.path)) {
      for (const s of m.symbols) {
        if (!s.has(SymbolFlags.Exported)) continue
        if (s.has(SymbolFlags.TypeSpace) && !s.has(SymbolFlags.ValueSpace)) continue
        if (a.referencesOf(s).length === 0) out.push({ tag: "delete", msg: `${m.path}: dead export "${s.name}". Referenced nowhere — drop it.` })
      }
    }
    // unused imports + native-duplicating dependencies + the cross-core boundary.
    for (const imp of m.imports) {
      const root = pkgRoot(imp.specifier)
      if (root && NATIVE_DUPES[root]) out.push({ tag: "native", msg: `${m.path}: "${root}" duplicates a native — use ${NATIVE_DUPES[root]}.` })
      // CROSS-CORE: an importer outside the trusted layers reaching into a core module other than
      // the sdk.ts barrel has gone past the public seam. (type-only imports count too — even a type
      // dependency on a core internal couples the consumer to the engine's private shapes.)
      if (!isTrustedCoreImporter(m.path)) {
        const target = resolveCoreTarget(m.path, imp.specifier, imp.resolvedModule?.path)
        if (target !== null && target !== CORE_BARREL)
          out.push({ tag: "crosscore", msg: `${m.path}: deep import of core module "${target}" (via "${imp.specifier}"). Cross-core deep import — go through the ${CORE_BARREL} barrel.` })
      }
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
  const order = { broken: 0, crosscore: 1, delete: 2, native: 3, cycle: 4, shrink: 5, yagni: 6, mutate: 7, capture: 8 }
  const blocking = out.filter(blocks)
  for (const f of out.sort((x, y) => order[x.tag] - order[y.tag])) {
    const tag = stage && !blocks(f) ? `${f.tag}*` : f.tag // * = other file, not blocking this commit
    console.error(`  ${tag}: ${f.msg}`)
  }
  console.error(`\ndesign-check: ${out.length} finding(s)${stage ? `, ${blocking.length} in staged files` : ""}.`)
  process.exit(blocking.length > 0 ? 1 : 0)
}
