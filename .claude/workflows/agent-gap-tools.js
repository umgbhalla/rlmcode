export const meta = {
  name: 'agent-gap-tools',
  description: 'Bring ax2 agent tool set to parity with a full coding agent (ex-MCP): add web_search, skill (load .ax/skills), todo (task tracking), ask_user (interactive prompt), plan (present+approve a plan), and schedule (in-session future-run, durable-cron deferred). Each is an AxFunction added to the file-tools set (NOT the orchestration-leaf set). Sequential on main, self-heal to tsc-green + 2-lens adversarial review, commit each.',
  whenToUse: 'Trigger AFTER agent-self-orchestrate lands (it splits BASE_TOOLS/ORCH_TOOLS in tools.ts). Adds the remaining parity tools. Each feature is independent; budget-gated so it can stop partway and resume.',
  phases: [
    { title: 'Scout',        detail: 'pin tools.ts AxFunction shape + BASE_TOOLS/ORCH_TOOLS split, extra fields, activity bus + atoms input bridge, .ax dirs' },
    { title: 'info-tools',   detail: 'web_search (DuckDuckGo HTML, no key) + skill (load .ax/skills/*.md)' },
    { title: 'todo',         detail: 'task-tracking tool (add/list/complete) persisted + rendered in TUI' },
    { title: 'interactive',  detail: 'ask_user + plan — pause turn, prompt the TUI user, resume with the answer' },
    { title: 'schedule',     detail: 'in-session scheduler (run an orch/turn after a delay); durable cron = ponytail/Upgrade' },
    { title: 'Report',       detail: 'which gaps closed, parity status, residual' },
  ],
}

const CHECK = 'bun run check'
const MAX_HEAL = 4
const MAX_HARDEN = 2

