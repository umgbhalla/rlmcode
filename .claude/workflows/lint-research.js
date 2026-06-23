export const meta = {
  name: 'lint-research',
  description: 'Research-first pass for the rlmcode lint/quality rework. (1) Web-research modern lint-rule + Effect-v4 convention guidance (biome / oxlint / eslint / Rust-clippy rule philosophies, @effect/eslint-plugin, @effect/language-service diagnostics, Effect docs). (2) Extract lint/quality/Effect conventions from the 85 cloned Effect-v4 repos + local effect-smol/effect-solutions/executor (.research/clones, READ-ONLY). (3) Synthesize a learnings doc + a concrete proposal for rlmcode: a richer type/check gate, DYNAMIC complexity/size budgets keyed on role+fan+churn+density, mutable-state/Effect-driven rules, a ponytail-subagent-on-lint step, and the test-rewrite-on-bump policy. Writes ONLY to .research/ (gitignored). Does NOT touch src/ or AGENTS.md — that is the build phase after the proposal is approved.',
  phases: [
    { title: 'Discover', detail: 'list the corpus: .research/clones/* + local effect-smol/effect-solutions/executor/opencode' },
    { title: 'Web', detail: 'parallel web-research: lint-rule philosophies + Effect-TS lint/convention guidance + clippy/oxlint/biome rule design' },
    { title: 'Extract', detail: 'one cheap agent per repo — mine tsconfig/eslint/@effect-plugin/language-service config, file-size norms, mutable-state + service/layer patterns, test design, stated conventions' },
    { title: 'Synthesize', detail: 'aggregate corpus + web → .research/lint-learnings.md + .research/lint-proposal.md; return the proposal summary' },
  ],
}

const CORPUS = { type: 'object', additionalProperties: false, required: ['paths'], properties: { paths: { type: 'array', items: { type: 'string' } } } }
const WEB = { type: 'object', additionalProperties: false, required: ['topic', 'findings', 'sources'],
  properties: { topic: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } } } }
const REPO = { type: 'object', additionalProperties: false,
  required: ['repo', 'tsconfig', 'lintTooling', 'lintScripts', 'fileSizeNorm', 'mutableState', 'servicePattern', 'testPattern', 'conventions', 'authority'],
  properties: {
    repo: { type: 'string' },
    tsconfig: { type: 'array', items: { type: 'string' }, description: 'strict flags + the @effect/language-service plugin options (which Effect diagnostics enabled)' },
    lintTooling: { type: 'array', items: { type: 'string' }, description: 'eslint + @effect/eslint-plugin rules / biome / oxlint / prettier — what + key rules' },
    lintScripts: { type: 'array', items: { type: 'string' }, description: 'package.json lint/check/typecheck/test commands' },
    fileSizeNorm: { type: 'string', description: 'largest + typical source file size; any explicit size cap; barrel/module structure' },
    mutableState: { type: 'string', description: 'Ref/SubscriptionRef/SynchronizedRef vs raw let/mutable — how shared state is handled (Effect-driven?)' },
    servicePattern: { type: 'string', description: 'Context.Tag / Effect.Service / Layer conventions' },
    testPattern: { type: 'string', description: '@effect/vitest, it.effect, layer-based deps, mock vs real, do they mock external/AI?' },
    conventions: { type: 'array', items: { type: 'string' }, description: 'distinctive quality conventions; quote any AGENTS.md/CLAUDE.md/CONTRIBUTING rules' },
    authority: { type: 'string', description: 'signal weight: Effect core team (tim-smart/mikearnaldi/Effect-TS) / known author / hobby / repro' },
  } }
