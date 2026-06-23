export const meta = {
  name: 'tui-upgrade',
  description: 'IMPLEMENT the opencode-grounded ax2 TUI upgrade — each feature VERIFIED by a real captured-frame assertion via the tui-test-harness gate (scripts/tui/driver.ts + test:tui), NOT by human dogfood. P0 focus-capture model (the REAL focus fix) + IME defer; P1 context-tool grouping + LCS diffs + error cards; P2 theme tokens; and the CORE stream:true change that unblocks live thinking + streaming render. Sequential on main, each gated on tsc + lint + a NEW frame assertion (add the test, make it pass), self-heal + adversarial review, commit each. DEPENDS ON tui-test-harness (test:tui + driver must exist).',
  phases: [
    { title: 'Study',        detail: 'confirm the tui-test-harness driver/test:tui contract + re-read chat.tsx/toolui/atoms + the opencode plan items' },
    { title: 'focus-model',  detail: 'P0: captureFocus boolean (composer = DEFAULT owner not tyrant) — the real focus fix vs the BLURRED-reclaim hack' },
    { title: 'ime-defer',    detail: 'P0: double-defer plainText read on submit (CJK composition drops/doubles chars)' },
    { title: 'tool-grouping', detail: 'P1: collapse consecutive read/glob/grep into one "Explored N files" row (the flat-rendering fix)' },
    { title: 'lcs-diff',     detail: 'P1: real LCS line-diff (current toolDiff is crude, bails >120 lines)' },
    { title: 'error-cards',  detail: 'P1: red-border error tool card (not a dim summary)' },
    { title: 'theme',        detail: 'P2: extract theme.ts token object, sweep ~40 inline hex literals' },
    { title: 'streaming',    detail: 'CORE: stream:true + streamingForward + showThoughts → render live thinking (reasoning_content) + streamed reply tokens (opencode PacedMarkdown reference)' },
    { title: 'layout-copy',  detail: 'COPY opencode UX wholesale (memory opencode-ux-blueprint): sticky transcript + pinned composer + metadata/status row + assistant footer line + left-border message cards' },
    { title: 'node-tree-inline', detail: 'wire the orch node-tree INLINE-per-turn (opencode message-part pattern), conditional via computeShowOrch — not always at the transcript bottom' },
    { title: 'Report',       detail: 'frame-proof per feature; what is now headless-verified; streaming honest status' },
  ],
}

const CHECK = 'bun run check'
const TUIGATE = 'bun run test:tui'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
ax2 TUI upgrade, opencode-grounded (see memory tui-upgrade-plan + ../opencode/packages/tui). ax2 = opentui REACT (opencode is Solid —
patterns port, Solid mechanics do NOT). CRITICAL: this DEPENDS on tui-test-harness having shipped scripts/tui/driver.ts + a 'test:tui'
gate (headless terminal-control render + frame capture + mock AI). RE-CONFIRM that contract at Study; if it's NOT there, STOP (don't
reinvent it). Each feature here is verified by ADDING a frame-assertion test (drive the mock, capture the frame, assert) and making it
pass — the gate is ${CHECK} + 'bun run lint' + ${TUIGATE} green, NOT dogfood. That is the whole point: no more shipping broken TUI green.

