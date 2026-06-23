export const meta = {
  name: 'tui-mature',
  description: 'Kill the hand-rolled TUI dogshit: adopt opencode-grade mature UI into rlmcode src/tui, grounded in the ranked gap-map (memory opencode-ui-maturity-gaps). FOUNDATION built in PARALLEL as new/self-contained files (theme system with syntax scopes, a reusable DialogSelect, a keybind registry + mode-stack, @-mention/slash autocomplete, a which-key overlay); then SEQUENTIAL integration into chat.tsx/messages.tsx/composer.tsx/toolui.ts (wire the registry, refactor palette onto DialogSelect, wire autocomplete + which-key, PART_MAPPING + inline-vs-block + per-tool components + reasoning-collapse + tool-output-collapse, native diff-viewer); then polish. Every step gated on tsc + lint + a NEW test:tui captured frame, flake-disciplined, adversarial review, commit each. opencode is Solid → port to React; rlmcode is opentui REACT.',
  phases: [
    { title: 'Study',    detail: 'verify @opentui/keymap availability (else hand-roll the registry); re-confirm opencode (../opencode latest dev) + rlmcode file:line per the gap-map; confirm the harness (driver/test:tui); report what already partly exists' },
    { title: 'theme',    detail: 'FOUNDATION: rewrite src/tui/theme.ts to opencode token taxonomy — 90+ tokens incl SYNTAX scopes + diff + markdown + a resolveTheme; keep Catppuccin-Mocha default' },
    { title: 'dialog-select', detail: 'FOUNDATION: new src/tui/dialog-select.tsx — generic searchable DialogSelect<T> (fuzzy, categories, scroll, ↑↓/↵/esc), ported from opencode ui/dialog-select.tsx' },
    { title: 'keys',     detail: 'FOUNDATION: new src/tui/keys.ts — keybind registry ({keys,desc,run,when}[]) + a MODE STACK (dialog/autocomplete scope keys); @opentui/keymap if available' },
    { title: 'autocomplete', detail: 'FOUNDATION: new src/tui/autocomplete.tsx — @-mention repo file search + /slash command popup (fuzzy, ↑↓/↵/esc, anchor-positioned), ported from opencode autocomplete.tsx' },
    { title: 'which-key', detail: 'FOUNDATION: new src/tui/which-key.tsx — contextual keybind-hint overlay reading the registry active keys (grouped, toggle)' },
    { title: 'wire-registry', detail: 'INTEGRATION: replace chat.tsx if-chain dispatch with the keys registry + mode-stack; palette/dialogs/autocomplete register scoped bindings' },
    { title: 'palette-dialogselect', detail: 'INTEGRATION: refactor palette.tsx to use DialogSelect<Command>; add a session-switcher + model-pick using the same primitive' },
    { title: 'wire-autocomplete', detail: 'INTEGRATION: wire autocomplete into the composer (@ files / slash commands), composer yields focus to it (captureFocus/mode-stack)' },
    { title: 'transcript', detail: 'INTEGRATION: PART_MAPPING dispatch + inline-vs-block tool render + per-tool components (Task/Shell/Edit/Read) + tool-output-collapse + reasoning-collapse (toggle + summary)' },
    { title: 'diff-viewer', detail: 'INTEGRATION: toolui.ts edit/write diff → native opentui <diff> with syntax + split/unified by width (replace the LCS inline preview)' },
    { title: 'polish',   detail: 'POLISH: reusable Panel/Separator, per-node token badge in the tree, pending/QUEUED message state, which-key overlay wired' },
    { title: 'Report',   detail: 'per feature: frame-proof + before/after; is the UI now opencode-grade (not hand-rolled)? residual + honest flaky notes' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const TUIGATE = 'bun run test:tui'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
rlmcode = a self-orchestrating TUI coding agent, opentui REACT in src/tui (chat.tsx + messages.tsx + composer.tsx + palette.tsx + toolui.ts +
orch-tree.ts + theme.ts + icons.ts + ui/). GOAL: adopt opencode-GRADE mature UI, killing the hand-rolled pieces. The ranked gap-map with
file:line on BOTH sides is in memory opencode-ui-maturity-gaps (READ IT) — opencode is at ../opencode/packages/tui (latest dev, Solid+@opentui:
port patterns to React, NO Solid mechanics). rlmcode already has: a clean composer (left-clean/right-status, captureFocus), a working ⌘K palette
(palette.tsx), an inline node-tree (orch-tree.ts flatten + chat.tsx), live markdown (<markdown streaming>), theme.ts (24 tokens, 1 palette),
icons.ts. KEEP all the substance (orch engine, session model, activity bus, the node-tree) — this is a UI MATURITY adoption, NOT a logic rewrite.

THE TARGETS (see the memory gap-map for opencode/rlmcode file:line + what to adopt):
FOUNDATION (new/self-contained files, parallel-safe): theme.ts rewrite (90+ tokens incl SYNTAX scopes so markdown/code render richer + diff +
markdown tokens + a resolveTheme; keep Catppuccin-Mocha as the default palette — render must look the SAME or better, not broken);
dialog-select.tsx (generic searchable DialogSelect<T> — fuzzy filter, categories, scroll, keyboard nav — the reusable primitive opencode's
ui/dialog-select.tsx is); keys.ts (a keybind REGISTRY + MODE STACK replacing the chat.tsx if-chain — use @opentui/keymap IF it's an available dep,
else hand-roll a {keys,desc,run,when}[] table + a mode stack so dialogs/autocomplete scope keys); autocomplete.tsx (@-mention repo file search via
glob + /slash command popup, anchor-positioned, fuzzy, ↑↓/↵/esc); which-key.tsx (contextual keybind-hint overlay reading the registry).
INTEGRATION (sequential — they touch the shared chat.tsx/messages.tsx/composer.tsx/toolui.ts): wire the registry into chat.tsx (replace the
if-chain + the palette-boolean with the mode stack); refactor palette.tsx onto DialogSelect (+ a session switcher + model pick using it); wire
autocomplete into the composer; PART_MAPPING dispatch + inline-vs-block tool render + per-tool components (Task: subagent status+retry; Shell:
workdir; Edit/Write: diagnostics; Read: count) + tool-output-collapse (3 lines + "+N more", Shell 10) + reasoning-collapse (hide/show toggle +
duration summary); diff-viewer (toolui.ts → native opentui <diff> + syntax + split/unified by width). POLISH: a reusable Panel/Separator, a
per-node token badge in the tree (orch-tree Row already has tokens), pending/QUEUED message state, the which-key overlay wired in.

PRINCIPLES: opentui REACT (useState/useMemo/useEffect — no Solid createSignal/Show/For; map to {cond && …} and .map()). Real opentui API (read
../opentui/packages/core + react when types bite). ONE-WORD vocab: node. File-size budget <1000 lines — EXTRACT components to src/tui/ files,
do NOT grow chat.tsx. Reuse the theme tokens (no inline hex). Msg/OrchTree/session shapes UNCHANGED. Unavoidable any => 'ponytail:'. Each step:
${CHECK} + ${LINT} green AND ${TUIGATE} green with a NEW captured-frame assertion (drive the rlmcode harness scripts/tui/driver.ts + RLM_MOCK,
add the frame test, make it pass). Commit each --no-verify with Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT git
add -A. Re-confirm line refs at Study.

FLAKE DISCIPLINE (the test:tui PTY frames are TIMING-sensitive — do NOT thrash heal on flake):
- HARD GATE = deterministic ${CHECK} + ${LINT}. A failure there is REAL — fix it.
- A test:tui failure: RE-RUN up to 3x FIRST. Any pass ⇒ FLAKY, set flaky=true, proceed — do NOT heal working code, do NOT loosen an assertion to
  make a real bug pass. Only a CONSISTENT failure (frame genuinely lacks the asserted structure) = RED → heal.
- Assert STABLE structure via the harness waitFor (text/connectors/labels), NEVER a spinner glyph or byte-exact golden. If a test is flaky from a
  fragile assertion, FIX THE TEST (stable waitFor). frameProof must reproduce across retries.
- Tests assert CONTENT + BEHAVIOR (does it render/work), NOT decorative glyphs — a cosmetic tweak must not break a test.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'keymapAvailable'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } }, keymapAvailable: { type: 'boolean' } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'flaky', 'frameProof', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, flaky: { type: 'boolean' },
    frameProof: { type: 'string', description: 'the captured test:tui frame proving the step renders/works — NOT compile-only; reproduced across retries' },
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
  () => agent(`Read the gap-map (the memory file's content is summarized in this SPEC) + re-confirm opencode (../opencode/packages/tui) + rlmcode (src/tui) file:line for each target. CRITICAL: is '@opentui/keymap' an available dependency (check rlmcode package.json + node_modules + ../opentui packages)? Set keymapAvailable. Report the harness contract (scripts/tui/driver.ts frame/type/key/ctrl/waitFor + RLM_MOCK + test:tui) and anything that already partly exists in rlmcode (palette, captureFocus, live markdown). Cite file:line.\n\n${SPEC}`,
    { label: 'study:foundation', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Read rlmcode src/tui CURRENT state for the integration targets: chat.tsx (the if-chain key dispatch ~760-823, palette wiring, toTurns/TurnView, the orch render), messages.tsx (UserCard/AssistantReply/ThinkingPart/ErrorCard + the PART rendering), composer.tsx, palette.tsx, toolui.ts (the LCS diff + tool preview/summary), orch-tree.ts (Row + flatten + the token field). Report exact lines to change for: registry-wire, palette→DialogSelect, autocomplete-wire, PART_MAPPING+per-tool+collapse, diff-viewer, per-node-token-badge. Cite file:line.\n\n${SPEC}`,
    { label: 'study:integration', phase: 'Study', schema: FIND, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
const keymap = study.some(s => s && s.keymapAvailable)
log(`studied ${study.length}/2; @opentui/keymap available: ${keymap}`)

const buildStep = (group) => async (f) => {
  let impl = await agent(
    `Implement TUI maturity step "${f.key}" in rlmcode src/tui, grounded in the study + the gap-map (port opencode Solid→React; real opentui API). opencode-grade, not hand-rolled.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + ${LINT} green AND ${TUIGATE} green with a NEW captured-frame assertion (drive scripts/tui/driver.ts + RLM_MOCK; paste it as frameProof — reproduced across retries, NOT compile-only). FLAKE DISCIPLINE applies (retry 3x, classify, set flaky). Self-heal up to ${MAX_HEAL}. Extract to src/tui/ files (don't grow chat.tsx). ONE WORD vocab: node. Keymap available: ${keymap}. When green, COMMIT alone (--no-verify) 'feat(tui): ${f.key} …'. Report sha/diff/check tail/frameProof/flaky/ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 70000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/${LINT}/${TUIGATE}). FLAKE DISCIPLINE: a PTY flake that passes on retry is NOT real — set flaky, proceed; only heal a CONSISTENT real failure. Fix + re-verify (stable frame), commit --no-verify.\nFAILING:\n${impl.checkOutput}\nFRAME:\n${impl.frameProof}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'opencode-grade', focus: `Is "${f.key}" genuinely opencode-grade (matches the gap-map target — the real structure/behavior, ported right), not a thin hand-rolled stub? Proven by a REAL captured frame (reproduced, not a flake-pass)? Cite file:line + quote the frame.` },
    { k: 'safe', focus: `Msg/OrchTree/session shapes UNCHANGED, orch logic intact, theme tokens not inline hex, chat.tsx not grown (extracted to files), ONE-word vocab, lint green, frames deterministic? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Demand a reproduced (non-flake) frame + gap-map fidelity. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`[${group}] ${f.key}: flaky=${impl ? impl.flaky : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 70000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real (not by loosening assertions), re-verify with a stable frame, AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + frame still real? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  return { step: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, flaky: impl ? impl.flaky : false, frame: impl ? (impl.frameProof || '').slice(0, 320) : '', openBlockers: blockers }
}

// FOUNDATION — new/self-contained files → PARALLEL.
const FOUNDATION = [
  { key: 'theme', spec: `Rewrite src/tui/theme.ts to opencode's token taxonomy (theme/index.ts:36-91): add the missing SYNTAX scope tokens (syntaxComment/keyword/function/variable/string/number/type/operator…), richer diff + markdown tokens, and a resolveTheme/getTheme accessor. Keep Catppuccin-Mocha as the ONE default palette (values match what rlmcode ships now — the render must look the same or richer, NOT broken). Wire the syntax tokens into the markdown SyntaxStyle that chat.tsx passes to <markdown>. NEW self-contained (theme.ts + its consumers' imports unchanged in shape). test:tui: a render shows unchanged colors + code/markdown picks up syntax colors; grep proves no inline hex regressed.` },
  { key: 'dialog-select', spec: `New src/tui/dialog-select.tsx: a generic searchable DialogSelect<T> ported from opencode ui/dialog-select.tsx:79-657 — props {items: Option<T>[], onSelect, placeholder, footer}, fuzzy filter (substring ok if no fuzzysort dep), optional categories/grouping, ↑↓/page/home/end nav, scroll for long lists, a centered overlay (reuse palette.tsx's dialog chrome shape). Presentational + a small controller hook; chat.tsx owns open/key state. test:tui: mount a fixture with N items → opens, type filters, ↑↓ moves, the footer shows. (Standalone fixture via driver entry, like ui-atoms.)` },
  { key: 'keys', spec: `New src/tui/keys.ts: a keybind REGISTRY + MODE STACK. A binding = {keys:string[], desc, run, when?, mode?}. A mode stack (base / palette / dialog / autocomplete) so an open dialog SCOPES which bindings fire (the base nav doesn't leak through). A dispatch(key, ctx) that resolves the active mode's bindings. If @opentui/keymap is available (study said ${'${keymap}'} — re-check), use its KeymapProvider; else hand-roll. Pure + unit-testable (a keys.test in scripts/). NEW file; chat.tsx wiring is a LATER step. test:tui not required for the pure module — a scripts/keys.test.ts unit (dispatch resolves the right binding per mode) + tsc/lint green.` },
  { key: 'autocomplete', spec: `New src/tui/autocomplete.tsx: an @-mention + /slash autocomplete popup ported from opencode autocomplete.tsx. @ → repo file search (use the existing glob tool / a fs walk, frecency optional), / → command list (from the keys registry / palette commands). Anchor-positioned popup, fuzzy filter, ↑↓/↵/esc, insert into the composer text. Presentational + a controller; the composer owns the trigger detection + focus yield (mode-stack). NEW file (wiring into composer is the wire-autocomplete step). test:tui: a fixture → type '@', popup opens with files, filter narrows, ↵ inserts.` },
  { key: 'which-key', spec: `New src/tui/which-key.tsx: a contextual keybind-hint overlay (opencode which-key.tsx) reading the keys registry's active-mode bindings — grouped, multi-column if wide, a footer/toggle. Presentational over the registry. NEW file (wired in the polish step). test:tui: a fixture → the overlay lists the active bindings (key + desc).` },
]
phase('theme')
const foundation = (await parallel(FOUNDATION.map(f => () => buildStep('foundation')(f)))).filter(Boolean)
log(`foundation: ${foundation.filter(r => r.status === 'green').length}/${FOUNDATION.length} green`)

// INTEGRATION + POLISH — touch shared files → SEQUENTIAL.
const INTEGRATION = [
  { key: 'wire-registry', spec: `Replace chat.tsx's if-chain key dispatch (onChatKey/onListKey + the palette boolean) with the keys.ts registry + mode stack: base-mode bindings (new/switch/quit/scroll/tab/esc), palette-mode + dialog-mode + autocomplete-mode scope their own keys. Opening the palette/a dialog/autocomplete PUSHES a mode; closing pops. Keep all current behaviors working. test:tui: focus + palette + node-tree key flows still pass (re-run the existing gates) + a new frame proving a dialog mode scopes keys (base nav doesn't fire under it).` },
  { key: 'palette-dialogselect', spec: `Refactor palette.tsx to render via DialogSelect<Command> (drop the bespoke list). Add a SESSION SWITCHER and a MODEL PICK that use the SAME DialogSelect (opencode's reuse). ⌘K still opens commands. test:tui: ⌘K opens (commands via DialogSelect), filter works, ↵ runs; a session-switcher dialog opens + lists sessions.` },
  { key: 'wire-autocomplete', spec: `Wire autocomplete.tsx into the composer: detect '@' / '/' at the cursor → open the popup (push autocomplete mode so keys route to it + composer yields), ↑↓/↵ select + insert, esc closes. test:tui: in the composer type '@' → file popup; type '/' → command popup; ↵ inserts; esc closes + composer regains focus.` },
  { key: 'transcript', spec: `Mature the transcript render (messages.tsx/chat.tsx, port opencode index.tsx): (1) a PART_MAPPING-style dispatch for reply parts; (2) inline-vs-block tool render (running→inline dim line, output→block expandable, error→red card); (3) per-tool components for the high-impact tools — Task (subagent status + retry), Shell (workdir/exit), Edit/Write (path + diagnostics), Read (line count); (4) tool-output collapse (3 lines + "+N more", Shell 10, expandable); (5) reasoning-collapse (hide/show toggle + a duration summary when settled). Keep Msg shape. test:tui: frames for inline-vs-block (a running tool inline, a settled tool block, an error red card), a collapsed tool output ("+N more"), a collapsed reasoning block (toggle).` },
  { key: 'diff-viewer', spec: `Upgrade the edit/write diff in toolui.ts → render via the native opentui <diff> renderable (the one chat.tsx already imports for native diffs) with syntax highlighting (the theme syntax tokens) + split/unified by terminal width (split >120, else unified) + line numbers. Replace the hand-rolled LCS inline preview for edit/write tools (keep a tiny fallback). test:tui: mock an edit tool → frame shows a real syntax-highlighted +/- diff (split or unified), not the crude block.` },
  { key: 'polish', spec: `POLISH: (1) a reusable src/tui/ui/panel.tsx (Panel + Separator) and adopt it where chat.tsx/messages.tsx use ad-hoc bordered boxes; (2) a per-node TOKEN BADGE in the node-tree (orch-tree Row already carries tokens — render it dim right-aligned on the node line, not only the Σ footer); (3) pending/QUEUED user-message state (a badge when a message is posted while a prior turn is in flight); (4) wire the which-key overlay (a key toggles it, reads the registry). test:tui: per-node token badge renders on a node line; a QUEUED badge shows; which-key overlay lists bindings.` },
]
phase('wire-registry')
const integration = []
for (const f of INTEGRATION) {
  if (budget.total && budget.remaining() < 110000) { log(`budget low — stop before ${f.key}`); break }
  integration.push(await buildStep('integration')(f))
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown) on the opencode-grade UI adoption. Per feature (foundation: theme/dialog-select/keys/autocomplete/which-key; integration: wire-registry/palette-dialogselect/wire-autocomplete/transcript/diff-viewer/polish): GREEN? frame-proven (quote a frame)? flaky? Then: is rlmcode's UI now opencode-grade (autocomplete, which-key, reusable dialog, registry, syntax theme, per-tool render, native diff) — or what's still hand-rolled? residual + any RED/flake-papered step (headline it).\n\nFOUNDATION:\n${JSON.stringify(foundation, null, 1)}\n\nINTEGRATION:\n${JSON.stringify(integration, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { foundation, integration, report }
