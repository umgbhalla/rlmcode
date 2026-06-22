export const meta = {
  name: 'tui-test-harness',
  description: 'Kill the no-headless-TUI-verification spiral: build a HEADLESS ax2 TUI test harness on kitlangton/terminal-control (vendored at vendor/terminal-control) + a deterministic MOCK-AI/mock-data layer, then in-depth tests that drive the real chat.tsx — assert focus, the unicode node tree, tools-under-node, thinking/streaming render, tool grouping, error cards — by capturing rendered frames + injecting keys/mouse. Wire a `test:tui` gate so TUI regressions are caught in CI, not by a human eyeballing bun run chat. Sequential on main, self-heal to green + adversarial review, commit each.',
  phases: [
    { title: 'Study',     detail: 'terminal-control API (vendor/terminal-control + git@github.com:kitlangton/terminal-control.git): how to drive an opentui render headlessly, capture frames, inject keys/mouse; + ax2 chat.tsx mount points + where to inject a mock AI' },
    { title: 'mock',      detail: 'deterministic MOCK layer: a fake AxAIService (canned reply + reasoning_content + streaming deltas + tool calls/results), mock orch-node/activity feed, AX2_MOCK hook to mount the app with NO Cloudflare' },
    { title: 'harness',   detail: 'render chat.tsx under terminal-control into a virtual terminal; capture the text frame; simulate input (type/enter/tab/click); a reusable driver (scripts/tui/driver.ts)' },
    { title: 'tests',     detail: 'in-depth headless TUI tests: focus (mount/blur/click/tab), unicode node tree + tools-under-owning-node + rolling window, thinking + streaming render, context-tool grouping, error cards' },
    { title: 'gate',      detail: 'wire test:tui into package.json (+ lint or a separate gate); deterministic, green; document that this REPLACES manual-only TUI verification' },
    { title: 'Report',    detail: 'what is now headless-verifiable (focus/tree/streaming/...), captured-frame proof, what still needs a human' },
  ],
}

const CHECK = 'bun run check'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
ax2 = opentui React TUI on @ax-llm/ax (CF Kimi). THE PROBLEM: the TUI is NOT headless-verifiable — every render/focus bug (stranded input
focus, tools rendering under the wrong node, flat tree, no thinking/streaming state) was caught ONLY by a human running bun run chat. The
gate (tsc + yuku static analysis + tests) can't see a rendered frame. This is the root of the whole quality spiral.

THE FIX: kitlangton/terminal-control (git@github.com:kitlangton/terminal-control.git, ALREADY VENDORED at vendor/terminal-control via a
git subtree — use the vendored copy; clone the git repo read-only only if the vendored copy lacks docs/examples) is a terminal driver by
the SAME author as opentui + motel — it can render/drive a terminal UI headlessly, capture the output frame, and inject input. Use it to
build a real TUI test gate.

REQUIREMENTS:
1. STUDY terminal-control's actual API at vendor/terminal-control (+ its examples/tests): the EXACT mechanism to (a) render an opentui app
   to a virtual/headless terminal (in-process renderer vs PTY-driving a subprocess — pick what terminal-control + opentui support; opentui
   has a testing surface too — packages/core/src/testing.ts — combine if cleaner), (b) capture the rendered text frame (the cell grid as
   text), (c) inject input: typed text, Enter, Tab, Esc, arrow keys, and MOUSE clicks at a cell. Confirm by RUNNING a trivial render+capture
   before building on it. Do NOT invent the API — read it.
2. MOCK LAYER (deterministic, NO Cloudflare): a fake AxAIService that returns canned, deterministic responses — including reasoning_content
   (thinking), streaming deltas, tool_calls + results — so the harness drives the real chat/turn/orch UI with zero network. Add a minimal
   hook (e.g. AX2_MOCK=1 env, OR a test-only mount that injects the fake ai) to mount the app/components against the mock. Also a mock
   orch-node / activity feed so the orch tree can be rendered from canned NodeEvents. Keep the mock SMALL + deterministic.
3. HARNESS: scripts/tui/driver.ts — mount chat.tsx (or the renderable tree) under terminal-control's headless renderer with the mock,
   expose { frame(): string (current rendered text), type(s), key(name,mods?), click(x,y), waitFor(predicate) }. Reusable by all tests.