const PROPOSAL = { type: 'object', additionalProperties: false,
  required: ['learningsWritten', 'proposalWritten', 'summary', 'typeGate', 'dynamicBudgets', 'effectRules', 'ponytailSubagent', 'testPolicy', 'openQuestions'],
  properties: {
    learningsWritten: { type: 'boolean' }, proposalWritten: { type: 'boolean' },
    summary: { type: 'string' },
    typeGate: { type: 'array', items: { type: 'string' }, description: 'concrete additions to the type/check gate beyond tsc strict (Effect-LS rules, eslint/oxlint rules, function-behavior checks)' },
    dynamicBudgets: { type: 'string', description: 'the proposed dynamic complexity/size rubric keyed on role + import/export fan + git churn + complexity density' },
    effectRules: { type: 'array', items: { type: 'string' }, description: 'mutable-state ban + Effect-driven rules to enforce, grounded in what the corpus actually does' },
    ponytailSubagent: { type: 'string', description: 'how the ponytail-audit sub-agent plugs into the lint run' },
    testPolicy: { type: 'string', description: 'the test-rewrite-on-bump + mock-first policy wording for AGENTS.md' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  } }

const ROOT = '/Users/umang/hub/ax2'
const CTX = `Goal: rework the rlmcode lint/quality system to be SMARTER (the user wants "think like the Rust compiler"). Today's gate (bun run lint = tsc strict + a yuku design-check with FIXED budgets CC=20/nest=8/size=300|500 + a ponytail debt-marker grep + a hermetic test suite). The user wants: (a) the type/check gate expanded well past tsc strict; (b) the design-check budgets DYNAMIC — scale on file ROLE + import/export FAN + git CHURN/growth + complexity DENSITY, not fixed magic numbers; (c) mutable state treated as bad → push Effect-driven design (rlmcode core is Effect v4 / effect-smol); (d) when lint runs, ALSO spawn a ponytail-audit sub-agent for deeper debt detection; (e) an AGENTS.md policy that a version bump = delete + rewrite ALL tests end-to-end (tests are assumed to rot across a bump; mock-first, avoid flaky AI-provider integration tests). Ground every recommendation in what REAL Effect-v4 codebases + modern linters actually do.`

phase('Discover')
const disc = await agent(
  `List the research corpus as absolute paths. Run: ls -1d ${ROOT}/.research/clones/*/ (85 Effect-v4 repo clones, dirs named owner__repo). PLUS add any of these local high-signal repos that exist: /Users/umang/hub/effect-smol (Effect v4 CORE source — the reference for v4 idioms), /Users/umang/hub/effect-solutions (kitlangton Effect patterns), /Users/umang/hub/executor, /Users/umang/hub/opencode (TS/Bun TUI+agent reference, may not be Effect — note it). Return every repo path in paths[].`,
  { label: 'discover', phase: 'Discover', schema: CORPUS, agentType: 'Explore' })
const repos = (disc && disc.paths || []).filter(Boolean)
log(`corpus: ${repos.length} repos`)

phase('Web')
const WEB_TOPICS = [
  'Effect-TS official lint + code conventions: the @effect/eslint-plugin rule set (every rule + what it enforces) and the @effect/language-service diagnostics (what Effect anti-patterns it catches). Cite docs/source.',
  'How Effect-TS handles mutable state vs Ref/SubscriptionRef/SynchronizedRef, and the Effect.Service / Context.Tag / Layer conventions a v4 codebase should follow. Cite the Effect docs / effect-smol source.',
  'Modern TS linter rule PHILOSOPHY: oxlint and Biome rule categories (correctness/suspicious/complexity/style), what they deny-by-default, and how they differ from eslint. What rules matter for correctness vs noise.',
  'Rust clippy + the Rust compiler lint design: deny-by-default vs warn, lint levels/groups, how rustc reasons about ownership/mutation — the mindset to port to a TS quality gate ("think like the Rust compiler").',
  'Dynamic / adaptive code-complexity & file-size limits: cognitive complexity vs cyclomatic, complexity DENSITY (per-export, per-responsibility), churn-based hotspots, and fan-in/fan-out coupling metrics as quality signals. Cite the research/tools.',
  'TypeScript strictness beyond tsc strict: useful tsconfig flags (noUncheckedIndexedAccess, noImplicitReturns, exactOptionalPropertyTypes, noFallthroughCasesInSwitch) + type-aware eslint rules that catch real bugs. Cite.',
]
const web = (await parallel(WEB_TOPICS.map((t, i) => () =>
  agent(`Web-research this for the rlmcode lint rework. Use WebSearch + WebFetch. Be concrete — name rules/flags/tools, quote what each enforces, give source URLs.\n\nTOPIC: ${t}\n\n${CTX}`,
    { label: `web:${i}`, phase: 'Web', schema: WEB, agentType: 'Explore' })
))).filter(Boolean)
log(`web research: ${web.length} topics`)

phase('Extract')
const extracts = (await parallel(repos.map((p) => () =>
  agent(`READ-ONLY mine the lint/quality/Effect conventions of ONE repo: ${p}\n\nRead its tsconfig(s), any eslint config (.eslintrc*/eslint.config.*) + @effect/eslint-plugin usage, biome.json / .oxlintrc*, prettier config, package.json scripts (lint/check/typecheck/test), and any AGENTS.md/CLAUDE.md/CONTRIBUTING. Sample a few source files for: file SIZE norms (run a quick wc -l over src), how MUTABLE STATE is handled (grep for Ref/SubscriptionRef/SynchronizedRef vs raw mutable let), the SERVICE/LAYER pattern (Context.Tag/Effect.Service/Layer), and TEST design (@effect/vitest, it.effect, layer deps, mock vs real). Fill the schema. Be terse + factual; if a field is absent say "none". Set authority by who owns it (Effect core team = tim-smart/mikearnaldi/Effect-TS/kitlangton = high).\n\n${CTX}`,
    { label: `x:${p.split('/').pop() || p}`, phase: 'Extract', schema: REPO, agentType: 'Explore', effort: 'low' })
))).filter(Boolean)
log(`extracted ${extracts.length}/${repos.length} repos`)

phase('Synthesize')
const synth = await agent(
  `Synthesize a learnings doc + a concrete proposal for the rlmcode lint rework. You have ${extracts.length} per-repo extractions from real Effect-v4 codebases + ${web.length} web-research briefs. WEIGHT by authority (Effect core team conventions > hobby repos). Find the COMMON conventions + the NOTABLE/best ones.\n\nWrite TWO files:\n1. ${ROOT}/.research/lint-learnings.md — the evidence: what Effect-v4 codebases + modern linters actually enforce (tsconfig flags, @effect/eslint-plugin + language-service rules, mutable-state handling, service/layer + test conventions, file-size reality, complexity/churn metrics). Cite repos + URLs.\n2. ${ROOT}/.research/lint-proposal.md — the concrete rlmcode plan: (a) the expanded type/check gate (specific Effect-LS rules + tsconfig flags + type-aware lint rules to add); (b) the DYNAMIC budget rubric — a precise formula/algorithm keyed on file ROLE + import/export FAN + git CHURN + complexity DENSITY (give the actual scaling, not hand-waving); (c) mutable-state ban + Effect-driven rules; (d) the ponytail-audit sub-agent step in the lint flow; (e) the test-rewrite-on-bump + mock-first AGENTS.md policy wording. Each recommendation cites its grounding.\n\nFill the schema (summary + the per-area highlights + open questions for the user). This is a PROPOSAL for human review — do NOT edit src/ or AGENTS.md.\n\nWEB:\n${JSON.stringify(web).slice(0, 9000)}\n\nEXTRACTS:\n${JSON.stringify(extracts).slice(0, 60000)}\n\n${CTX}`,
  { label: 'synthesize', phase: 'Synthesize', schema: PROPOSAL, agentType: 'general-purpose', effort: 'high' })
return { proposal: synth, corpus: repos.length, extracted: extracts.length, web: web.length }
