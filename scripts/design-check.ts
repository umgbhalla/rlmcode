#!/usr/bin/env bun
// Real semantic design analysis on yuku-analyzer (not comment-grep). One
// cross-file pass over src/, reporting design smells that tsc doesn't:
//   broken:  unresolvable / ambiguous import or re-export (link diagnostic)
//   delete:  dead export / unused import / unused dependency / UNREACHABLE module
//   native:  a dependency that duplicates a platform/runtime native
//   cycle:   import cycle between modules
//   shrink:  cyclomatic complexity / nesting depth over budget
//   yagni:   too many parameters
//   mutate:  exported mutable binding reassigned / local written but never read
//   capture: closure writes a shared module-level binding
//
// Dead code is REACHABILITY-based, not a per-symbol reference count: the run
// pulls the test/example/script consumers into the graph and marks live
// everything reachable from the real entrypoints (package.json "exports" + the
// app entry). A module no root reaches is dead — which a refcount misses for a
// mutually-referencing dead CLUSTER (each side keeps the other's count > 0).
//
// Core logic is exported (buildAnalyzer/analyze/unusedDeps) so scripts/
// design-check.test.ts can assert it on fixtures — ponytail: non-trivial
// logic leaves a runnable check.
//
// COORDINATION (oxlint): yuku owns semantic/architecture smells on src/ ONLY
// (crosscore, reachability, CC/nest/params, mutate/capture write-flow). oxlint
// (scripts/oxlint-check.ts) owns syntax/correctness/perf on src + scripts +
// examples. Overlap on unused imports is aligned; neither gate prescribes fixes
// the other rejects — see scripts/lint-coordination.test.ts.
import { parseArgs } from "node:util"
import { Analyzer, SymbolFlags } from "yuku-analyzer"

export type Finding = { tag: "broken" | "crosscore" | "delete" | "native" | "cycle" | "shrink" | "yagni" | "mutate" | "capture"; msg: string }

// CROSS-CORE BOUNDARY: src/core/* is the engine; its ONLY public seam is the core barrel
// (package.json "exports" "." points there — derived at run time, see coreBarrelFromPkg). A file
// OUTSIDE the trusted layers below that deep-imports any core module other than the barrel has
// reached past the SDK seam — flagged. Trusted layers (may import core internals): src/core/ itself,
// and src/app/ (the app composition layer that wires the default agent over a concrete AxAIService).
// Pure presentation (src/tui/*) and any external consumer must go through the barrel.
const CORE_DIR = "src/core/"
const DEFAULT_CORE_BARREL = "src/core/sdk.ts"
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

// Runtime entrypoints that are NOT expressible in package.json "exports": the TUI app boots by
// `bun src/tui/chat.tsx`, so it (and what it imports) is reachable even though it is not a library
// export. Everything else that must stay live is reached either from here or from a real consumer
// (tests/examples) now that those are in the graph — so there is no hand-maintained keep-alive list.
const APP_ENTRYPOINTS = ["src/tui/chat.tsx"]
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
const OVERSIZED_ALLOWLIST = new Set(["src/tui/chat.tsx"])

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

