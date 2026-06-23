export const meta = {
  name: 'rate-limit-visible',
  description: 'Make rate-limit (HTTP 429 — the MOST COMMON error here) VISIBLE in the UI during the retry, not just on exhaustion. Today orch-resilience classifies 429 as transient + retries with exponential backoff but emits NO UI signal — the node/turn sits "thinking…" silently while it backs off, indistinguishable from the crawl/hang; only when retries EXHAUST does "✗ rate_limited 429" render. Add: a retry/backoff NodeEvent (cause + attempt N/M + the backoff Ns) emitted during the retry so the node row + the composer status SHOW "⏳ rate-limited · retry 2/5 · 4s" live; and a clear main-turn 429 surface (status + ErrorCard wording). Touches src/core (orch-resilience emit + main-turn path) + src/tui (render) → run AFTER tui-mature + turn-harden land (collision). Frame-gated (mock a 429-then-recover → assert the rate-limit text shows DURING retry), adversarial review, commit each.',
  phases: [
    { title: 'Study',   detail: 'HARD DEP: tui-mature + turn-harden landed. Read orch-resilience.ts (withRetry classify/backoff — where to emit), run.ts/agent.ts (the node onEvent + the main-turn 429 path), orch-tree.ts/atoms (NodeEvent/Row), the composer status, mock.ts (the rate_limited fixture — extend for a retry-then-recover). Pin where the retry signal emits + renders.' },
    { title: 'emit-retry', detail: 'src/core: thread the node onEvent into withRetry so a transient (429) retry emits a "retrying" signal (cause + attempt + backoff ms) BEFORE the backoff sleep; the node carries a "rate-limited, retry N/M" status while backing off. Main-turn 429 surfaces too (status/partial).' },
    { title: 'render', detail: 'src/tui: the node row renders the retry status ("⏳ rate-limited · retry 2/5 · 4s") while retrying; the composer status shows a rate-limit note when the active turn/node is backing off; a terminal 429 stays the clear "✗ rate_limited 429" / ErrorCard. Frame test: mock a 429-then-recover node → the tree shows the retry status DURING, then ✓ on recover.' },
    { title: 'Report',  detail: 'frame-proof: a 429 is now visible DURING retry (not silent); terminal 429 clear; before/after; residual' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const TUIGATE = 'bun run test:tui'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
rlmcode → CF Kimi. The MOST COMMON error is HTTP 429 (rate-limit, esp under concurrent load). CURRENT: orch-resilience.ts withRetry classifies
429 as TRANSIENT → retries with exponential backoff, but emits NO activity/NodeEvent during the retry — so a retrying node/turn shows only a silent
"thinking…"/spinner (indistinguishable from the crawl). Only on retry EXHAUSTION does a terminal "✗ rate_limited 429" render (mock.ts proves the
terminal render; the live render exists for a failed node/turn). GAP: the RETRY itself is invisible.

GOAL: make the rate-limit VISIBLE DURING the retry. (1) src/core: emit a retry signal — when withRetry catches a transient error (429/5xx/network/
timeout), BEFORE the backoff sleep, emit a NodeEvent/activity carrying {cause (e.g. "rate_limited 429"), attempt N, max M, backoffMs} on the node's
id; so the live tree/status can show "rate-limited, retrying". Thread the node's onEvent into withRetry (it currently doesn't have it — see how runNode/
node passes onEvent). The MAIN turn's 429 (the bare streamingForward path, post turn-harden) should also surface a clear status (it may not go through
withRetry — if ax retries internally, at least surface the final 429 as a clear ErrorCard "rate limited (429) — CF is throttling; retry"). (2) src/tui:
render it — the node row shows "⏳ rate-limited · retry 2/5 · 4s" while backing off (a distinct glyph/tone, theme.busy/warning); the composer status
shows a rate-limit note when the active node/turn is in backoff; a terminal 429 keeps the clear "✗ rate_limited 429" + ErrorCard wording.

STRICT TIMING: touches src/core (orch-resilience/run.ts/agent.ts) + src/tui (orch-tree/atoms/messages/composer) → MUST run AFTER tui-mature +
turn-harden land (HARD DEP at Study — STOP if mid-flight). Otherwise clobber.

PRINCIPLES: minimal. The retry signal must NOT change the retry LOGIC (just observe + emit). Keep the OrchTree/Msg shapes (add a retry/status field if
needed). ONE WORD vocab: node. theme tokens (no inline hex). Unavoidable any => 'ponytail:'. Each step: ${CHECK} + ${LINT} green AND (render step)
${TUIGATE} green with a NEW captured-frame assertion. FLAKE DISCIPLINE: retry 3x, classify, only consistent-real = RED; assert content/structure not
glyphs. Commit each --no-verify, Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT git add -A.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'depLanded'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } }, depLanded: { type: 'boolean' } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'flaky', 'frameProof', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, flaky: { type: 'boolean' },
    frameProof: { type: 'string', description: 'the captured frame/unit proving the 429 retry is visible DURING retry — not compile-only' },
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
const study = await agent(`HARD DEP CHECK + map. Confirm tui-mature + turn-harden LANDED (src clean — set depLanded=false to STOP if not). Then read orch-resilience.ts (withRetry classify + backoff — where/whether it has onEvent), run.ts + agent.ts (how runNode/node pass onEvent; the main-turn streamingForward 429 path post turn-harden), atoms.ts/orch-tree.ts (NodeEvent kinds + Row — where a "retrying" status would live), the composer status (chat.tsx), messages.tsx ErrorCard, mock.ts (the rate_limited fixture — how to mock a 429-then-recover for the frame test). Report exactly where the retry signal emits + how it renders. Cite file:line.\n\n${SPEC}`,
  { label: 'study', phase: 'Study', schema: FIND, agentType: 'Explore' })
