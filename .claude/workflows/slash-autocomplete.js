export const meta = {
  name: 'slash-autocomplete',
  description: 'TUI slash-command autocomplete: a completion overlay under the input that suggests slash commands as you type `/` and, for a selected command, the value options for its param (e.g. `/run ` lists .ax/orch/*.ts script names). A small slash-command registry where each command supplies getOptions(). Keyboard-nav, Tab/Enter to fill. Pure TUI layer, no core change.',
  whenToUse: 'Trigger AFTER orch-zero-import lands. Adds editor-style completion for slash commands + their param values in the chat input.',
  phases: [
    { title: 'Scout',       detail: 'pin chat.tsx input handling, /run parse, keyboard model, opentui list/select elements, scripts-dir read' },
    { title: 'registry',    detail: 'slash-command registry { name, describe, getOptions(prefix) } incl /run -> .ax/orch script names' },
    { title: 'overlay',     detail: 'completion overlay UI under input: filter by prefix, keyboard nav, Tab/Enter fill, Esc dismiss' },
    { title: 'Report',      detail: 'status, what completes now, residual' },
  ],
}

const CHECK = 'bun run check'
const MAX_HEAL = 4
const MAX_HARDEN = 2

const SPEC = `
ax2 TUI (src/chat.tsx, opentui React). The input already handles slash commands: '/run <name> [message]' (parsed ~chat.tsx:449 via
runScriptAtom -> loadAndRunOrch, scripts live in .ax/orch/, dir const ORCH_SCRIPTS_DIR in src/orch-load.ts). IDLE_HINT lists triggers.
RE-CONFIRM exact lines/handlers/elements at Scout — do not hardcode.

GOAL: slash-command autocomplete in the input, like an editor command palette.
- When the input is exactly '/<prefix>' (no space yet): show a COMPLETION OVERLAY listing matching slash commands (currently: /run;
  list any others found at scout). Selecting one fills '/name '.
- When the input is '/run <prefix>' (command chosen, typing the param value): show the VALUE OPTIONS for that command's param — for
  /run that is the .ax/orch/*.ts script base-names (read the dir; reuse ORCH_SCRIPTS_DIR), filtered by <prefix>. Selecting fills the name.
- Keyboard: ↑/↓ move selection, Tab or Enter completes the highlighted item (does NOT submit the turn), Esc dismisses the overlay.
  Submitting (Enter with no overlay, or after fill) runs the command as today. Overlay only shows while input starts with '/'.

DESIGN (keep it small + extensible):
- A slash-command REGISTRY: an array/map of { name: string, describe: string, getOptions?: (valuePrefix: string) => string[] | Promise<string[]> }.
  /run's getOptions reads .ax/orch script base-names. Future commands just add an entry — no overlay rewrite. Put the registry in a small
  module (e.g. src/slash.ts) so chat.tsx stays lean; the actual '/run' execution stays where it is (don't move behavior, just feed completion).
- The overlay is a TUI component under the input (opentui box/list or SelectRenderable — use what scout finds in use; match the existing
  collapsible/tool view style + theme). Drive it from input value + a selectedIndex state; render only when there are matches.

PRINCIPLES: PURE TUI layer — NO change to orch.ts (5 prims), agent.ts turn(), the activity bus contract, or orch-load behavior. Match
surrounding chat.tsx style + keyboard model (it already has Tab focus / Enter expand / ↑↓ history — integrate without breaking those:
the overlay intercepts ↑/↓/Tab/Enter/Esc ONLY while open + input starts with '/'). Real types. Unavoidable any => 'ponytail:' + 'Upgrade:'.
GREEN GATE = ${CHECK} clean. Commit each feature --no-verify, conventional message.
`

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' },
    checkOutput: { type: 'string' }, committed: { type: 'boolean' }, commitSha: { type: 'string' },
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
  () => agent(`Read src/chat.tsx fully. Report: the input component + how its value/state is held, the submit handler, the EXACT slash parsing (/run etc, file:line), the useKeyboard handlers + current key bindings (Tab focus, Enter expand, ↑↓ history, ^o, PgUp/Dn), and IDLE_HINT. Where would a completion overlay mount + how would it intercept keys ONLY while open. Cite file:line.\n\n${SPEC}`,
    { label: 'chat-input', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
  () => agent(`Report: (a) the opentui elements/components available for a list/menu overlay (box, scrollbox, SelectRenderable, text) as USED in this repo (read src/chat.tsx + ../opentui/packages/core/src/renderables + react bindings) so the overlay matches existing usage. (b) src/orch-load.ts ORCH_SCRIPTS_DIR + any existing helper to list script names (or how to readdir .ax/orch for *.ts base-names). Cite file:line.\n\n${SPEC}`,
    { label: 'opentui-scripts', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'Explore' }),
])).filter(Boolean)
const CONTRACTS = JSON.stringify(scout, null, 1)
log(`scouted ${scout.length}/2`)