4. IN-DEPTH TESTS (scripts/tui/*.test.ts, assert against captured frames — match the repo's assert-fixture style):
   - FOCUS: on mount the input is focused (highlight in frame); click a transcript row → assert focus behavior per the captureFocus model
     (composer reclaims unless a capture owner is active); Tab → visual ring moves but typing still lands in the input; after send, input
     stays focused. (This is the bug that shipped "green" + was broken — it MUST be a real frame assertion now.)
   - NODE TREE: feed mocked parallel orch nodes + per-node tool events → assert the frame shows UNICODE tree connectors (├─ └─ │), each
     node's tools nested UNDER that node (not the main transcript), and the velocity rolling-window (last N + "+M more").
   - THINKING + STREAMING: feed mocked reasoning_content + streaming deltas → assert the frame renders the thinking state + streamed tokens
     (if streaming isn't wired yet, assert the CURRENT behavior + leave a clear TODO test that will pass once stream:true lands — do NOT fake it).
   - TOOL GROUPING + ERROR CARDS: mocked read/glob/grep cluster → grouped row; mocked error tool → red-border card.
5. GATE: add "test:tui" to package.json running scripts/tui/*.test.ts; wire into bun run lint OR a documented separate gate (if it needs a
   pseudo-TTY that CI lacks, make it a separate "test:tui" + note it in CLAUDE.md). Deterministic — NO flake (no real timers/network; use the
   terminal-control frame-stable wait, not setTimeout-then-assert — the de-flake lesson).

PRINCIPLES: the harness + mock are TEST infra (scripts/tui/ + a tiny mock hook) — do NOT change orch.ts (5 prims) or core turn behavior;
the mock-AI hook must be a NARROW test-only seam (off in production). Match style. Real APIs only (terminal-control + opentui — read them).
ONE-WORD vocab: node. Unavoidable any => 'ponytail:' + 'Upgrade:'. ${CHECK} + bun run lint green. Commit each feature --no-verify. Do NOT
git add -A (untracked files + vendor/ exist — stage only your files).
`

const FIND = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const IMPL = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'frameProof', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' },
    checkOutput: { type: 'string' }, committed: { type: 'boolean' }, commitSha: { type: 'string' },
    frameProof: { type: 'string', description: 'a captured rendered frame (or test output) proving the harness/test actually renders + asserts — NOT compile-only' },
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
  () => agent(`Study vendor/terminal-control (kitlangton/terminal-control) — read its src + examples + tests + README. Report the EXACT API to: render a terminal UI headlessly, capture the rendered frame as text, and inject typed text / named keys / mouse clicks. State whether it drives in-process or via a subprocess/PTY, and how it integrates with opentui (check opentui packages/core/src/testing.ts too). Prove it by noting a minimal render+capture snippet that actually exists. Cite file:line. Do NOT invent.\n\n${SPEC}`,
    { label: 'terminal-control', phase: 'Study', schema: FIND, agentType: 'Explore' }),
  () => agent(`Read src/chat.tsx (createRoot/createCliRenderer mount, the App, the input/textarea, the transcript+NodeView, keyboard) + src/agent.ts (the llm AxAIService construction in runtime.ts, the turn path) + src/atoms.ts (activity sink, orch tree, Msg). Report: the mount entry, where a MOCK AxAIService could be injected (a test-only seam — env flag or a mountable component), how NodeEvents/activities feed the UI (so a mock feed can drive the orch tree), and which renderables show focus/thinking/streaming. Cite file:line.\n\n${SPEC}`,
    { label: 'ax2-mount', phase: 'Study', schema: FIND, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/2`)

const FEATURES = [
  { key: 'mock', title: 'mock',
    spec: `Build the deterministic MOCK layer (NO Cloudflare). A fake AxAIService (or a mock gen) returning canned, deterministic output: a reply, reasoning_content (thinking), streaming deltas, and a scripted tool_calls→results sequence — enough to drive the chat/turn + orch UI with zero network. A NARROW test-only seam to mount the app/components with it (prefer an explicit mount fn the harness calls, OR an AX2_MOCK env read in runtime.ts that swaps llm for the mock — off in prod). Plus a mock orch-node/activity feed (canned NodeEvents) so the orch tree renders deterministically. Keep it small. ${CHECK} + lint green; the mock must be importable + return deterministic data (a tiny headless test of the mock itself, no terminal-control yet). commit.` },
  { key: 'harness', title: 'harness',
    spec: `Build scripts/tui/driver.ts on terminal-control (per study): mount chat.tsx (or the renderable tree) under its headless renderer with the mock layer, and expose a reusable driver: frame():string (rendered cells as text), type(s), key(name, mods?), click(x,y), waitForFrame(predicate, deadline) (frame-stable wait — NOT setTimeout-then-assert). PROVE it: a smoke that mounts, captures the initial frame, asserts the input/prompt is present in the frame. Report the captured frame as frameProof. ${CHECK} + lint green. commit.` },
  { key: 'tests', title: 'tests',
    spec: `Write the in-depth TUI tests (scripts/tui/*.test.ts) using the driver + mock, asserting captured frames: (1) FOCUS — mount→input focused; click a row→reclaim per captureFocus; Tab→visual ring + typing still lands; post-send input focused. (2) NODE TREE — mocked parallel nodes+tools → unicode connectors (├─└─│) + tools nested under owning node + rolling window (+M more). (3) THINKING+STREAMING — mocked reasoning+stream → assert rendered (if stream:true not wired, assert current + a TODO/skip test for post-streaming, do NOT fake). (4) tool grouping + error cards. Each test captures + asserts a real frame. Report the captured frames as frameProof. ${CHECK} + lint green. commit.` },
  { key: 'gate', title: 'gate',
    spec: `Wire it as a gate: add "test:tui" to package.json running scripts/tui/*.test.ts; integrate into bun run lint if it runs without a real TTY, ELSE keep it a separate "test:tui" + document in CLAUDE.md why (needs a pseudo-TTY). Ensure DETERMINISTIC (no real timers/network; frame-stable waits). Run test:tui 10x — must be 10/10 green (the de-flake standard). Update CLAUDE.md: the TUI is now headless-testable via test:tui — describe how to add a TUI test. ${CHECK} + lint + test:tui green. commit.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.title)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree, grounded in the study (real terminal-control + opentui API only — no invented calls).\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} + bun run lint green. PROVE it renders/asserts a real frame (frameProof) — NOT compile-only. Self-heal up to ${MAX_HEAL}. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'test(tui): ${f.key} ...'. Report sha/diff/check tail/frameProof/new ponytails. Do NOT git add -A.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint or no real frame). Fix + re-verify (capture a real frame), commit --no-verify.\nFAILING:\n${impl.checkOutput}\nFRAME:\n${impl.frameProof}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'really-renders', focus: `Does it ACTUALLY render + capture a real frame via terminal-control (frameProof shows rendered text, not a stub/mock-of-the-renderer)? Are the focus/tree/streaming assertions on the REAL captured frame? Reject compile-only or fake-renderer proofs. Cite file:line + quote the frame.` },
    { k: 'deterministic-narrow', focus: `Deterministic (no real timers/network — frame-stable waits, mock AI)? Is the mock seam test-ONLY (off in prod, no core behavior change)? core untouched (orch.ts 5 prims, turn())? ONE-word vocab? lint green, no flake? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Skeptical — demand a real captured frame. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: ${blockers.length} blockers`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}". Fix for real, re-verify (real frame), AMEND commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + real frame? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nFRAME:\n${impl ? impl.frameProof : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, frameProof: impl ? (impl.frameProof || '').slice(0, 400) : '', openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown). (1) Does ax2 now have a HEADLESS TUI test gate on terminal-control + mocked data? quote a real captured frame from a test. (2) Which bugs are now headless-catchable that weren't (focus, tree, tools-under-node, thinking/streaming, grouping, error cards)? (3) test:tui deterministic + 10/10 green? wired into the gate or separate (why)? (4) mock seam is test-only, core untouched? (5) what STILL needs human dogfood (if anything). Headline anything red or only compile-verified.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