if (!study || study.depLanded === false) { log('tui-mature/turn-harden not landed — STOP; run after.'); return { stopped: 'src workflows not landed', study } }
const STUDY = JSON.stringify(study, null, 1)
log('studied; deps landed — proceeding')

const STEPS = [
  { key: 'emit-retry', live: false, spec: `src/core: thread the node's onEvent into withRetry (orch-resilience.ts) so on a TRANSIENT catch (429/5xx/network/timeout), BEFORE the backoff sleep, it emits a retry signal (a NodeEvent/activity carrying the cause string e.g. "rate_limited 429", attempt N, max M, backoffMs) on the node id — WITHOUT changing the retry logic (observe + emit only). The main-turn 429 path (post turn-harden) surfaces the final 429 clearly. VERIFY (unit): a node that throws a 429 twice then succeeds → the retry signal fires per attempt (cause+attempt captured), the node still recovers. tsc+lint green. commit.` },
  { key: 'render', live: true, spec: `src/tui: render the retry signal — the node row (orch-tree/NodeRow) shows "⏳ rate-limited · retry 2/5 · 4s" (distinct glyph + theme.busy/warning tone) while backing off; the composer status shows a rate-limit note when the active node/turn is retrying; a TERMINAL 429 keeps the clear "✗ rate_limited 429" + a plain ErrorCard wording ("rate limited (429) — CF throttling"). test:tui frame: mock a node that 429s-then-recovers (extend mock.ts) → the tree shows the rate-limited RETRY status DURING, then ✓ on recover; AND a terminal-429 node shows ✗ rate_limited 429. tsc+lint green. commit.` },
]

const results = []
for (const f of STEPS) {
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Implement "${f.key}" (rate-limit visibility), grounded in the study. Make the most-common error (429) VISIBLE during retry.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + ${LINT} green${f.live ? ` AND ${TUIGATE} green with a NEW captured-frame assertion (paste frameProof — reproduced, NOT compile-only)` : ' AND a unit verification (paste it as frameProof)'}. FLAKE DISCIPLINE (retry 3x, classify, set flaky). Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat: rate-limit-visible ${f.key} …'. Report sha/diff/check tail/frameProof/flaky/ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED. FLAKE DISCIPLINE applies. Fix + re-verify, commit --no-verify.\nFAILING:\n${impl.checkOutput}\nFRAME:\n${impl.frameProof}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'really-visible', focus: `Is the 429 retry now VISIBLE DURING the retry (not just on exhaustion) — proven by the frame/unit (the "rate-limited · retry N" shows while backing off, then recovers)? Reject compile-only/flake. The retry LOGIC unchanged (observe+emit only)? Cite file:line + quote the frame.` },
    { k: 'safe', focus: `OrchTree/Msg shapes intact (only added a retry status)? retry behavior unchanged? terminal 429 still clear? src touched matches the plan (no stray)? theme tokens, lint green, frames deterministic? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
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
      agent(`Re-review "${f.key}"; blockers closed + still visible/verified? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ step: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, flaky: impl ? impl.flaky : false, frame: impl ? (impl.frameProof || '').slice(0, 300) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). Per step (emit-retry, render): green? proven (the 429 retry is now visible DURING retry — quote)? flaky? Then: is rate-limit (the most common error) now VISIBLE — a retrying node shows "rate-limited · retry N", not a silent spinner; a terminal 429 is clear? residual.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { steps: results, report }