// Branch-node kinds = the cyclomatic-complexity proxy. Exported as the SINGLE
// source of truth: debt-audit.ts imports it for its blunt per-file branch count.
export const BRANCH = new Set([
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

export const buildAnalyzer = (files: Array<{ path: string; source: string }>): Analyzer => {
  const a = new Analyzer()
  for (const f of files) a.addFile(f.path, f.source)
  a.link()
  return a
}

// Package roots imported by modules the predicate accepts (default: every module). The run
// narrows this to src/ so a dependency used ONLY by tests/scripts still reads as unused-in-prod.
export const importedRoots = (a: Analyzer, isLinted: (path: string) => boolean = () => true): Set<string> => {
  const roots = new Set<string>()
  for (const m of a.modules.values()) {
    if (!isLinted(m.path)) continue
    for (const imp of m.imports) {
      const root = pkgRoot(imp.specifier)
      if (root) roots.add(root)
    }
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

// Options for a real run. Defaults keep the function pure + fixture-friendly: with no roots the
// reachability pass is OFF and every module is linted, so the unit tests drive analyze() exactly
// as before.
export type AnalyzeOptions = {
  // Public/entry module paths whose exports are the API surface (never "dead"); also the seeds of
  // the reachability sweep. Empty → reachability pass disabled (fixture mode).
  roots?: Set<string>
  // Which modules to actually LINT (per-file smells + dead-export). Non-linted modules
  // (tests/examples/scripts) still populate the reference + import graph. Default: lint everything.
  isLinted?: (path: string) => boolean
  // The core public barrel for the cross-core boundary. Default src/core/sdk.ts.
  coreBarrel?: string
}

export const analyze = (a: Analyzer, opts: AnalyzeOptions = {}): Array<Finding> => {
  const roots = opts.roots ?? new Set<string>()
  const isLinted = opts.isLinted ?? (() => true)
  const coreBarrel = opts.coreBarrel ?? DEFAULT_CORE_BARREL
  const out: Array<Finding> = []
  for (const m of a.modules.values()) {
    if (!isLinted(m.path)) continue // consumers (tests/examples) inform the graph but are not linted
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
    // dead exports (cross-file). Skip roots (their exports are the public surface) + type-only
    // (referencesOf undercounts type uses). A reference from a consumer (test/example) counts, so
    // a seam used only by tests is live without a hand-maintained keep-alive entry.
    if (!roots.has(m.path)) {
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
      // the barrel has gone past the public seam. (type-only imports count too — even a type
      // dependency on a core internal couples the consumer to the engine's private shapes.)
      if (!isTrustedCoreImporter(m.path)) {
        const target = resolveCoreTarget(m.path, imp.specifier, imp.resolvedModule?.path)
        if (target !== null && target !== coreBarrel)
          out.push({ tag: "crosscore", msg: `${m.path}: deep import of core module "${target}" (via "${imp.specifier}"). Cross-core deep import — go through the ${coreBarrel} barrel.` })
      }
      if (imp.isSideEffect || imp.typeOnly || !imp.local) continue
      if (imp.local.references.length === 0) out.push({ tag: "delete", msg: `${m.path}: unused import "${imp.local.name}". Remove it.` })
    }
    // per-function complexity, nesting, param count (AST walk + function stack).
    const stack: Array<{ name: string; line: number; cc: number; params: number; startDepth: number; maxDepth: number }> = []
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
    // reassigned is shared mutable module state; and in src/core/ ANY reassigned
    // module-scope `let`/`var` (exported or not) is the mutable-state anti-pattern
    // (the engine is Effect DI + immutable data — use Ref/SubscriptionRef for genuine
    // reactivity, or `const`). Loop-local `let` inside a function body is exempt
    // (its scope is `function`/`block`, not `module`), and never an exported-export
    // false positive (an exported binding may be read in another module).
    const inCore = m.path.startsWith(CORE_DIR)
    for (const s of m.symbols) {
      if (s.has(SymbolFlags.Import) || s.has(SymbolFlags.Function) || s.has(SymbolFlags.Class)) continue
      let reads = 0
      let writes = 0
      for (const r of s.references) if (r.isWrite) writes++
      else reads++
      const line = s.declarations[0] ? lineOf(m, s.declarations[0]) : 0
      const mutableBinding = s.has(SymbolFlags.BlockScopedVariable) && !s.has(SymbolFlags.Const)
      const mutableExport = s.has(SymbolFlags.Exported) && mutableBinding
      // src/core/ module-scope mutable binding (any, not only exported). `scope.kind === "module"`
      // excludes loop-local / function-body `let`. Exported ones ARE hidden (importers can't see
      // the mutation); even local ones should use Ref for reactivity or be `const`.
      const coreModuleMutable = inCore && !s.has(SymbolFlags.Exported) && mutableBinding && s.scope.kind === "module"
      if (mutableExport && writes >= 1)
        out.push({ tag: "mutate", msg: `${m.path}:${line} "${s.name}": exported mutable binding is reassigned. Export a const, or a getter — importers can't see the mutation.` })
      else if (coreModuleMutable && writes >= 1)
        out.push({ tag: "mutate", msg: `${m.path}:${line} "${s.name}": module-scope mutable binding in core is reassigned. Core is immutable-data + Effect DI — use Ref/SubscriptionRef for reactivity, or make it const.` })
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
    if (!isLinted(d.module)) continue // a consumer (test/example) seeds the graph but its own link errors are out of scope
    out.push({ tag: "broken", msg: `${d.module}: ${d.message}` })
  }

  // resolved import edges among LINTED modules (drives both reachability and cycles).
  const edges = new Map<string, Array<string>>()
  for (const m of a.modules.values()) {
    if (!isLinted(m.path)) continue
    edges.set(m.path, m.imports.map((i) => i.resolvedModule?.path).filter((p): p is string => Boolean(p) && isLinted(p!)))
  }

  // UNREACHABLE modules (dead files / dead clusters). Reachability replaces a hand-maintained
  // keep-alive allowlist: seed from the real roots PLUS any linted module a consumer (test/example/
  // script) imports, then sweep the import graph. A linted module no seed reaches is dead — caught
  // even when it is part of a mutually-referencing cluster a per-symbol refcount would keep alive.
  if (roots.size > 0) {
    const seeds = new Set<string>(roots)
    for (const m of a.modules.values()) {
      if (isLinted(m.path)) continue
      for (const imp of m.imports) {
        const p = imp.resolvedModule?.path
        if (p && isLinted(p)) seeds.add(p)
      }
    }
    const reached = new Set<string>()
    const stack = [...seeds]
    while (stack.length) {
      const n = stack.pop()!
      if (reached.has(n)) continue
      reached.add(n)
      for (const d of edges.get(n) ?? []) if (!reached.has(d)) stack.push(d)
    }
    for (const path of edges.keys())
      if (!reached.has(path)) out.push({ tag: "delete", msg: `${path}: module unreachable from any entrypoint — dead file. Drop it or wire it in.` })
  }

  // circular dependencies (DFS over the resolved import graph).
  const seen = new Set<string>()
  const path: Array<string> = []
  const onPath = new Set<string>()
  const reported = new Set<string>()
  const dfs = (node: string) => {
    seen.add(node)
    path.push(node)
    onPath.add(node)
    for (const next of edges.get(node) ?? []) {
      if (onPath.has(next)) {
        const cycle = [...path.slice(path.indexOf(next)), next]
        const key = [...cycle].toSorted().join("|")
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

export const unusedDeps = (imported: Set<string>, deps: Array<string>, allow = RUNTIME_ONLY): Array<Finding> =>
  deps
    .filter((d) => !imported.has(d) && !allow.has(d))
    .map((d) => ({ tag: "delete" as const, msg: `package.json: dependency "${d}" is never imported. Remove it.` }))

// Files a finding refers to (multiple for cycles). Cross-file analysis needs the
// WHOLE tree, but as a pre-commit gate we only BLOCK on findings in files the
// committer actually staged — so one agent's WIP can't fail another's commit.
export const findingFiles = (msg: string): Array<string> => msg.match(/(?:src|scripts)\/[^\s:→]+|package\.json/g) ?? []

// The library public barrel, read from package.json "exports" "." (falls back to the default).
// Keeps the cross-core seam from drifting away from what the package actually publishes.
export const coreBarrelFromPkg = (pkg: any): string => {
  const dot = pkg?.exports?.["."]
  const target = typeof dot === "string" ? dot : typeof dot?.import === "string" ? dot.import : typeof dot?.default === "string" ? dot.default : null
  return target ? target.replace(/^\.\//, "") : DEFAULT_CORE_BARREL
}

const isLintedPath = (p: string): boolean => p.startsWith("src/")

const stagedSet = (): Set<string> => {
  const r = Bun.spawnSync(["git", "diff", "--cached", "--name-only"])
  if (!r.success) return new Set()
  return new Set(r.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean))
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { staged: { type: "boolean", default: false } }, strict: false })
  const staged = values.staged === true
  const isLinted = isLintedPath
  // src/ is LINTED; scripts/ + examples/ are CONSUMERS — they join the reference + import graph so
  // a seam used only by a test/example reads as live, but they are not themselves linted.
  const files: Array<{ path: string; source: string }> = []
  for (const glob of ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}", "examples/**/*.{ts,tsx}"])
    for await (const p of new Bun.Glob(glob).scan(".")) files.push({ path: p, source: await Bun.file(p).text() })
  const a = buildAnalyzer(files)
  const pkg = await Bun.file("package.json").json()
  // roots = the published library surface (package.json "exports") + runtime entrypoints.
  const coreBarrel = coreBarrelFromPkg(pkg)
  const roots = new Set<string>([coreBarrel, ...APP_ENTRYPOINTS].filter((p) => a.modules.has(p)))
  const out = [
    ...analyze(a, { roots, isLinted, coreBarrel }),
    ...unusedDeps(importedRoots(a, isLinted), Object.keys(pkg.dependencies ?? {})),
  ]

  // In --staged mode, a finding blocks only if it touches a staged file.
  const stage = staged ? stagedSet() : null
  const blocks = (f: Finding) => !stage || findingFiles(f.msg).some((p) => stage.has(p))

  if (out.length === 0) {
    console.log("design-check: lean. ✓")
    process.exit(0)
  }
  const order = { broken: 0, crosscore: 1, delete: 2, native: 3, cycle: 4, shrink: 5, yagni: 6, mutate: 7, capture: 8 }
  const blocking = out.filter(blocks)
  for (const f of out.toSorted((x, y) => order[x.tag] - order[y.tag])) {
    const tag = stage && !blocks(f) ? `${f.tag}*` : f.tag // * = other file, not blocking this commit
    console.error(`  ${tag}: ${f.msg}`)
  }
  console.error(`\ndesign-check: ${out.length} finding(s)${stage ? `, ${blocking.length} in staged files` : ""}.`)
  process.exit(blocking.length > 0 ? 1 : 0)
}
