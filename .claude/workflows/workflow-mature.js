export const meta = {
  name: 'workflow-mature',
  description: 'MATURE the ax2 ultracode workflow tool: (1) LESS HARDCODED AGENTS — kill the PERSONAS round-robin, the STRATEGIES enum, the EXACTLY-two model registry; agents fully script-defined via agent(prompt,{system,tools,model,effort,sig}). (2) PROPER STRUCTURED GEN — expose ax typed signatures in the agent()/node()/rlm() prims so a script can ask for typed output (q -> n:number, ok:boolean, items:string[], obj:json) and get a VALIDATED typed object, not just string->string. (3) LOOP + BUDGET logic — budget{total,spent,remaining} usable in scripts for loop-until-budget / loop-until-dry / loop-until-count growing/continuing runs. (4) DENSE JS GUIDANCE — rewrite the agent.ts ORCH overlay as a packed JS spec (API + patterns + 3-4 example scripts) so weak CF-Kimi authors GOOD scripts. (5) worktree isolation for parallel write-nodes. DEPENDS ON the workflow({script}) tool (workflow-tool.js) having landed — edits the SAME files, run AFTER it. Sequential, LIVE-verified on CF-Kimi authoring typed+looping scripts, self-heal + adversarial review, commit each.',
  phases: [
    { title: 'Study',   detail: 'confirm workflow({script}) landed (HARD dep — STOP if not); read the prim bindings, agent()/node()/rlm()/judge signatures, models.ts registry, the PERSONAS/STRATEGIES, the ORCH overlay; read ../ax/src for AxSignature typed-field syntax (number/boolean/json/class/arrays) + how runNode<I,O> threads a typed gen' },
    { title: 'structured-gen', detail: 'agent()/node()/judge()/rlm() prims accept an optional ax signature OR schema -> build a TYPED AxGen (not string->string) -> return the validated typed object; keep string default. typed numeric/bool/array/json fields work' },
    { title: 'dynamic-agents', detail: 'kill PERSONAS round-robin + STRATEGIES enum + the "exactly two" model gate; agent(prompt,{system,tools,model,effort,sig}) is fully script-defined; model registry becomes an OPEN map (add a model by config, not by editing a 2-entry literal); strategies are just JS the script writes' },
    { title: 'budget-loops', detail: 'expose budget{total,spent,remaining} to scripts + verify loop-until-budget / loop-until-dry / loop-until-count GROW + CONTINUE correctly (accumulate across iterations, advisory soft never discards, HARD stops); a numeric typed field can drive a loop' },
    { title: 'dense-guidance', detail: 'rewrite the agent.ts ORCH overlay as a DENSE JS spec: the full prim API + quirks (parallel barrier/null-on-throw, pipeline no-barrier, schema typed return, budget loops) + 3-4 REAL example scripts (fan-out+judge, pipeline, loop-until-budget accumulate, rlm() blob-mine, typed-schema extract). The weak-model enabler' },
    { title: 'meta-phases', detail: 'the script declares meta = {name, description, phases:[{title,detail}]} like the assistant Workflow tool; the tool parses meta + emits the phases as a RENDER SKELETON upfront (anchors), and phase() calls match meta.phases so nodes nest under the right phase group — the TUI has a structure to render, not a flat node dump' },
    { title: 'yuku-validate', detail: 'PRE-VALIDATE the model-authored script statically before running (yuku-analyzer = ax2 backbone; inline script -> temp file + yuku scan, plus a parse/Function-construct gate) -> a malformed Kimi script fails fast with a clear error, never a runtime crash mid-fan-out' },
    { title: 'tui-render', detail: 'OrchTree/NodeView renders the meta.phases as anchors: phase groups shown upfront, nodes nest live under their phase (like the assistant /workflows tree). Pure-presentational over the node-event bus; frame-gated if the tui-test-harness has landed' },
    { title: 'worktree', detail: 'isolation for parallel WRITE nodes: an agent({isolation:"worktree"}) (or an auto-detect for file-mutating nodes) runs the node in a fresh git worktree so parallel writes do not collide in one tree; merge/collect after; cleanup if unchanged' },
    { title: 'verify',  detail: 'LIVE on CF-Kimi: Kimi authors (a) a TYPED script (sig with :number/:boolean/array) returning a validated object; (b) a loop-until-budget script that accumulates results across iterations; (c) a script with a fully script-defined agent (custom system, no persona menu). Paste scripts + outputs. NOT compile-only' },
    { title: 'Report',  detail: 'is it more mature + less hardcoded vs the assistant Workflow tool now? typed gen, dynamic agents, budget loops, dense guidance, worktree — live proof per item; residual gaps' },
  ],
}