const FEATURES = [
  { key: 'registry', title: 'registry',
    spec: `Create src/slash.ts: a slash-command REGISTRY — exported array of { name, describe, getOptions?(valuePrefix): string[]|Promise<string[]> }. Add the '/run' entry whose getOptions lists .ax/orch/*.ts base-names (readdir ORCH_SCRIPTS_DIR from orch-load.ts, strip .ts, filter by prefix). Add a helper completeInput(value): { kind:'command'|'value'|'none', command?, items: string[], replace:(item)=>string } that, given the raw input string, returns what to suggest (commands when input is '/<prefix>' with no space; values via the chosen command's getOptions when input is '/name <prefix>'). Pure logic + a tiny unit test (scripts/slash.test.ts, match existing assert-fixture style) asserting completeInput for '/r', '/run ', '/run ex'. NO UI yet, NO behavior change to existing /run execution. tsc green.` },
  { key: 'overlay', title: 'overlay',
    spec: `Wire the completion overlay into src/chat.tsx using src/slash.ts. (1) Derive completion state from the input value via completeInput(); hold a selectedIndex. (2) Render an overlay (opentui list/box per scout, matching existing style/theme) directly under the input, ONLY when input starts with '/' and there are items; show the items, highlight selectedIndex, show each command's describe for the command list. (3) Keyboard: while the overlay is OPEN, intercept ↑/↓ (move selection), Tab/Enter (fill the highlighted item via replace(); do NOT submit), Esc (dismiss); when the overlay is CLOSED, all keys behave exactly as today (history, expand, submit, ^o). Do not regress Tab-focus/Enter-expand/↑↓-history when overlay is closed. (4) Update IDLE_HINT to mention completion (e.g. '/ … tab complete'). tsc green; verify the existing /run + ^o + single-turn paths still work.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 70000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.title)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} MUST end green. Self-heal up to ${MAX_HEAL}. Mark shortcuts 'ponytail:' + 'Upgrade:'. When green, COMMIT alone (--no-verify) 'feat(tui): ${f.key} ...'. Report sha/diff/check tail/new ponytails.\n\nCONTRACTS:\n${CONTRACTS}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" left ${CHECK} RED. Fix + re-run to green, commit --no-verify.\nFAILING:\n${impl.checkOutput}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'ux-keys', focus: `Does the overlay intercept ↑↓/Tab/Enter/Esc ONLY while open + input starts with '/' — and leave history/expand/submit/^o untouched when closed? Does Tab/Enter FILL (not submit) while open? Does /run still execute as before after a fill? Cite file:line.` },
    { k: 'purity', focus: `PURE TUI — zero change to orch.ts (5 prims), agent.ts turn(), activity bus, orch-load behavior? registry extensible (new command = one entry)? no unmarked any/ponytail, no new dead export? Cite file:line.` },
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
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Cover: (1) both features green? (2) what completes now — type '/' -> command list, '/run ' -> .ax/orch script names; how to navigate/fill (↑↓/Tab/Enter/Esc). (3) confirm pure TUI, no core touched, existing keys (history/expand/^o/submit) intact. (4) residual (ponytails, anything red). (5) one line: is slash-command + param-value autocomplete now live in the TUI? Headline anything red.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
