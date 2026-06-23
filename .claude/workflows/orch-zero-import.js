export const meta = {
  name: 'orch-zero-import',
  description: 'Make ax2 dynamic orch scripts zero-runtime-import (ultracode-workflow parity): inject a gen() factory into the OrchPrims toolkit so a .ax/orch script composes purely from injected prims/ctx and never imports @ax-llm/ax. Update example.ts + the agent BASE_PROMPT note. Self-heal to tsc-green + adversarial review, commit.',
  whenToUse: 'Trigger AFTER orch-wrap (dyn-load + prove) has landed. Closes the one import leak: example.ts still `import { ax }` to build gens; inject gen into prims so dynamic scripts are as import-free as an ultracode workflow.',
  phases: [
    { title: 'Scout',     detail: 'pin OrchPrims definition + where prims are assembled + the example script + BASE_PROMPT note' },
    { title: 'gen-inject', detail: 'add gen() to OrchPrims, wire it at the prims build site, drop the ax import in example.ts, update prompt note' },
    { title: 'Report',    detail: 'status, is the dynamic script now import-free, residual' },
  ],
}

const CHECK = 'bun run check'
const MAX_HEAL = 4
const MAX_HARDEN = 2

const SPEC = `
ax2 orchestration dyn-load is on main: a TUI '/run <name>' loads a TRUSTED script from .ax/orch/ via runtime import() (src/orch-load.ts),
calling its exported orchestrate(ctx, prims). prims (OrchPrims) currently = { leaf, parallel, pipeline, emit, allocate } + recipes
{ agent, judge, loopUntilDry, adversarialVerify }. ctx (OrchLoadCtx) = { message, rootId, ai, budget, onEvent, optsFor, usageOf }.
RE-CONFIRM exact shapes/sites at Scout — do not hardcode from this spec.

GOAL: an ultracode workflow script needs ZERO imports — its primitives are ambient. ax2 dynamic orch scripts are almost there
(prims are injected) EXCEPT .ax/orch/example.ts still does \`import { ax } from "@ax-llm/ax"\` to BUILD generators (personas). Close that.

CHANGE:
1) Add a gen factory to OrchPrims in src/orch-load.ts:  gen: (signature: string, description?: string) => AxGen   — it wraps
   ax(signature) + (description ? setDescription(description) : noop) and returns the AxGen, so a script can build leaves without
   importing the library. Type it with the real AxGen type from @ax-llm/ax.
2) Wire gen into the prims object at the SINGLE site where OrchPrims is assembled (find it at Scout — likely in orch-load.ts where
   loadAndRunOrch builds the toolkit, or wherever prims is constructed). Keep all existing prims unchanged.
3) Update .ax/orch/example.ts: remove \`import { ax } from "@ax-llm/ax"\` (the runtime leak); build the persona gens via prims.gen(...).
   KEEP \`import type { OrchLoadCtx, OrchPrims }\` and type the export — \`export const orchestrate: OrchScriptFn = async (ctx, prims) => …\`
   (import OrchScriptFn as type-only too). This is compile-time only (erased at runtime → still ZERO runtime import) and is what gives
   an author FULL editor autocomplete on ctx/prims/gen. The script must still run + render the same parallel persona fan-out.
4) EDITOR AUTOCOMPLETE: tsconfig currently has include ["src/**/*.ts","src/**/*.tsx"] — \`.ax\` is NOT included, so tsserver can't
   resolve types in .ax/orch scripts. Make autocomplete work WITHOUT pulling .ax into the main \`bun run check\` typecheck of src:
   prefer a SCOPED \`.ax/orch/tsconfig.json\` that extends the root and includes ./**/*.ts (so editors resolve OrchLoadCtx/OrchPrims/
   gen there) — do NOT add .ax to the root include if that would make \`bun run check\` start type-checking example scripts and break
   green. Confirm \`bun run check\` stays green and that the scoped config resolves the relative import to ../../src/orch-load.ts.
5) Update the agent BASE_PROMPT note in src/agent.ts: the prims list now includes gen; state that a dynamic orch script needs NO
   runtime import — compose purely from the injected prims/ctx (gen() builds leaves); keep the type-only import for editor autocomplete.
   Keep it terse.

PRINCIPLES: core stays EXACTLY 5 primitives in orch.ts (gen is a TOOLKIT convenience in OrchPrims, NOT a 6th core primitive — it just
wraps ax()). Match style. Real @ax-llm/ax types. Unavoidable any => 'ponytail:' + 'Upgrade:'. GREEN GATE = ${CHECK} clean. Commit
--no-verify, conventional message.
`

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'importLeakClosed', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string' }, checkOutput: { type: 'string' }, committed: { type: 'boolean' }, commitSha: { type: 'string' },
    importLeakClosed: { type: 'boolean', description: 'true iff .ax/orch/example.ts no longer imports @ax-llm/ax at runtime' },
    newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