const CHECK = 'bun run check'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const DENSE = `
DENSE JS GUIDANCE the ORCH overlay must teach CF-Kimi (mirror the assistant Workflow tool's density). The model writes a script BODY:
- phase(title) / log(msg). agent(prompt, {label?, system?, tools?, model?, effort?, sig?, schema?}) -> string, OR a validated typed object if sig/schema.
  sig is an ax signature: 'question:string -> answer:string, score:number, passed:boolean, tags:string[]' — typed fields come back typed.
- parallel(thunks[]) -> results[]  // BARRIER, await all, a throwing thunk -> null, so .filter(Boolean).
- pipeline(items, stage1, stage2, ...) -> results[]  // NO barrier; stage(prev,item,i); a throwing stage drops that item to null.
- judge(candidates[], criteria?) -> winner. rlm(bigBlobString, query, opts?) -> string  // mine a HUGE blob out-of-prompt in the code runtime.
- budget {total:number|null, spent():number, remaining():number}. args. return <value> = what the tool returns to the model.
PATTERNS (teach these as runnable example scripts):
  // loop-until-budget (GROW + CONTINUE):
  const found=[]; while (budget.total && budget.remaining()>50000){ const r=await agent('find one more bug', {sig:'_->bug:string, done:boolean'}); if(r.done) break; found.push(r.bug); } return found.join('\\n');
  // loop-until-dry:
  let dry=0, all=[]; while(dry<2){ const r=await parallel(FINDERS.map(f=>()=>agent(f))); const fresh=r.filter(Boolean).filter(x=>!all.includes(x)); if(!fresh.length){dry++;continue} dry=0; all.push(...fresh); }
  // fan-out + judge: phase('fan'); const c=await parallel([()=>agent('A'),()=>agent('B'),()=>agent('C')]); return await judge(c.filter(Boolean));
  // adversarial verify: const v=await parallel(Array.from({length:3},()=>()=>agent('refute: '+claim,{sig:'_->refuted:boolean'}))); const ok=v.filter(Boolean).filter(x=>!x.refuted).length>=2;
  // typed extract: const e=await agent('extract', {sig:'text:string -> name:string, age:number, emails:string[]'}); // e.age is a number.
  // rlm node: return await rlm(HUGE_LOG, 'which line throws the 500?');
QUIRKS: parallel = barrier + null-on-throw; pipeline = no barrier; sig/schema => typed+validated (ax retries on mismatch); budget advisory (soft nudges, HARD stops); ONE LEVEL (agent/rlm nodes carry file/shell tools only, cannot author a sub-script).`

