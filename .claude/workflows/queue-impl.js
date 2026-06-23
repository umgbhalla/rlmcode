export const meta = {
  name: 'queue-impl',
  description: 'Implement a PROMPT QUEUE in rlmcode (send-while-busy → drain FIFO), the opencode/claude_code pattern rlmcode lacks. Today sendAtom runs a turn immediately + busy just disables the composer; there is NO queue. Add: a per-session queue; sendAtom ENQUEUES when a turn is in-flight (marks the user Msg queued); the turn-finish DRAINS the next queued prompt FIFO; the composer accepts send-while-busy (no block); a QUEUED badge renders on queued user messages; esc/delete can cancel a queued item. Touches src/tui (atoms/messages/composer/chat) + a src/core drain hook → MUST run AFTER tui-mature lands (it owns src/tui — re-confirm line refs at Study). Each step gated on tsc + lint + a NEW test:tui captured frame (send-while-busy → QUEUED → drains in order), flake-disciplined, adversarial review, commit each.',
  phases: [
    { title: 'Study',   detail: 'confirm the rlmcode current state post-tui-mature: atoms.ts (sendAtom, busyAtom/busySessionsAtom, Msg/SessionView), run.ts (runTurn .finally = the drain hook), messages.tsx (UserCard), composer.tsx (busy/disable), chat.tsx (submit). Pin the design (enqueue-if-busy, drain-FIFO-on-finish, QUEUED badge). HARD DEP: tui-mature must have landed (src/tui stable).' },
    { title: 'queue-core', detail: 'atoms.ts: a per-session prompt queue; sendAtom enqueues (+ marks the user Msg queued:true) when busySessions has the id, else runs; on turn-finish (the runTurn drain end) pop the next queued FIFO + run it. FIFO, single-in-flight per session, no races (Effect serializes). Unit-testable drain order.' },
    { title: 'queued-ui', detail: 'messages.tsx UserCard renders a QUEUED badge on queued msgs; composer.tsx accepts send-while-busy (stop disabling on busy — the queue absorbs it). test:tui frame: send a 2nd message mid-turn → it shows QUEUED → after the turn it drains + runs (badge clears, reply appears).' },
    { title: 'queue-cancel', detail: 'allow cancel of a queued (not-yet-running) prompt — esc/a key/click removes it from the queue + the transcript before it runs. test:tui: queue 2, cancel one → only the other drains.' },
    { title: 'Report',  detail: 'frame-proof: send-while-busy queues (QUEUED badge), drains FIFO, cancel works; before/after; residual' },
  ],
}

const CHECK = 'bun run check'
const LINT = 'bun run lint'
const TUIGATE = 'bun run test:tui'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
rlmcode = opentui REACT TUI on @ax-llm/ax. GOAL: a PROMPT QUEUE (send-while-busy → drain FIFO) — the opencode/claude_code pattern rlmcode lacks.

DESIGN (from the opencode + claude_code study):
- opencode: queue is implicit in message ordering + the backend drains; a pending() memo marks any message after the in-flight one as QUEUED
  (a colored badge); the composer never blocks.
- claude_code: a messageQueueManager FIFO deque + a single queryLoop coordinator that dequeues → runs the query to terminal → loops (the loop IS
  the drain; one in-flight per session).