phase('Scout')
const SCOUT_SCHEMA = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const scout = (await parallel([
  () => agent(`Read src/orch-load.ts in full. Report verbatim: the OrchPrims type definition (every field), the OrchLoadCtx type, and the EXACT site + code where the prims object is assembled/handed to a loaded script's orchestrate(). gen() will be added to OrchPrims and wired here. Cite file:line.\n\n${SPEC}`,
    { label: 'orch-load', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read .ax/orch/example.ts and the BASE_PROMPT block in src/agent.ts. Report: how example.ts currently imports ax + builds persona gens (verbatim), and the current orchestration note in BASE_PROMPT (the prims list). Cite file:line. Also confirm how ax() + setDescription are used elsewhere (src/agent.ts chat def) so gen() mirrors it.\n\n${SPEC}`,
    { label: 'example-prompt', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
])).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/2`)

phase('gen-inject')
let impl = await agent(
  `Implement the zero-runtime-import change in the ax2 main working tree per the spec. Use the scouted facts for exact sites.\n\n${SPEC}\n\nCONTRACTS:\n${CONTRACTS}\n\nRules: ${CHECK} MUST end green. Self-heal up to ${MAX_HEAL}. When green, COMMIT (--no-verify) 'feat(orch): gen() prim — zero-runtime-import dynamic scripts'. Report sha/diff/check tail, importLeakClosed (true iff example.ts no longer imports @ax-llm/ax at runtime), new ponytails.`,
  { label: 'gen-inject', phase: 'gen-inject', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
let heal = 0
while (impl && impl.status !== 'green' && heal < MAX_HEAL) {
  heal++; log(`heal ${heal}`)
  impl = await agent(`Change left ${CHECK} RED. Fix + re-run to green, commit --no-verify.\nFAILING:\n${impl.checkOutput}\n\n${SPEC}`,
    { label: `heal:${heal}`, phase: 'gen-inject', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
}
const LENSES = [
  { k: 'import-free', focus: `Does .ax/orch/example.ts truly no longer import @ax-llm/ax at RUNTIME (import type is OK, erased)? Does prims.gen() build a working AxGen mirroring the chat def (ax + setDescription)? Does the example still run the same parallel persona fan-out with fork-mem per branch? Cite file:line.` },
  { k: 'core-purity', focus: `Is gen a TOOLKIT field in OrchPrims, NOT a 6th core primitive in orch.ts (core must stay exactly 5)? Any unmarked any/ponytail, new dead export, or behavior change to the fixed ^o path? Is the BASE_PROMPT note accurate (gen listed, "no runtime import" stated)? Cite file:line.` },
]
let reviews = (await parallel(LENSES.map(l => () =>
  agent(`Adversarially review the committed change. Skeptical. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\n\n${SPEC}`,
    { label: `review:${l.k}`, phase: 'gen-inject', schema: REVIEW_SCHEMA, agentType: 'Explore' })
))).filter(Boolean)
let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
log(`${blockers.length} blockers`)
let hr = 0
while (impl && blockers.length > 0 && hr < MAX_HARDEN) {
  hr++; log(`harden ${hr}`)
  impl = await agent(`BLOCKERS. Fix, ${CHECK} green, AMEND commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
    { label: `harden:${hr}`, phase: 'gen-inject', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  const rr = (await parallel(LENSES.map(l => () =>
    agent(`Re-review for your lens; blockers closed, no new ones? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\n\n${SPEC}`,
      { label: `reverify:${l.k}:${hr}`, phase: 'gen-inject', schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Cover: (1) is the dynamic orch script now ZERO-runtime-import (example.ts imports only type, or nothing)? show the new persona-build line via prims.gen. (2) commit sha + check status. (3) confirm core stayed 5 prims (gen is toolkit, not core). (4) residual (ponytails, the import type line if kept). (5) one line: are ax2 dynamic scripts now as import-free as an ultracode workflow? Headline anything red.\n\nRESULT:\n${JSON.stringify(impl, null, 1)}\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, importLeakClosed: impl ? impl.importLeakClosed : false, openBlockers: blockers, report }