const SPEC = `
ax2 = opentui TUI agent on @ax-llm/ax (CF Kimi K2.7 default + GLM 5.2). The workflow({script}) ULTRACODE tool just landed (workflow-tool.js):
the model AUTHORS a JS script using in-process prims (phase/log/agent/parallel/pipeline/judge/rlm/budget/args). RLM is one prim (node kind).

THIS PASS = make it MORE MATURE + LESS HARDCODED, matching/exceeding the assistant Workflow tool. The user named 4 gaps + worktree:
1. LESS HARDCODED AGENTS. Today rlm-workflow.ts has: const PERSONAS=[...] used round-robin (persona: PERSONAS[i % len]); a STRATEGIES enum
   ['parallel','judge','verify','best_of_n','plan','rlm']; models.ts MODELS = "EXACTLY two entries" (kimi/glm) with type ModelName='kimi'|'glm'.
   MATURE: agents are fully SCRIPT-DEFINED — agent(prompt, {system, tools, model, effort, sig}) — no persona menu (the script passes the system/
   role), no strategy enum (a strategy is just JS the script writes — loops/conditionals), model registry is an OPEN map (add a model via config,
   not by editing a 2-entry literal + a union type). Keep kimi default. Remove dead PERSONAS/STRATEGIES if the script tool obsoletes them.
2. PROPER STRUCTURED GEN. ax is structured-native (AxSignature 'in -> out' with TYPED fields: string/number/boolean/json/class/arrays). But every
   node today is ax('message:string -> reply:string') — string in/out; judge/skeptic too. runNode is generic <I,O extends AxGenOut> so the plumbing
   supports typed. MATURE: agent()/node()/judge()/rlm() accept an optional ax signature (sig) OR a JSON schema -> build a TYPED AxGen -> return the
   VALIDATED typed object (numbers as numbers, booleans, arrays, json). Default stays string when no sig. Read ../ax/src for the typed-field syntax.
3. LOOP + BUDGET logic. budget {total,spent,remaining} must be usable inside a script for loop-until-budget (while remaining>N: accumulate),
   loop-until-dry (K empty rounds), loop-until-count (until n found). Advisory soft NEVER discards a completed node; only HARD stops. A typed
   :number field from a gen can drive a loop. GROW + CONTINUE across iterations (accumulate, don't reset).
4. DENSE JS GUIDANCE. The agent.ts ORCH overlay must become a DENSE JS spec (see DENSE block) — full API + quirks + 3-4 REAL example scripts —
   so weak CF-Kimi authors CORRECT, non-trivial scripts (the require-in-RLM class of bug is what thin guidance causes). This is make-or-break.
5. WORKTREE ISOLATION. ax2 nodes write files unsandboxed; parallel([write A, write B]) COLLIDES in one tree. Add agent({isolation:'worktree'})
   (or auto for file-mutating nodes): run that node in a fresh git worktree, collect/merge after, cleanup if unchanged. Mirror the assistant's
   isolation:'worktree'. This is the assistant's one structural advantage ax2 lacks.

KEEP: core 5 prims in orch.ts (no new core prim); one-level guard (agent/rlm nodes = file/shell leaves, no workflow tool); budget advisory soft +
HARD ceiling; abort threading; trace nesting under chat.turn (one trace/session); ONE WORD vocab 'node'. Real ax API only (read ../ax/src). Run
in-process like the assistant Workflow tool (in-process eval <= the bash tool already exposed; the single ponytail). ${CHECK} + bun run lint green.

VERIFY (LIVE, real CF-Kimi, NOT compile-only): Kimi AUTHORS + the tool RUNS:
  (a) TYPED: a script with sig 'text:string -> name:string, age:number, emails:string[]' returns an object whose .age is a real number, .emails a real array.
  (b) BUDGET LOOP: a while(budget.remaining()>N){ accumulate } script that grows results across >=2 iterations and stops on the budget line.
  (c) DYNAMIC AGENT: a script defining an agent with a CUSTOM system + tools (no persona-menu), runs, returns.
  (d) (worktree) a parallel of 2 write-nodes that each create a file WITHOUT colliding.
Paste the authored scripts + outputs. Prove typed values are typed (not stringified), the loop iterated, the worktree isolated.

PRINCIPLES: shortest mature diff; delete the hardcoded menus the script obsoletes; unavoidable any => 'ponytail:'. Commit each --no-verify with
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT git add -A. Re-confirm all line refs at Study (concurrent churn).
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'depLanded'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } }, depLanded: { type: 'boolean' } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'liveVerified', 'liveOutput', 'authoredScript', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, liveVerified: { type: 'boolean' }, liveOutput: { type: 'string' }, authoredScript: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' }, checkOutput: { type: 'string' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' }, newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

phase('Study')
const study = (await parallel([
  () => agent(`HARD DEP CHECK + map. Confirm the workflow({script}) tool LANDED (a workflow tool in CHAT_TOOLS that runs a model-authored JS script with prims phase/log/agent/parallel/pipeline/judge/rlm/budget). If NOT, set depLanded=false (this workflow must STOP). Then read the prim bindings + agent()/node()/judge()/rlm() signatures, src/models.ts (the 2-entry registry + ModelName union), src/rlm-workflow.ts PERSONAS/STRATEGIES, the agent.ts ORCH overlay. Report exactly what to de-hardcode + where. Cite file:line.\n\n${SPEC}`,
    { label: 'dep+map', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Read ../ax/src for AxSignature TYPED-FIELD syntax: how to write 'in:string -> name:string, age:number, ok:boolean, tags:string[], obj:json' and how AxGen returns those typed (number as number etc), how runNode<I,O extends AxGenOut> threads a typed gen + how validation/retry works. Report the EXACT syntax + the binding to expose sig/schema in the agent() prim. Cite file:line.\n\n${SPEC}`,
    { label: 'ax-typed-sig', phase: 'Study', schema: FIND, agentType: 'Explore' }),
])).filter(Boolean)
const depLanded = study.some(s => s && s.depLanded)
if (!depLanded) {
  log('DEP NOT LANDED: workflow({script}) tool absent — STOP. Run workflow-tool.js first.')
  return { stopped: true, reason: 'workflow({script}) tool not present; this maturity pass depends on it' }
}
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/2; dep landed`)

const FEATURES = [
  { key: 'structured-gen', live: true, spec: `Expose ax TYPED signatures in the prims: agent()/node()/judge()/rlm() accept an optional sig (ax signature string) OR schema -> build a TYPED AxGen -> return the VALIDATED typed object; default stays string when omitted. Numbers/booleans/arrays/json come back typed. LIVE: a hardcoded test script sig 'text:string -> name:string, age:number, emails:string[]' returns an object whose age is typeof 'number' + emails is an array (assert + paste). tsc+lint green. commit.` },
  { key: 'dynamic-agents', live: true, spec: `De-hardcode agents: remove PERSONAS round-robin + the STRATEGIES enum gate (a strategy is JS the script writes) + the "exactly two" model gate (MODELS becomes an OPEN map keyed by string, add-by-config; keep kimi default; ModelName -> string). agent(prompt,{system,tools,model,effort,sig}) fully script-defined; delete now-dead PERSONAS/STRATEGIES/nodeWorker menu code the script tool obsoletes (ponytail-audit it). LIVE: a script defining an agent with a CUSTOM system + a chosen model runs + returns; a 3rd model can be added via config without editing a union. tsc+lint+debt green. commit.` },
  { key: 'budget-loops', live: true, spec: `Ensure budget{total,spent,remaining} is exposed to scripts + loop patterns work: loop-until-budget (while remaining>N accumulate), loop-until-dry (K empty rounds), loop-until-count. Advisory soft never discards a completed node; HARD stops. A typed :number field can drive a loop. LIVE: a Kimi-style script that does while(budget.remaining()>N){ acc.push(await agent(...,{sig:'_->item:string,done:boolean'})) } GROWS acc across >=2 iterations + stops on budget; paste the loop output showing multiple iterations. tsc+lint green. commit.` },
  { key: 'dense-guidance', live: true, spec: `Rewrite the agent.ts ORCH overlay as a DENSE JS spec — the full prim API + quirks (parallel barrier/null-on-throw, pipeline no-barrier, sig typed return, budget loops, one-level) + 3-4 REAL example scripts (fan-out+judge, pipeline, loop-until-budget accumulate, typed-schema extract, rlm() blob-mine). Use the DENSE block as the basis. LIVE: with the new overlay, CF-Kimi is asked a real task, AUTHORS a non-trivial script (a loop or a typed sig or a parallel+judge) that RUNS + returns a real result — paste the model-authored script + output (proves the guidance makes the weak model author correctly). tsc+lint green. commit.` },
  { key: 'meta-phases', live: true, spec: `Add a meta+phases contract to the workflow script (mirror the assistant Workflow tool): the model's script may declare meta = {name, description, phases:[{title,detail}]} at the top; the workflow tool PARSES it (pull meta off the evaluated module/body) and emits the phases as a RENDER SKELETON upfront (a node-event per phase anchor), and phase(title) calls match meta.phases (same title => same group). If meta is absent, infer phases from phase() calls (graceful). LIVE: a Kimi-authored script WITH a meta.phases block runs; the node events show the phase anchors emitted upfront + nodes grouped under the right phase; paste the event/render trace. tsc+lint green. commit.` },
  { key: 'yuku-validate', live: true, spec: `PRE-VALIDATE the model-authored script statically BEFORE running it: a parse/Function-construct gate (syntax) PLUS a yuku-analyzer pass (write the script to a temp .ts wrapped with the prim types, run the yuku/design-check analyzer on it) -> structural errors (undefined prim use, dead code, malformed) are returned to the model as a CLEAR error so it can fix + retry, NEVER a runtime crash mid-fan-out. Keep it fast (a syntax gate always; yuku scan as the deeper check). LIVE: feed a DELIBERATELY broken script (syntax error / undefined prim) -> the tool returns a clear validation error, does NOT execute; then a valid script passes + runs. Paste both. tsc+lint green. commit.` },
  { key: 'tui-render', live: false, spec: `OrchTree/NodeView (chat.tsx) renders the meta.phases as ANCHORS: the phase groups appear upfront (skeleton), nodes nest live under their phase (like the assistant /workflows tree), not a flat dump. Pure-presentational over the existing node-event bus (OrchNode/OrchTree reducer) — Msg shape unchanged. If the tui-test-harness (scripts/tui/driver.ts + test:tui) has landed, ADD a frame test asserting the phase-anchored tree; else assert via the reducer + a unit. tsc+lint(+test:tui if present) green. commit. NOTE: chat.tsx may be concurrently edited by the tui harness/upgrade — rebase/re-confirm before editing.` },
  { key: 'worktree', live: true, spec: `Add worktree isolation for parallel WRITE nodes: agent({isolation:'worktree'}) runs that node in a fresh git worktree (git worktree add a temp), the node's file writes happen there, collect/merge results after, remove the worktree if unchanged. Mirror the assistant isolation:'worktree'. LIVE: a script parallel([ agent('create fileA',{isolation:'worktree'}), agent('create fileB',{isolation:'worktree'}) ]) where both write WITHOUT colliding; paste proof both files made it. ponytail any cleanup edge. tsc+lint green. commit.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 working tree, grounded in the study (real ax + ax2 signatures — no invented calls). Make it MORE MATURE + LESS HARDCODED than the assistant Workflow tool.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + bun run lint green. THEN run the LIVE proof (real CF-Kimi) — set liveVerified + paste liveOutput + authoredScript. Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(workflow): ${f.key} ...'. Report sha/diff/check tail/liveVerified/liveOutput/authoredScript/new ponytails. Do NOT git add -A.\n\nDENSE:\n${DENSE}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint/live). Fix + re-verify (real CF-Kimi + paste authoredScript), commit --no-verify.\nFAILING:\n${impl.checkOutput}\nLIVE:\n${impl.liveOutput}\n\nDENSE:\n${DENSE}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'mature', focus: `Is it genuinely MORE MATURE + LESS HARDCODED — PERSONAS/STRATEGIES/2-model-gate gone, agents script-defined, typed sig real (number is a number in live output), budget loops grow across iterations? Quote the Kimi-authored script + typed/looped output. Reject compile-only, reject a leftover hardcoded menu. Cite file:line.` },
    { k: 'safe-core', focus: `core still 5 prims (no 6th)? one-level guard intact (agent/rlm nodes = file/shell leaves)? budget advisory soft + HARD? worktree isolation actually isolates (no collision) + cleans up? the single in-process ponytail correct? no over-build (no sandbox ceremony the user rejected)? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Demand a Kimi-authored script + typed/looped live proof. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nLIVE:\n${impl ? impl.liveOutput : ''}\nSCRIPT:\n${impl ? impl.authoredScript : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: live=${impl ? impl.liveVerified : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real, re-verify (live Kimi-authored script), AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${DENSE}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + live still a real Kimi script with typed/looped proof? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, liveVerified: impl ? impl.liveVerified : false, liveOutput: impl ? (impl.liveOutput || '').slice(0, 400) : '', script: impl ? (impl.authoredScript || '').slice(0, 400) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Per item, with LIVE proof: (1) less hardcoded — PERSONAS/STRATEGIES/2-model-gate gone, agents script-defined? (2) proper structured gen — typed sig returns real numbers/arrays (quote)? (3) budget loops grow+continue across iterations (quote)? (4) dense guidance makes Kimi author a correct non-trivial script (quote it)? (5) worktree isolates parallel writes? Then: is ax2 now MORE MATURE than the assistant Workflow tool? remaining gaps. Headline anything red or compile-only.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