- rlmcode TODAY (re-confirm at Study — tui-mature may have shifted lines): NO queue. atoms.ts sendAtom appends the user Msg + runs runTurn
  immediately; busyAtom/busySessionsAtom guard; the composer is DISABLED while busy (so you can't even send). run.ts runTurn's .finally (~219-225)
  closes the per-turn queue — the clean TURN-FINISH hook. Msg union has kind:"you".

IMPLEMENT (the behavior — pick the cleanest fit; two viable patterns):
  PATTERN A (recursive drain, simplest, fits sendAtom): sendAtom — if busySessions.has(id) → push text to a per-session queue Map + append the
    user Msg with queued:true (do NOT start a turn); else append + run as today. At the END of the runTurn drain (in sendAtom, after the for-await),
    instead of just clearing busy: pop the next queued prompt FIFO and run IT (recurse), clearing busy only when the queue is empty. Clear the popped
    Msg's queued flag when it starts.
  PATTERN B (coordinator, more robust): a per-session drainer fiber pulls from an AsyncQueue + runs runTurn in a loop FIFO; sendAtom just pushes;
    busy is derived from "queue non-empty or in-flight". Mirrors claude_code.
  Either is fine — FIFO, exactly ONE turn in-flight per session, no lost prompts on a fast finish, no double-start race. Msg += readonly queued?:boolean
  (and an id if needed for cancel). The composer must ACCEPT send-while-busy (remove the busy-disable; the queue absorbs it). messages.tsx UserCard
  renders a QUEUED badge (a small colored pill, theme.warning/accent bg) when queued. Cancel: a queued (not-yet-running) prompt can be removed (esc
  on the composer when a draft is empty + the last msg is queued, or a key/click) → drop from the queue + the transcript.

KEEP: the turn loop, runTurn, the orch/streaming render, Msg/SessionView shapes (only ADD queued?). Interrupt (esc-twice) still aborts the
IN-FLIGHT turn; decide queue behavior on abort (keep the queue, or drop it — keep is friendlier; document the choice). No double-start, no lost
prompt, no race (Effect atoms serialize — note it).

PRINCIPLES: opentui REACT. ONE WORD vocab: node. chat.tsx <1000 lines (extract if needed). theme tokens (no inline hex). Unavoidable any =>
'ponytail:'. Each step: ${CHECK} + ${LINT} green AND ${TUIGATE} green with a NEW captured-frame assertion (drive scripts/tui/driver.ts + RLM_MOCK;
use RLM_MOCK_DELAY_MS to hold a turn busy so you can send-while-busy + observe the QUEUED badge + the drain). Commit each --no-verify with
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Do NOT git add -A.

FLAKE DISCIPLINE: HARD GATE = ${CHECK} + ${LINT} (deterministic). A test:tui failure → re-run 3x; any pass ⇒ flaky, proceed, set flaky; only a
CONSISTENT failure = RED → heal. Assert STABLE structure (the QUEUED text, the drained reply) via waitFor, never a spinner glyph. Assert content/
behavior, not decorative glyphs. The send-while-busy timing needs RLM_MOCK_DELAY_MS to hold the first turn — wait for the QUEUED frame via waitFor.
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites', 'tuiMatureLanded'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } }, tuiMatureLanded: { type: 'boolean' } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'flaky', 'frameProof', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, flaky: { type: 'boolean' },
    frameProof: { type: 'string', description: 'the captured test:tui frame proving send-while-busy → QUEUED → drain — NOT compile-only' },
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
const study = await agent(`Study the queue implementation targets in rlmcode (post-tui-mature). Read atoms.ts (sendAtom ~255-320, busyAtom/busySessionsAtom ~77-81, Msg/SessionView), run.ts (runTurn .finally ~219-225 = the turn-finish drain hook, TurnQueue), messages.tsx (UserCard), composer.tsx (the busy-disable), chat.tsx (submit). Confirm the cleanest enqueue + drain hook + where the QUEUED badge + the send-while-busy change go. HARD DEP: confirm tui-mature has LANDED (src/tui stable, no half-applied UI work) — set tuiMatureLanded. Cite file:line.\n\n${SPEC}`,
  { label: 'study', phase: 'Study', schema: FIND, agentType: 'Explore' })
if (!study || study.tuiMatureLanded === false) { log('tui-mature not landed (src/tui unstable) — STOP; run after it.'); return { stopped: 'tui-mature not landed', study } }
const STUDY = JSON.stringify(study, null, 1)
log('studied; tui-mature landed — proceeding')

const FEATURES = [
  { key: 'queue-core', spec: `atoms.ts: add a per-session prompt queue + wire sendAtom to ENQUEUE when busySessions.has(id) (push the text + append the user Msg with queued:true, do NOT start a turn) else run as today; and DRAIN on turn-finish — at the end of the runTurn for-await in sendAtom, pop the next queued prompt FIFO and run it (clear its queued flag when it starts), clearing busy only when the queue empties. FIFO, exactly one in-flight per session, no lost prompt on fast finish. Msg += readonly queued?:boolean. Decide abort behavior (keep the queue on esc-interrupt — document). Add a unit test (scripts/queue-*.test.ts): enqueue 3 while busy → they drain in FIFO order. tsc+lint green. commit.` },
  { key: 'queued-ui', spec: `messages.tsx UserCard: render a QUEUED badge (small colored pill, theme.warning/accent bg + theme.background fg, bold) when the Msg is queued. composer.tsx: ACCEPT send-while-busy — remove the busy-disable so a 2nd message can be sent (the queue absorbs it); keep the busy spinner/status. test:tui frame (RLM_MOCK_DELAY_MS to hold turn 1 busy): type+send msg1 → busy; type+send msg2 mid-turn → msg2 shows QUEUED; after turn1 finishes → msg2 drains (QUEUED clears, its reply appears). Assert the QUEUED text appears then the drained reply. tsc+lint green. commit.` },
  { key: 'queue-cancel', spec: `Allow cancelling a QUEUED (not-yet-running) prompt: e.g. esc when the composer draft is empty and the last message is queued (or a key/click on the queued row) removes it from the queue + the transcript before it runs. Don't break the existing esc (interrupt/back) semantics — scope the cancel to "a queued tail exists + empty draft". test:tui: queue 2 mid-turn, cancel one → only the other drains. tsc+lint green. commit.` },
]

const results = []
for (const f of FEATURES) {
  if (budget.total && budget.remaining() < 90000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.key)
  let impl = await agent(
    `Implement queue step "${f.key}" in rlmcode src/tui (+ the src/core drain hook if needed), grounded in the study + the design. opencode/claude_code-grade, no races.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + ${LINT} green AND ${TUIGATE} green with a NEW captured-frame assertion (paste frameProof, reproduced, NOT compile-only). FLAKE DISCIPLINE (retry 3x, classify, set flaky). Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'feat(tui): queue ${f.key} …'. Report sha/diff/check tail/frameProof/flaky/ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/${LINT}/${TUIGATE}). FLAKE DISCIPLINE: a PTY flake that passes on retry is NOT real. Fix + re-verify (stable frame), commit --no-verify.\nFAILING:\n${impl.checkOutput}\nFRAME:\n${impl.frameProof}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'queue-correct', focus: `Does the queue WORK — send-while-busy enqueues (QUEUED badge, proven by frame), drains FIFO in order, exactly one turn in-flight, no lost prompt on a fast finish, no double-start race? Quote the frame. Reject compile-only / flake-pass. Cite file:line.` },
    { k: 'safe', focus: `Msg/SessionView shapes only ADDED queued (not broken)? turn loop/runTurn/streaming intact? esc interrupt still aborts the in-flight turn (queue behavior documented)? composer send-while-busy doesn't break submit? lint green, frames deterministic, chat.tsx not grown? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed queue "${f.key}". Demand a reproduced frame + correct FIFO/no-race. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: flaky=${impl ? impl.flaky : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in queue "${f.key}". Fix for real, re-verify with a stable frame, AMEND commit.\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.key, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review queue "${f.key}"; blockers closed + frame still real? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.key, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ step: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, flaky: impl ? impl.flaky : false, frame: impl ? (impl.frameProof || '').slice(0, 320) : '', openBlockers: blockers })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown) on the prompt queue. Per step (queue-core/queued-ui/queue-cancel): GREEN? frame-proven (quote — send-while-busy → QUEUED → drains FIFO)? flaky? Then: does rlmcode now queue prompts like opencode/claude_code (send-while-busy, FIFO drain, QUEUED badge, cancel) with no races? residual / any RED.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { steps: results, report }
