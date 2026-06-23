export const meta = {
  name: 'tui-finish',
  description: 'Finish the rlmcode UI to opencode/claude_code grade: diff-viewer (hunk eval / native <diff>) + polish (Panel + per-node token badge) + render-model maturity (memoize SETTLED turns = static-commit perf; ref-driven sticky header + "N new" pill) + session-id in the header (tracking ↔ motel session.id) + THEME SUPPORT (multiple selectable palettes + a /theme picker + reactive useTheme + persistence). Grounded in memory opencode-ui-maturity-gaps + the claude_code static-commit/ref-chrome design. STRICTLY src/tui (+ toolui). diff-viewer already landed native; this evals the hunk swap + does the rest. Each step gated on tsc + lint + a NEW test:tui captured frame, flake-disciplined, adversarial review, commit each.',
  phases: [
    { title: 'Study',   detail: 'read src/tui current (chat.tsx transcript/TurnView/render, toolui.ts diff, orch-tree Row tokens, shell.tsx footer/ActionBar, the theme syntax tokens) + the gap-map (opencode diff-viewer + Panel/Separator) + the claude_code render model (static-commit, ref-chrome). Pin where each lands. Confirm clean main.' },
    { title: 'diff-viewer', detail: 'toolui.ts edit/write diff → native opentui <diff> + syntax highlight (theme syntax tokens) + split/unified by terminal width; replace the crude LCS preview' },
    { title: 'polish',  detail: 'reusable src/tui/ui/panel.tsx (Panel + Separator), adopt where chat.tsx/messages use ad-hoc bordered boxes; per-node TOKEN BADGE in the node-tree (orch-tree Row already carries tokens); consistent spacing/borders' },
    { title: 'static-commit', detail: 'memoize SETTLED turns (React.memo on TurnView keyed by turn id + content) so only the in-flight turn + composer re-render — the claude_code scrollback-immutable perf win; pure-presentational, no logic change' },
    { title: 'header-anchors', detail: 'a ref-driven sticky header "rlmcode · session <id>" (the session-id ask — matches the motel session.id tag) + a "N new" scroll pill when scrolled up; ref-driven (no re-render on scroll)' },
    { title: 'theme-support', detail: 'theme.ts → a registry of curated palettes (current = default) + a React ThemeContext/useTheme + a /theme DialogSelect picker that switches live + persists; migrate theme.x readers to the reactive theme; every palette complete (all keys), no inline hex' },
    { title: 'Report',  detail: 'frame-proof per step; is the UI now opencode/claude_code-grade (rich diff, panels, static-commit, sticky header with session id, selectable themes)? residual' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const TUIGATE = 'bun run test:tui'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
rlmcode UI = opentui REACT (src/tui). The hardening + most UI maturity landed; FINISH the UI to opencode/claude_code grade. Gap-map: memory
opencode-ui-maturity-gaps (diff-viewer feature-plugins/system/diff-viewer.tsx:1059, Panel/Separator design-system, per-node token badge). Render
model (claude_code, from the design): SCROLLBACK IS IMMUTABLE → memoize SETTLED turns so only the in-flight turn + composer redraw (the static-
commit perf win); ANCHOR via flex; ref-driven scroll chrome (sticky header + "N new" pill via a context ref, NOT state).

TARGETS (all src/tui + toolui — I am on clean main, nothing else running, so no collision):
1. diff-viewer — toolui.ts renders edit/write diffs via the crude LCS preview; upgrade to the native opentui <diff> renderable (chat.tsx already
   imports <diff> for native diffs) WITH syntax highlight (the theme syntax-scope tokens that landed) + split/unified by terminal width (split >120,
   else unified) + line numbers. Replace the LCS preview for edit/write (keep a tiny fallback). Frame: mock an edit → a real syntax +/- diff.
2. polish — a reusable src/tui/ui/panel.tsx (Panel + Separator components) + adopt where chat.tsx/messages.tsx use ad-hoc bordered boxes; render a
   per-node TOKEN BADGE in the node-tree (orch-tree Row already carries tokens — show it dim, right-aligned on the node line, not only the Σ footer).
   Frame: a node line shows its token badge; a panel renders.
3. static-commit — memoize the SETTLED turns: React.memo (or useMemo) on TurnView keyed by (turn.idx + a settled-content hash) so a settled turn does
   NOT re-render every frame (only the in-flight turn + composer do). Pure presentational — NO logic/shape change. This is the claude_code perf model
   (don't repaint scrollback). Frame: render is unchanged (a settled turn still shows correctly); note the memo (a unit/assertion that a settled
   TurnView is referentially stable across a re-render is ideal, else assert the frame unchanged).
4. header-anchors — a ref-driven STICKY HEADER showing "rlmcode · session <id>" (the session id = active.id, matches the motel session.id span tag —
   the user wants it for tracking) at the top (flexShrink:0); + a "N new" pill (bottom-right, shown when scrolled up from bottom) driven by a context
   REF (not state — no re-render on scroll). Frame: the header shows "rlmcode · <session-id>"; (the pill is harder to frame — at least assert the
   header).

PRINCIPLES: opentui REACT (port opencode Solid→React; native <diff> from @opentui). KEEP Msg/OrchTree/session shapes + all logic (presentation +
perf only). theme tokens (no inline hex). chat.tsx <1000 lines (extract to src/tui/ files). ONE WORD vocab: node. Unavoidable any => 'ponytail:'.
Each step: ${CHECK} + ${LINT} green AND ${TUIGATE} green with a NEW captured-frame assertion (drive scripts/tui/driver.ts + RLM_MOCK). Commit each
--no-verify, Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT git add -A.

FLAKE DISCIPLINE: HARD GATE = ${CHECK}+${LINT}. A test:tui failure → re-run 3x; any pass ⇒ flaky, proceed, set flaky; only consistent-real = RED →
heal. Assert STABLE structure via waitFor (the diff hunks, the token badge text, the header text), NEVER a spinner glyph. Content/behavior, not glyphs.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'tuiMatureLanded', 'alreadyDone'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } },
    tuiMatureLanded: { type: 'boolean', description: 'has the concurrent tui-mature workflow LANDED (src/tui clean, its diff-viewer/polish committed or absent)?' },
    alreadyDone: { type: 'array', items: { type: 'string' }, description: 'which of diff-viewer/polish/static-commit/header-anchors are ALREADY implemented (skip them)' } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'flaky', 'frameProof', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, flaky: { type: 'boolean' },
    frameProof: { type: 'string', description: 'the captured test:tui frame proving the step renders — NOT compile-only; reproduced' },
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
const study = await agent(`Study the UI-finish targets in src/tui. HARD DEP: the concurrent tui-mature workflow was finishing its diff-viewer + polish steps — confirm it has LANDED (src/tui clean, no mid-flight work; set tuiMatureLanded=false to STOP if it's still writing). Then report which of diff-viewer/polish/static-commit/header-anchors are ALREADY implemented (tui-mature may have done diff-viewer + polish — list them in alreadyDone so we SKIP them; if its diff-viewer used the native <diff> and hunk is viable, a diff-viewer SWAP to hunk is still in scope). Read chat.tsx (transcript/TurnView/render loop, header, toBottom), toolui.ts (the diff — LCS or native? hunk?), orch-tree.ts (Row.tokens badge), shell.tsx (footer/ActionBar), theme.ts (syntax tokens), atoms (active.id = session id). + the gap-map (opencode-ui-maturity-gaps) + the claude_code static-commit/ref-chrome design. Cite file:line.\n\n${SPEC}`,
  { label: 'study', phase: 'Study', schema: FIND, agentType: 'Explore' })
if (!study || study.tuiMatureLanded === false) { log('tui-mature not landed (src/tui mid-flight) — STOP; run after it.'); return { stopped: 'tui-mature not landed', study } }
const STUDY = JSON.stringify(study, null, 1)
const done = new Set((study.alreadyDone || []).map(s => String(s).toLowerCase()))
log(`studied; tui-mature landed; alreadyDone: ${[...done].join(', ') || 'none'}`)

const FEATURES = [
  { key: 'diff-viewer', spec: `Upgrade the edit/write tool diff (toolui.ts) from the crude LCS preview to a real syntax-highlighted split/unified diff. PREFER modem-dev/hunk: npm 'hunkdiff' ships a lower-level OpenTUI component 'HunkDiffView' from "hunkdiff/opentui" (Hunk is built on OpenTUI — the SAME renderer as rlmcode). INVESTIGATE it first (WebFetch the repo/README + the hunkdiff/opentui export): does HunkDiffView embed cleanly in rlmcode's @opentui/REACT TUI (it may target @opentui/core, not react — check the renderer/JSX compat + whether bun add hunkdiff is sane)? IF viable → use HunkDiffView for the edit/write diff (syntax split/stack, the purpose-built native integration). ELSE fall back to the native opentui <diff> renderable (chat.tsx already imports it) + the theme syntax tokens + split/unified by width. Either way: replace the crude LCS preview for edit/write (keep a tiny fallback). test:tui: mock an edit tool → frame shows a real syntax-highlighted +/- diff. If hunk doesn't fit (renderer mismatch / heavy dep), say so in notes + use native <diff> — do NOT force a broken integration.` },
  { key: 'polish', spec: `New src/tui/ui/panel.tsx: a reusable Panel + Separator (theme-aware borders/padding). Adopt them where chat.tsx/messages.tsx use ad-hoc bordered boxes. Render a per-node TOKEN BADGE in the node-tree (orch-tree Row carries tokens; NodeRow shows it dim right-aligned on the node line, not only the Σ footer). test:tui: a node line shows its token badge (e.g. "3.1k") + a Panel renders.` },
  { key: 'static-commit', spec: `Memoize SETTLED turns: wrap TurnView in React.memo keyed by (turn.idx + a settled-content signal) so a settled turn does NOT re-render on every busy-tick frame — only the in-flight turn + composer redraw (the claude_code scrollback-immutable perf model). Pure presentational — NO Msg/logic change. Verify: the render is unchanged (a settled turn still shows) + ideally a unit asserting a settled TurnView is referentially stable across a re-render; else a frame proving a settled turn renders correctly after a new turn starts. tsc+lint+test:tui green.` },
  { key: 'header-anchors', spec: `A ref-driven STICKY HEADER (top, flexShrink:0) showing "rlmcode · session <id>" where <id> = the active session id (matches the motel session.id span tag — the user wants this for tracking). + a "N new" pill (bottom-right) shown when scrolled up from the bottom, driven by a context REF (not state — no re-render on scroll). test:tui: the header frame shows "rlmcode · " + the session id (assert the header text + the id pattern). Keep it minimal + theme-toned.` },
  { key: 'theme-support', spec: `MULTIPLE SELECTABLE THEMES (opencode/claude_code-grade), in src/tui. RUNS LAST so it migrates ALL theme.x readers (including any new ones the prior steps added). Steps:
(a0) CLEANUP theme.ts cruft a review flagged (fold into the registry refactor): (i) 'markdownCodeBlock' is ORPHANED — defined in ResolvedTheme + palette but the scope 'markup.raw.block' maps to markdownCode, so the token is never used → either map 'markup.raw.block' to markdownCodeBlock or delete the token. (ii) 'diffAddedBg'/'diffRemovedBg'/'diffContextBg' are DEAD — defined but never registered/used (grep confirms) → delete them or wire them to real diff row tints. (iii) 'DEFAULT_THEME' is exported as the palette OBJECT — change it to the registry NAME string and have the resolver resolve name→Theme (the opencode resolver pattern; this is REQUIRED for the registry anyway). Land these consistently with (a).
(a) REGISTRY — theme.ts: keep the CURRENT palette as the default theme (name it, e.g. 'rlmcode-dark') + add 2-3 curated dark palettes (e.g. a warm gruvbox-ish, a cool tokyonight-ish, a high-contrast) as named Theme objects. Every palette MUST be COMPLETE — same keys + syntax scopes as the current theme (grep 'theme\\.' + the SyntaxStyle scopes for the FULL key set; a missing key = a runtime crash). Export 'themes: Record<name, Theme>' + the ordered name list.
(b) REACTIVE — a React ThemeContext + useTheme() (returns the active Theme) + a setter (useThemeSwitcher or context setter) that updates BOTH React state (so components re-render) AND a module-level live 'active' ref via getTheme() (so the PURE non-component helpers that read theme — toolui.ts label/summary/preview, messages.tsx assistantFooter, any orch-tree pure fn — see the new palette on the re-render). Wrap the app root (chat.tsx/shell.tsx) in <ThemeProvider>. Migrate src/tui REACT components from 'import { theme }' to useTheme(); leave pure helpers reading getTheme()/the live ref. Default active = env RLM_THEME ?? persisted config ?? 'rlmcode-dark'.
(c) PICKER + PERSIST — a /theme command (slash + palette entry; reuse the keybind/palette registry) opening the existing DialogSelect (dialog-select.tsx) listing the theme names (current marked) → on select, switch LIVE + PERSIST the choice (a tiny config write — reuse the existing history/config file path or a small .rlmcode config json; keep it lazy — one key).
(d) test:tui (driver.ts + RLM_MOCK): open the /theme picker → frame lists >=2 theme names → select a different one → a frame shows the switch took (assert a STABLE structural signal: the picker lists the themes, and after select the active theme changed — e.g. the header/border/footer renders in the new palette's distinct color, or the picker re-opens showing the new current). Content/structure, not a spinner glyph.
KEEP Msg/OrchTree/session shapes + all logic. NO inline hex outside theme.ts. chat.tsx stays <1000 lines (ThemeProvider/useTheme live in theme.ts or a small src/tui/theme-context.tsx). Unavoidable any => ponytail:.` },
]

const results = []
// RESUME after the API-error abort: whfymxzwa + tui-finish's a107ad3 already LANDED these
// (committed dd38f80/a107ad3 diff-viewer, 6028236 polish, 11a7cb3 static-commit). Skip them — only
// header-anchors + theme-support genuinely remain.
const LANDED = new Set(['diff-viewer', 'polish', 'static-commit', 'header-anchors'])
for (const f of FEATURES) {
  if (budget.total && budget.remaining() < 90000) { log(`budget low — stop before ${f.key}`); break }
  if (LANDED.has(f.key) || done.has(f.key)) { log(`${f.key}: already landed — skip`); results.push({ step: f.key, status: 'skipped-landed', commit: null, flaky: false, frame: '', openBlockers: [] }); continue }
  phase(f.key)
  let impl = await agent(
    `Implement UI-finish step "${f.key}" in rlmcode src/tui (clean main, nothing else running). opencode/claude_code-grade, port Solid→React, real opentui API.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + ${LINT} green AND ${TUIGATE} green with a NEW captured-frame assertion (paste frameProof — reproduced, NOT compile-only). FLAKE DISCIPLINE (retry 3x, classify, set flaky). Self-heal up to ${MAX_HEAL}. Extract to src/tui/ files (don't grow chat.tsx). ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(tui): ${f.key} …'. Report sha/diff/check tail/frameProof/flaky/ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/${LINT}/${TUIGATE}). FLAKE DISCIPLINE: a PTY flake that passes on retry is NOT real. Fix + re-verify (stable frame), commit --no-verify.\nFAILING:\n${impl.checkOutput}\nFRAME:\n${impl.frameProof}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'grade', focus: `Is "${f.key}" opencode/claude_code-grade (real native diff w/ syntax / reusable Panel + token badge / settled-turn memo / sticky header w/ session id) — proven by a REAL reproduced frame, not compile-only/flake? Cite file:line + quote the frame.` },
    { k: 'safe', focus: `Msg/OrchTree/session shapes + logic UNCHANGED (presentation/perf only)? static-commit doesn't break a re-render (a settled turn still updates when needed)? theme tokens not inline hex? chat.tsx not grown? lint green, frames deterministic? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Demand a reproduced frame + grade. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: flaky=${impl ? impl.flaky : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real, re-verify (stable frame), AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + frame still real? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ step: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, flaky: impl ? impl.flaky : false, frame: impl ? (impl.frameProof || '').slice(0, 300) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Per step (diff-viewer/polish/static-commit/header-anchors): green? frame-proven (quote)? flaky? Then: is the UI now opencode/claude_code-grade — rich syntax diffs, reusable panels + per-node token badge, settled-turn memo (no scrollback repaint), a sticky header with the session id (motel-trackable)? residual / any RED.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { steps: results, report }
