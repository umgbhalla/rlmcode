export const meta = {
  name: 'tui-migrate',
  description: 'WIDE full TUI migration: rebuild ax2 src/tui to the opencode transcript UX + termcast (Raycast-in-terminal, React+opentui — EXACT ax2 stack, lift near-verbatim) shell/positioning/components. Foundation (theme system, icon map, reusable component atoms) built in PARALLEL as new files; then SEQUENTIAL integration into chat.tsx (app shell → message cards → composer → inline node-tree → command palette → streaming render). DROP LSP/MCP (ax2 has neither). Every step gated on tsc + lint + a NEW test:tui captured frame, flake-disciplined (retry/classify live+PTY), adversarial review, commit each. DEPENDS ON tui-test-harness (driver.ts + test:tui).',
  phases: [
    { title: 'Study',         detail: 'confirm harness/test:tui contract; re-read current src/tui (chat.tsx/atoms/orch-tree/theme); pin opencode + termcast file:line per the SPEC blueprints; report what already landed (streaming/theme/grouping) to avoid re-work' },
    { title: 'theme',         detail: 'FOUNDATION (parallel): lift termcast themes.ts + theme.tsx → src/tui/theme.ts — ResolvedTheme tokens + useTheme(); sweep inline hex' },
    { title: 'icons',         detail: 'FOUNDATION (parallel): lift termcast icon.tsx → src/tui/icons.ts — name→glyph map (the subset ax2 uses) + getIconShape' },
    { title: 'ui-atoms',      detail: 'FOUNDATION (parallel): lift termcast spinner / row / useEvent / animation-tick → src/tui/ui/*; reusable, theme-aware' },
    { title: 'shell',         detail: 'INTEGRATION: opencode/termcast app shell — sticky-bottom scrollbox transcript + pinned composer (flexShrink:0) + footer action-bar (cwd · tokens/cost · Cmd+K — NO LSP/MCP); toBottom() sticky scroll' },
    { title: 'messages',      detail: 'INTEGRATION: opencode message cards — user left-border card; assistant PART_MAPPING dispatch + paddingLeft=3 + the "▣ model · duration" footer line; error red-border card' },
    { title: 'composer',      detail: 'INTEGRATION: opencode/termcast composer — bordered textarea + metadata row (model) + bottom status row; the captureFocus model (composer default owner)' },
    { title: 'node-tree-inline', detail: 'INTEGRATION: wire the orch node-tree INLINE per-turn (opencode message-part pattern), conditional via computeShowOrch — not always at transcript bottom' },
    { title: 'palette',       detail: 'INTEGRATION: termcast List + ActionPanel(⌘K) → a command palette + session list (replaces the keybind if-chain); fuzzy filter + action menu' },
    { title: 'streaming',     detail: 'INTEGRATION: stale-check (may be wired) → ensure live thinking block + incremental reply render (opencode PacedMarkdown)' },
    { title: 'Report',        detail: 'frame-proof per step; before/after; what is now headless-verified; residual + honest flaky notes' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const TUIGATE = 'bun run test:tui'
const MAX_HEAL = 5
const MAX_HARDEN = 2

// The blueprints — embedded so every agent has the exact file:line to copy. opencode = Solid (port
// patterns, NOT Solid mechanics); termcast = React+opentui (EXACT ax2 stack — lift near-verbatim).
const BLUEPRINT = `
SOURCES (read them — do not guess):
- opencode TUI (Solid+@opentui) opencode/packages/tui/src — TRANSCRIPT/MESSAGE UX. Port patterns, rewrite Solid→React.
  layout session/index.tsx:1209-1412 (scrollbox stickyScroll bottom + pinned composer + 42-wide optional sidebar); user msg :1424-1528 (left-border agent-color card, paddingLeft=2, file badges, timestamp/QUEUED); assistant :1531-1637 (<For parts> PART_MAPPING[part.type] Dynamic, content paddingLeft=3, marginTop=1, "▣ mode · model · duration" footer); tool render :1902-2052 (inline vs block, collapse :1868-1900); composer component/prompt/index.tsx:1403-1762; footer footer.tsx:52-91; scroll toBottom() :1232-1250. PART_MAPPING dispatch :1556/:1640.
- termcast (Raycast-in-terminal, React+@opentui — SAME STACK, copy near-verbatim) termcast/termcast/src:
  THEME themes.ts (ResolvedTheme 50+ tokens: text/textMuted/background/backgroundPanel/backgroundElement/primary/accent/border/borderActive/success/warning/error/info/markdown*/syntax*/diff*) + theme.tsx (useTheme() via store, getResolvedTheme) — LIFT to src/tui/theme.ts.
  ICONS components/icon.tsx (ICON_MAP 400+ name→terminal-safe glyph, getIconShape fallback ●) — LIFT the subset ax2 uses to src/tui/icons.ts.
  APP SHELL internal/providers.tsx:150-277 (centered max-width frame), internal/navigation.tsx:40-197 (push/pop nav stack, key=depth remount), internal/dialog.tsx:39-144 (Dialog position center/top-right + DialogProvider InFocus isolation + DialogOverlay position:absolute), components/footer.tsx:243-300 (Footer flexShrink:0 space-between, bold-key + muted-label hints, toast overlay).
  LIST components/list.tsx: item row :813-1080 (› active marker, icon, bold-active title, subtitle muted, accessories right; active = bg primary/fg background); search bar :1854-1876 (textarea, live substring filter shouldItemBeVisible :549-571); sections :2545; empty :1951; split detail :214-260 (50/50, grow-only height ratchet); layout :1887-1929 (flexShrink:0 header/search, flexGrow:1 body, pinned footer); keyboard :1552-1758 (↑↓ nav, ↵ first-action, ^K actions, ^P dropdown).
  ACTIONS components/actions.tsx:777-988 (ActionPanel ⌘K — offscreen register via useActionDescendant + portal to center Dialog + Dropdown; first-action auto-exec on ↵). DROPDOWN components/dropdown.tsx:101-430 (trigger, popup, filter, ↑↓/↵/esc).
  FOCUS internal/dialog.tsx:96-144 (<InFocus> gates children; dialogs isolate). HOOKS hooks.tsx useEvent; animation-tick.tsx useAnimationTick. SPINNER spinner.tsx (·/• pulse). ROW row.tsx. MARKDOWN markdown.tsx + markdown-utils.tsx (OSC8 links, syntax via theme).
`

const SPEC = `
ax2 = a multi-session TUI coding agent on @ax-llm/ax (CF Kimi), opentui REACT in src/tui (chat.tsx + atoms.ts + orch-tree.ts). GOAL:
MIGRATE THE FULL TUI to a polished opencode-transcript + termcast-shell look. termcast is React+opentui (EXACT same stack) so its
theme/icons/list/actions/dialog/components are LIFTED NEAR-VERBATIM; opencode is Solid so its transcript/message patterns are PORTED to React.

DROP: NO LSP, NO MCP (ax2 has neither). The footer shows cwd · session · token/cost · Cmd+K — NOT opencode's LSP/MCP/permission dots. Do not
add features ax2 has no backing for.

KEEP ax2's substance: the orchestration node-tree (orch-tree.ts flatten + NodeRow + computeShowOrch + orchSigma), the per-turn streaming
render, the session model (atoms.ts Msg/SessionView/OrchTree), the activity/node-event bus. This is a RE-SKIN + RE-LAYOUT + add palette, NOT a
logic rewrite. Msg/OrchTree shapes stay; presentation changes.

STRUCTURE: build FOUNDATION as NEW files (parallel-safe, no collision): src/tui/theme.ts (lift termcast theme), src/tui/icons.ts (lift the
icon subset), src/tui/ui/* (spinner/row/useEvent/animation-tick). THEN integrate SEQUENTIALLY into chat.tsx (one file → sequential): app shell,
message cards, composer, inline node-tree, command palette, streaming. The node-tree wiring (memory opencode-ux-blueprint Option B): Turn +=
workflow?:OrchTree; toTurns attaches orch to the turn when computeShowOrch; TurnView renders <WorkflowPart> after the reply; reuse flatten/
NodeRow/orchSigma. Command palette = termcast List+ActionPanel(⌘K): a session switcher + command list replacing the keybind if-chain.

PRINCIPLES: this is opentui REACT — termcast ports verbatim, opencode rewrites Solid→React (useState/useMemo/useEffect, no createSignal/Show/
For — map to {cond && …} and .map()). ONE-WORD vocab: node. Real opentui API (read ../opentui when types bite). File-size budget <1000 lines
(chat.tsx grandfathered but DON'T grow it — extract components to src/tui/ files). Unavoidable any => 'ponytail:'. Each step: ${CHECK} + ${LINT}
green AND ${TUIGATE} green with a NEW captured-frame assertion. Commit each --no-verify, Co-Authored-By: Claude Opus 4.8 (1M context)
<noreply@anthropic.com>. Do NOT git add -A (concurrent sessions' dirty files). Re-confirm all line refs at Study — heavy concurrent churn.

FLAKE DISCIPLINE (the test:tui PTY frames are TIMING-sensitive; live CF is nondeterministic+rate-limited — do NOT thrash heal on flake):
- HARD GATE = deterministic ${CHECK} + ${LINT} (incl the in-process mock.test). A failure here is REAL — fix it.
- PTY/live failures: RE-RUN up to 3× FIRST. Any pass ⇒ FLAKY not failing ⇒ proceed, set flaky=true, note it — do NOT heal working code, do NOT
  loosen an assertion to make a real bug pass. Only a CONSISTENT failure across all 3 (frame genuinely lacks the structure) = RED → heal.
- Assert STABLE structure via the harness waitFor (connectors/gutter/row text/footer), NEVER a spinner glyph or a byte-exact golden. If a test is
  flaky from a fragile assertion, FIX THE TEST (stable waitFor), don't retry-forever. frameProof must reproduce across retries.

${BLUEPRINT}
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'alreadyLanded'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } }, alreadyLanded: { type: 'array', items: { type: 'string' } } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'flaky', 'frameProof', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, flaky: { type: 'boolean' },
    frameProof: { type: 'string', description: 'the captured test:tui frame proving the step renders right — NOT compile-only; reproduced across retries' },
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
  () => agent(`HARD DEP CHECK + harness contract: read scripts/tui/driver.ts + the test:tui script + the mock layer. Report the EXACT driver API (frame/type/key/click/waitFor) + how to mount with mocked AI + mocked NodeEvents so each migration step adds a frame test. If driver.ts/test:tui are ABSENT, say so (STOP). Cite file:line.\n\n${SPEC}`,
    { label: 'harness', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Read ax2 CURRENT src/tui: chat.tsx (the transcript, TurnView/ReplyView/ThinkingView, NodeView/NodeRow, the composer + focus model, the orch render site ~846, computeShowOrch ~480, toTurns ~74), atoms.ts (Msg/SessionView/OrchTree shapes + reducer), orch-tree.ts (flatten/Row/orchSigma), theme.ts if present. Report exact current lines for each migration target + WHAT ALREADY LANDED (streaming stream:true? theme.ts extracted? tool-grouping? error-cards?) so we don't re-do. Cite file:line.\n\n${SPEC}`,
    { label: 'ax2-current', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Confirm the COPY targets exist as cited: skim opencode session/index.tsx (layout/message/PART_MAPPING) + termcast themes.ts/theme.tsx, icon.tsx, list.tsx, actions.tsx, dialog.tsx, footer.tsx, spinner.tsx, hooks.tsx. For each ax2 foundation/integration step, report the precise source file:line to lift/port + any opentui-React gotcha (Solid→React for opencode; verbatim for termcast). Cite file:line in BOTH trees.\n\n${SPEC}`,
    { label: 'sources', phase: 'Study', schema: FIND, agentType: 'Explore' }),
])).filter(Boolean)
// POSITIVE dep check: the harness is present iff the study cites scripts/tui/driver.ts (do NOT
// regex the whole study for negative words — the agents echo the prompt's own "STOP/ABSENT", a
// false-positive that aborted run wf_0f5f7b9c-d62).
const depPresent = study.some(s => s && JSON.stringify(s.cites || []).includes('scripts/tui/driver.ts'))
if (!depPresent) { log('DEP MISSING: harness driver.ts not cited — STOPPING.'); return { stopped: 'harness dependency not shipped', study } }
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/3; harness present`)

// One impl+heal+review pass over a step. Shared by parallel foundation + sequential integration.
const buildStep = (group) => async (f) => {
  let impl = await agent(
    `Implement TUI migration step "${f.key}" in ax2 src/tui, grounded in the study + the embedded blueprint (lift termcast verbatim; port opencode Solid→React). Polished, opencode/termcast-grade.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + ${LINT} green AND ${TUIGATE} green with a NEW captured-frame assertion (paste it as frameProof — reproduced across retries, NOT compile-only). FLAKE DISCIPLINE applies (retry 3x, classify, set flaky). Self-heal up to ${MAX_HEAL}. Extract components to src/tui/ files (don't grow chat.tsx). ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(tui): ${f.key} …'. Report sha/diff/check tail/frameProof/flaky/new ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/${LINT}/${TUIGATE}). Apply FLAKE DISCIPLINE: if the failure is a PTY/live flake (passes on a retry), it's NOT real — set flaky, proceed; only heal a CONSISTENT real failure. Fix + re-verify (capture a stable frame), commit --no-verify.\nFAILING:\n${impl.checkOutput}\nFRAME:\n${impl.frameProof}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'frame-proven', focus: `Is "${f.key}" verified by a REAL test:tui captured frame (the frameProof shows the rendered structure — the shell/card/composer/footer/tree/palette), reproduced across retries, NOT compile-only and NOT a flake-passed-once? Quote the frame + cite file:line.` },
    { k: 'fidelity-safe', focus: `Does it match the opencode/termcast blueprint (right structure/positioning/tokens, NO LSP/MCP, theme tokens not inline hex)? Msg/OrchTree shapes UNCHANGED, orch logic intact, ONE-word vocab, chat.tsx not grown (components extracted)? lint green, frames deterministic? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Demand a reproduced (non-flake) captured frame + blueprint fidelity. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`[${group}] ${f.key}: flaky=${impl ? impl.flaky : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real (not by loosening assertions), re-verify with a stable frame, AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + frame still real (reproduced)? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  return { step: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, flaky: impl ? impl.flaky : false, frame: impl ? (impl.frameProof || '').slice(0, 360) : '', openBlockers: blockers }
}

// FOUNDATION — NEW files, no shared-file collision → PARALLEL (the WIDTH).
const FOUNDATION = [
  { key: 'theme', spec: `Lift termcast themes.ts + theme.tsx → src/tui/theme.ts: a ResolvedTheme token object (text/textMuted/background/backgroundPanel/backgroundElement/primary/accent/border/borderActive/success/warning/error/info + markdown/diff tokens ax2 uses) + a useTheme()/getTheme accessor matching ax2's state (no Zustand — use ax2's atoms or a module const). Pick ONE default palette (Catppuccin-ish to match current). Sweep existing inline hex in src/tui to theme.x. NEW FILE — no chat.tsx logic change beyond importing. test:tui: a render shows unchanged colors + grep proves no inline hex left.` },
  { key: 'icons', spec: `Lift the icon subset ax2 uses from termcast components/icon.tsx → src/tui/icons.ts: a name→terminal-safe-glyph map + getIconShape(name) (fallback ●) for the tool/status/node glyphs ax2 renders (read/write/bash/search/check/error/spinner/▣/connectors). NEW FILE. test:tui: a frame using an icon renders the right glyph.` },
  { key: 'ui-atoms', spec: `Lift termcast spinner.tsx (·/• pulse, theme color), row.tsx (equal-flex row), hooks.tsx useEvent, animation-tick.tsx useAnimationTick → src/tui/ui/* (React+opentui, verbatim-ish). NEW FILES, theme-aware. test:tui: a frame with the spinner + a row renders (assert the row structure, NOT the spinner glyph phase).` },
]
phase('theme')
const foundation = (await parallel(FOUNDATION.map(f => () => buildStep('foundation')(f)))).filter(Boolean)
log(`foundation done: ${foundation.filter(r => r.status === 'green').length}/${FOUNDATION.length} green`)

// INTEGRATION — all touch chat.tsx → SEQUENTIAL (no parallel writes to one file).
const INTEGRATION = [
  { key: 'shell', spec: `App shell (opencode index.tsx:1209-1412 + termcast providers/list layout): a column frame — sticky-bottom <scrollbox> transcript (flexGrow) + pinned composer (flexShrink:0) + a footer action-bar. Footer = cwd (left) · token/cost + 'Cmd+K commands' (right). NO LSP/MCP/permission dots. toBottom() sticky scroll on submit + session switch. Use theme.ts tokens. test:tui: frame shows the pinned composer + footer bar + scrolling transcript region.` },
  { key: 'messages', spec: `Message cards (opencode :1424-1637, port Solid→React): user message = left-border agent/accent card, paddingLeft=2; assistant = a PART_MAPPING-style dispatch (text/tool/reasoning), content paddingLeft=3, marginTop=1, a "▣ model · duration" footer line; error = red-border card (#f38ba8). Reuse existing tool/step rendering + grouping if present. Msg shape UNCHANGED. test:tui: frame shows a user card + an assistant reply with the footer line + an error card.` },
  { key: 'composer', spec: `Composer (opencode prompt/index.tsx:1403-1762 + termcast): bordered textarea (left border, theme-tinted), a metadata row (model name), a bottom status row (left spinner/hint, right tokens·cost / Cmd+K). The captureFocus model: composer is the DEFAULT focus owner (reclaim on blur) UNLESS a dialog/palette owns it (captureFocus true) — replace any BLURRED-reclaim hack. test:tui: frame shows the composer + metadata + status; click a row → still typable; palette open → composer does NOT steal.` },
  { key: 'node-tree-inline', spec: `Wire the orch node-tree INLINE per-turn (memory opencode-ux-blueprint Option B; opencode PART_MAPPING :1556/:1640): Turn += workflow?:OrchTree; toTurns(messages, orch) attaches orch to the turn when computeShowOrch(orch); TurnView renders {t.workflow && <WorkflowPart/>} after the reply; WorkflowPart reuses flatten/NodeRow/orchSigma; per-node expand useState(Set); Tab ring includes orch rows ONLY when a WorkflowPart shows. NON-workflow turns render NO tree. test:tui: a mock workflow turn → tree renders INLINE under that turn (├─ └─ + Σ); a plain turn → NO orchestration block.` },
  { key: 'palette', spec: `Command palette + session list (termcast list.tsx:813-1080 + actions.tsx:777-988 + dropdown.tsx): a ⌘K/Ctrl-K action menu (a centered dialog: search input + filtered action list, ↑↓/↵/esc) for commands (new/switch/delete session, etc.), and a session-switcher list (› active marker, icon, title, subtitle muted, fuzzy substring filter). Replace the keybind if-chain with a {name,keys,run}[] table driving the palette. Use the dialog-overlay + InFocus isolation pattern (termcast dialog.tsx:96-144). test:tui: open palette (Ctrl-K) → frame shows the action list + filter; type → filters; esc → closes, composer regains focus.` },
  { key: 'streaming', spec: `STALE-CHECK first (study reported whether stream:true + streamingForward already landed). If already wired, this is render-only: ensure a live THINKING block (reasoning_content, dim/italic) renders THEN reply tokens incrementally (opencode PacedMarkdown reference) inside the new message card. If NOT wired, wire streamingForward with a non-streaming fallback. test:tui: mock streaming reasoning+reply deltas → frame shows the thinking block then streamed tokens across frames (assert stable text, not a mid-settle cursor).` },
]
phase('shell')
const integration = []
for (const f of INTEGRATION) {
  if (budget.total && budget.remaining() < 90000) { log(`budget low — stop before ${f.key}`); break }
  integration.push(await buildStep('integration')(f))
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown) on the TUI migration. Per step (foundation: theme/icons/ui-atoms; integration: shell/messages/composer/node-tree-inline/palette/streaming): GREEN? frame-proven (quote a frame)? flaky? Then: does ax2 now look like opencode-transcript + termcast-shell (no LSP/MCP), with the orch node-tree inline-per-turn + a ⌘K palette? What's headless-verified vs still human-dogfood. Residual + any RED or flake-papered step (headline it).\n\nFOUNDATION:\n${JSON.stringify(foundation, null, 1)}\n\nINTEGRATION:\n${JSON.stringify(integration, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { foundation, integration, report }