const SPEC = `
ax2 = Bun+TS TUI coding agent on @ax-llm/ax. Tools live in src/tools.ts as AxFunction[] (name/description/parameters/func; handler gets
an \`extra\` = { sessionId, ai, step, abortSignal, ... }). After agent-self-orchestrate, tools.ts is split: BASE_TOOLS (file tools:
bash/read_file/write_file/edit_file/glob/grep/web_fetch) and ORCH_TOOLS (orchestrate/run_orch_script); the main chat gen (src/agent.ts)
gets BASE_TOOLS+ORCH_TOOLS, orchestration LEAVES get BASE_TOOLS only. RE-CONFIRM exact names/lines/split at Scout — do not hardcode.

GOAL: add the remaining parity tools (ex-MCP). Each NEW tool joins BASE_TOOLS (so leaves get them too) UNLESS noted. The TUI is opentui
(src/chat.tsx) over an activity bus (src/activity.ts emitActivity/setActivitySink) + atoms (src/atoms.ts); the input box already feeds
turns. ask_user/plan/schedule need a bridge from a running tool back to the UI — design it on the EXISTING activity bus + an input/
resolver atom, do NOT invent a parallel system.

PRINCIPLES: core stays EXACTLY 5 prims in orch.ts (these are TOOLS, not prims). Match style. Real @ax-llm/ax types. Each new export
consumed (added to the tools array). Unavoidable any or bounded shortcut => 'ponytail:' + 'Upgrade:'. GREEN GATE = ${CHECK} clean.
Commit each feature --no-verify, conventional message. Keep handlers small + return a concise string result to the model.
`

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'toolsAdded', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' },
    checkOutput: { type: 'string' }, committed: { type: 'boolean' }, commitSha: { type: 'string' },
    toolsAdded: { type: 'array', items: { type: 'string' } }, newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
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
  () => agent(`Read src/tools.ts fully (post self-orchestrate). Report verbatim: the AxFunction shape, the BASE_TOOLS / ORCH_TOOLS split (exact arrays + where defined), the existing web_fetch handler (template for web_search), the \`extra\` fields, and how an AxFunctionError is thrown for bad args. New tools mostly join BASE_TOOLS. Cite file:line.\n\n${SPEC}`,
    { label: 'tools', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read src/activity.ts, src/atoms.ts, src/chat.tsx (input handling + submit + useKeyboard). Report: the activity bus (emitActivity/Activity union/setActivitySink), how the input box dispatches turns, and the cleanest way for a RUNNING tool handler to (a) ask the user a question and AWAIT their typed answer, and (b) present a plan and await approve/edit. Identify an existing promise/resolver or atom we can use to bridge tool->UI->tool. ask_user/plan/schedule depend on this. Cite file:line.\n\n${SPEC}`,
    { label: 'ui-bridge', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
  () => agent(`Report: (a) does a .ax/skills dir exist or should it be created — and the skill format (markdown with frontmatter like .claude skills); how a 'skill' tool would list + load a skill's text into the turn (return it as the tool result). (b) For 'schedule': how the running app's event loop could host an in-session timer (a setInterval/Effect schedule) that fires a turn or orchestration after a delay, and what durable cross-session scheduling would require (note as Upgrade). Cite file:line where relevant (chat.tsx app lifecycle, atoms appRuntime).\n\n${SPEC}`,
    { label: 'skills-sched', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
])).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/3`)

const FEATURES = [
  { key: 'info-tools', title: 'info-tools',
    spec: `Add two AxFunctions to BASE_TOOLS. (1) web_search { query:string, max?:number }: fetch DuckDuckGo HTML endpoint (https://html.duckduckgo.com/html/?q=...) or lite endpoint, parse result titles+urls+snippets (no API key), return a concise ranked list string (cap ~max, default 5). Reuse the web_fetch handler's fetch+error pattern. (2) skill { name?:string }: with no name, list available skills (read .ax/skills/*.md base-names — create the dir + a tiny example skill if absent); with a name, return that skill's markdown text so the model can follow it. Both join BASE_TOOLS. tsc green.` },
  { key: 'todo', title: 'todo',
    spec: `Add a task-tracking tool 'todo' { action:'add'|'list'|'done'|'clear', text?:string, id?:string } to BASE_TOOLS. Persist per-session (an atom in atoms.ts, or .ax/todo.json keyed by sessionId — prefer in-memory atom for a TUI session, with a ponytail/Upgrade for durable file persistence). Render the current todo list somewhere visible in the TUI (a small panel or a status hint in chat.tsx) so the user sees the agent's plan. Returns the updated list as a string to the model. tsc green; do not regress transcript/tree rendering.` },
  { key: 'interactive', title: 'interactive',
    spec: `Add ask_user and plan to ORCH_TOOLS-or-BASE (your call, but they must work in a normal turn). Using the UI bridge from scout: (1) ask_user { question:string, options?:string[] }: the handler emits a prompt to the TUI, the input box switches to answering mode, and the handler AWAITS the user's typed/selected answer (a promise resolved by the input submit handler), returning it as the tool result. (2) plan { steps:string[], summary?:string }: present the plan in the TUI and await an approve / edit / reject response (reuse the ask_user bridge); return the user's decision (+edits) to the model so it proceeds only on approval. Must not deadlock: thread extra.abortSignal so a cancelled turn rejects the pending prompt. tsc green; the normal non-interactive turn path unchanged.` },
  { key: 'schedule', title: 'schedule',
    spec: `Add a 'schedule' tool { afterMs?:number, atIso?:string, action:'turn'|'orchestrate', message:string } to BASE_TOOLS. IN-SESSION scope: register a timer on the running app's runtime (Effect schedule / setTimeout owned by appRuntime) that, when due AND the app is still running, dispatches the given turn or orchestration for the active session (render normally). List/cancel scheduled jobs via the same tool ('list'/'cancel'). Persist the registry in an atom. ponytail: in-session only — a closed app drops the schedule; Upgrade: durable cross-session cron via an external runner / OS scheduler reading .ax/schedule.json. tsc green; timers cleaned up on session/app close (Effect.ensuring / clearTimeout) so nothing leaks.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 70000) { log(`budget low — stop before ${f.key} (resume later)`); break }
  phase(f.title)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} MUST end green. Self-heal up to ${MAX_HEAL}. Mark shortcuts 'ponytail:' + 'Upgrade:'. When green, COMMIT alone (--no-verify) 'feat(tools): ${f.key} ...'. Report sha/diff/check tail, toolsAdded, new ponytails.\n\nCONTRACTS:\n${CONTRACTS}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" left ${CHECK} RED. Fix + re-run green, commit --no-verify.\nFAILING:\n${impl.checkOutput}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'correctness', focus: `Does "${f.key}" actually work — real handler logic (web_search parses real results; ask_user/plan truly await + resolve via the UI bridge without deadlock; schedule timer fires + is cancelable + leak-free)? Returns a concise string to the model? Cite file:line.` },
    { k: 'purity-safety', focus: `Joined the right tool set (BASE vs ORCH)? Core still 5 prims? No unmarked any/ponytail, no new dead export? For ask_user/plan: abortSignal threaded so a cancelled turn doesn't hang? For schedule: timers cleaned on close (no leak)? Non-interactive + single-turn + ^o paths unchanged? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Skeptical. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: ${blockers.length} blockers`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix, ${CHECK} green, AMEND commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}" for your lens; blockers closed, no new ones? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, toolsAdded: impl ? impl.toolsAdded : [], openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Cover: (1) which gap tools landed green (web_search/skill/todo/ask_user/plan/schedule), any failed/partial. (2) PARITY — with self-orchestrate's orchestrate/run_orch_script already in, does ax2 now match a full coding-agent tool set (ex-MCP)? what's still missing. (3) the interactive bridge — does ask_user/plan genuinely pause+resume without deadlock? (4) schedule scope (in-session only) + its Upgrade. (5) residual ponytails. (6) one line: is ax2 now tool-equivalent to the assistant. Headline anything red.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