ITEMS (from the plan; cite chat.tsx/toolui.ts/atoms.ts lines at Study — they may have shifted under the concurrent restructure):
- focus-model (P0): the landed "sticky BLURRED-event reclaim" is a TYRANT (composer rips focus back every steal → no real second owner). REPLACE with a captureFocus boolean: composer is the DEFAULT owner (reclaim on blur) UNLESS captureFocus is true (a modal/scroll-nav owns it). opencode: real focus follows a stack, Tab is VISUAL-only. Keep the visual Tab ring. FRAME TEST: mount→input focused; click row→still typable (reclaim); set a capture owner→composer does NOT steal.
- ime-defer (P0): submit() reads taRef.plainText synchronously → CJK drops/doubles last char. Double queueMicrotask before reading. (Hard to frame-test composition; assert the defer path + a normal submit still works.)
- tool-grouping (P1): group consecutive read/glob/grep/list steps into ONE collapsible "Explored N files / M searches" row; bash/edit/write stay individual. Presentational over t.steps, Msg shape UNCHANGED. FRAME TEST: mock a turn with 8 reads + 3 greps → frame shows ONE grouped row, expand → individual.
- lcs-diff (P1): replace the crude toolDiff (full-remove+full-add, bails >120 lines) with a real Myers/LCS line diff (tiny vendored fn, or raw before/after into opentui <diff>). FRAME TEST: mock an edit → frame shows real +/- hunks, no 120-line bail.
- error-cards (P1): error tool → red-border card (border:['left'] borderColor #f38ba8) not a dim summary. FRAME TEST: mock an error tool → frame shows the red border.
- theme (P2): extract src/theme.ts flat token object; sweep ~40 inline Catppuccin hex in chat.tsx → theme.x. No mode-switch yet. FRAME TEST: a render still shows the right colors (or at least renders unchanged) + grep proves no inline hex left in chat.tsx.
- streaming (CORE — the big one): ax2 is stream:false → no thinking/streaming render (reasoning_content thrown away, reply lands at once). Switch the turn to streamingForward (stream:true), render reasoning_content as a live THINKING block + reply tokens as they arrive (opencode PacedMarkdown is the reference). This touches agent.ts turn() + the de-double logic + atoms/chat.tsx render. FRAME TEST: mock streaming deltas + reasoning → frame shows the thinking block then streamed tokens appearing incrementally. This is a real core refactor — do it carefully, keep non-streaming fallback if a provider lacks it.

PRINCIPLES: pure-TUI items (focus/ime/grouping/diff/errors/theme) do NOT change orch.ts core or turn semantics. streaming DOES change core (turn()) — keep it isolated + behavior-safe. ONE-WORD vocab: node. Real opentui API. Unavoidable any => 'ponytail:'. Each feature: ${CHECK} + lint + ${TUIGATE} green (add the frame test, make it pass). Commit each --no-verify. Do NOT git add -A.

STALE-CHECK: the harness report says streaming may ALREADY be wired (agent.ts turn() stream:true + streamingForward). RE-CONFIRM at Study; if streaming is already in, the 'streaming' feature SHRINKS to just the render assertions (thinking block + incremental tokens) — do NOT re-refactor what's done.

FLAKE DISCIPLINE (CRITICAL — the test:tui PTY frame tests are TIMING-sensitive; do NOT thrash heal on flake):
- HARD GATE = the DETERMINISTIC checks: \`bun run check\` (tsc) + \`bun run lint\` (incl the in-process scripts/tui/mock.test deterministic unit). A failure here is REAL — fix it.
- The PTY frame tests (\`bun run test:tui\`, the 8 terminal-control tests) are a real-render confidence signal but can FLAKE for reasons that are NOT your code: frame-settle races (a waitFor polling before the cell-grid stabilizes), the spinner glyph cycling (⠋⠙⠹… — never byte-match it), an instant-mock landing a streamed reply inside one settle window, PTY startup jitter. The harness already uses frame-stable waitFor (never sleep-then-assert) — KEEP that; if you add a frame test, assert STABLE structure (connectors, gutter, the row text), NEVER a spinner frame or a byte-exact golden.
- On a test:tui failure: RE-RUN it up to 3× FIRST. If any attempt passes ⇒ FLAKY, not failing ⇒ proceed, set flaky=true, note it — do NOT heal, do NOT loosen the assertion to make a real bug pass. Only a CONSISTENT failure across all 3 (the frame genuinely lacks the asserted structure) counts as RED → heal.
- If a test is flaky because the ASSERTION is timing-fragile (matching a spinner / a mid-settle frame), FIX THE TEST to assert stable structure via waitFor — that is the correct fix, not a retry-forever. Distinguish: fragile-assertion (fix the test) vs real-missing-structure (fix the feature) vs transient-PTY-jitter (retry).
- NEVER mark a feature frame-proven on a flake: frameProof must be a STABLE captured frame reproduced across the retries.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'flaky', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'frameProof', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, flaky: { type: 'boolean' }, filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' }, checkOutput: { type: 'string' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' },
    frameProof: { type: 'string', description: 'the captured frame from the NEW test:tui frame assertion proving the feature renders right — NOT compile-only' },
    newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
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
  () => agent(`Confirm the tui-test-harness contract: read scripts/tui/driver.ts + the mock layer + the test:tui script in package.json. Report the EXACT driver API (frame/type/key/click/waitFor) + how to mount with mocked AI + mocked NodeEvents, so the upgrade's frame tests use it. If driver.ts / test:tui do NOT exist, say so clearly (this workflow must STOP — its dependency hasn't shipped). Cite file:line.\n\n${SPEC}`,
    { label: 'harness-contract', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Read src/chat.tsx (focus model + the BLURRED reclaim, the input, NodeView, transcript/tool rows), src/toolui.ts (toolDiff + tool rendering), src/atoms.ts (Msg/orch shapes), src/agent.ts (turn() + stream:false + the de-double comment). Report exact lines for each plan item (focus-model, tool-grouping, lcs-diff, error-cards, theme hex sites, streaming/turn). The concurrent restructure may have moved these — read current. Cite file:line.\n\n${SPEC}`,
    { label: 'ax2-current', phase: 'Study', schema: FIND, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/2`)
// hard dependency check
if (JSON.stringify(study).match(/do NOT exist|hasn't shipped|not found|no driver|missing/i)) {
  log("DEPENDENCY MISSING: tui-test-harness (driver.ts/test:tui) not shipped — STOPPING. Run tui-test-harness first.")
  return { stopped: "tui-test-harness dependency not shipped", study }
}

const FEATURES = [
  { key: 'focus-model', live: true, spec: `Replace the BLURRED-reclaim tyrant with a captureFocus boolean (composer = default owner; true → a modal/scroll owns, composer does NOT steal). Keep the visual Tab ring. ADD a test:tui frame test: mount→input focused; click a row→typing still lands (reclaim); with a capture owner set→composer does NOT reclaim. Make it pass.` },
  { key: 'ime-defer', live: false, spec: `Double queueMicrotask the plainText read in submit() (CJK fix). Frame-test the path doesn't break a normal submit (a plain "hi" still submits). ` },
  { key: 'tool-grouping', live: true, spec: `Group consecutive read/glob/grep/list steps into one collapsible "Explored N files / M searches" row (bash/edit/write individual). Msg shape unchanged. test:tui frame test: mock 8 reads + 3 greps → ONE grouped row; expand → individual rows.` },
  { key: 'lcs-diff', live: true, spec: `Real Myers/LCS line diff in toolui.ts (replace the crude full-block diff, remove the >120-line bail). test:tui frame test: mock an edit → real +/- hunks render, no bail.` },
  { key: 'error-cards', live: true, spec: `Error tool → red-border card (border left, #f38ba8). test:tui frame test: mock an error tool → frame shows the red border.` },
  { key: 'theme', live: true, spec: `Extract src/theme.ts flat token object; sweep ~40 inline Catppuccin hex in chat.tsx → theme.x (no mode switch). test:tui frame test: render unchanged colors; grep proves no inline hex left in chat.tsx.` },
  { key: 'streaming', live: true, spec: `CORE: switch turn() to streamingForward (stream:true); render reasoning_content as a live THINKING block + reply tokens incrementally (opencode PacedMarkdown reference); keep a non-streaming fallback. test:tui frame test: mock streaming reasoning+reply deltas → frame shows the thinking block THEN streamed tokens appearing across frames. STALE-CHECK FIRST: streaming may ALREADY be wired (agent.ts stream:true + streamingForward per the harness report) — if so this SHRINKS to the render assertions only, do NOT re-refactor. This is the highest-value + riskiest — isolate it, keep behavior safe.` },
  { key: 'layout-copy', live: true, spec: `COPY opencode's TUI UX wholesale into chat.tsx (see memory opencode-ux-blueprint — file:line for every piece; ax2 is opentui REACT, opencode is Solid → port patterns NOT Solid mechanics). Adopt: the scrollbox stickyScroll-bottom transcript + pinned composer (flexShrink:0) layout (index.tsx:1209-1412); the user-message left-border-colored card + assistant content paddingLeft=3 + the '▣ mode · model · duration' footer line (:1531-1637); the composer border + metadata row + bottom status row 'tokens (pct) · cost' / 'Cmd+K commands' (prompt/index.tsx:1403-1762); the footer dot-indicators (footer.tsx:52-91); toBottom() sticky scroll on submit/switch. Reuse the theme tokens (don't reintroduce inline hex). test:tui frame test: assert the new STABLE structure — pinned composer + status row + the assistant footer line + left-border message card — render in the captured frame. Keep behavior identical; this is presentation only.` },
  { key: 'node-tree-inline', live: true, spec: `WIRE the orch node-tree INLINE-PER-TURN, conditionally — render it inside the assistant turn that ran the workflow (like an opencode message-part), NOT always at the transcript bottom. Per memory opencode-ux-blueprint Option B: Turn type += workflow?:OrchTree; toTurns(messages, orch) attaches orch to the LAST turn when computeShowOrch(orch); TurnView renders {t.workflow && <WorkflowPart/>} after <ReplyView>; WorkflowPart = extract the existing chat.tsx:846-868 block (flatten + NodeRow map + orchSigma) into a component, reuse flatten/NodeRow/orchSigma/computeShowOrch as-is; per-node expand state useState(Set); Tab ring includes orch rows ONLY when a WorkflowPart is visible. NON-workflow turns must render NO tree. test:tui frame test: a mock workflow turn → the node tree renders INLINE under that turn's reply (├─ └─ connectors + Σ footer); a plain turn → NO orchestration block. Mirror opencode's PART_MAPPING dispatch (index.tsx:1556/1640).` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree, grounded in the study + the saved opencode plan.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + bun run lint green AND ${TUIGATE} green with a NEW frame assertion proving the feature (capture + paste the frame as frameProof — NOT compile-only). Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(tui): ${f.key} ...'. Report sha/diff/check tail/frameProof/new ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint/${TUIGATE} or no real frame). Fix + re-verify (real frame), commit --no-verify.\nFAILING:\n${impl.checkOutput}\nFRAME:\n${impl.frameProof}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'frame-proven', focus: `Is "${f.key}" verified by a REAL test:tui captured frame (frameProof shows the rendered text proving the feature — focus held / grouped row / real diff / red border / thinking+streamed tokens), not compile-only? Cite file:line + quote the frame.` },
    { k: 'safe', focus: `pure-TUI items don't change orch.ts core / turn semantics? streaming keeps a safe fallback + doesn't break non-streaming? single-turn + existing rendering intact? ONE-word vocab? lint green, test:tui deterministic? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Demand the real frame. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: ${blockers.length} blockers`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix, re-verify (real frame), AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + real frame? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, frameProof: impl ? (impl.frameProof || '').slice(0, 300) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Per feature: green/red, commit, and the captured FRAME proving it (quote it). (1) Is the TUI upgrade now FRAME-VERIFIED (focus-capture model real-fixes the focus bug? grouping/diff/errors/theme render right? streaming shows live thinking+tokens?). (2) Did streaming land safely (core change, fallback)? (3) anything only compile-verified or still needing human dogfood? Headline anything red.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
