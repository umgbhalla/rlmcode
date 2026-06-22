export const meta = {
  name: 'orch-node-render',
  description: 'Fix orchestration tree RENDERING correctness: (1) per-node tool routing — each leaf node owns its tools, so a sub-agent\'s tool events attach to ITS node, NOT the main outer transcript (today the global liveLogger dumps every leaf\'s tools into the main message list); (2) NodeView redesign — each node independently EXPANDABLE, showing its owned tools + child nodes + per-node meta (model · tokens · tools · time), a master-detail subtree like the workflow viewer. GATE = real CF-Kimi run, not tsc. Sequential on main, study-grounded, live-verified, commit each.',
  phases: [
    { title: 'Study',     detail: 'tool routing (global liveLogger → main transcript), atoms node/tool reducers, NodeView render, nodeId-bound logger path; + RE-CONFIRM which of the 6 review findings still exist (exceed may have self-fixed some)' },
    { title: 'telemetry', detail: 'reasoning-token capture + prompt size + TIMING events + SPAN granularity (run_rlm/orchestrate internals → child spans, tracer threaded into RLM forward) — kill the opaque black box' },
    { title: 'focus-sticky', detail: 'sticky blur→refocus input fix (the composer focus bug); MUST be human-verified in bun run chat' },
    { title: 'cleanup',   detail: 'fix ONLY the residual review findings exceed did not self-fix: delta-corrupts-result, sessionsRT leak, nudge-token undercount + double usageOf, LeafOpts→NodeOpts vocab, dead max-steps string-match, RLM 120s timeout, run_rlm [object Object] serialize' },
    { title: 'tool-routing', detail: 'per-node nodeId-bound logger: a node\'s ax tool events attach to ITS node in the OrchTree, not the main message list (fixes the tool-orphaning finding)' },
    { title: 'node-render', detail: 'NodeView redesign: per-node expand showing owned tools + child nodes + meta (model·tokens·tools·time), master-detail unicode tree + velocity rolling window' },
    { title: 'Report',    detail: 'live proof: each node\'s tools render UNDER its own node, each node expandable; residual findings cleared' },
  ],
}

const CHECK = 'bun run check'
const LIVE = 'AX2_LIVE=1 bun --env-file=.env scripts/orch-live.test.ts'
const MAX_HEAL = 5
const MAX_HARDEN = 2

const SPEC = `
ax2 orchestration TUI (opentui React, src/chat.tsx) renders the OrchTree via NodeView. RE-CONFIRM all names/lines at Study (other
workflows may have just edited these files — read current state).

THE BUG (verified): a leaf NODE is its own sub-agent (own AxGen + own forward + BASE_TOOLS — it OWNS its tools). But tool events render
in the WRONG place: src/agent.ts liveLogger is GLOBAL and emits 'tool'/'result' activities with NO nodeId; src/atoms.ts reducer
case 'tool' patches the MAIN transcript 'messages' (atoms.ts ~:103), while case 'node' patches the separate OrchTree. So a parallel
leaf's bash/read/grep calls render under the MAIN outer agent's transcript, NOT under the leaf node that owns them. And NodeView
(chat.tsx ~:235) is a flat depth-indented recursion that shows child NODES but NO per-node tools and has no real per-node expand.

VOCABULARY: ONE WORD — NODE. Do not introduce leaf/agent/worker/task as unit-names (the orch layer is mid-rename to 'node'; follow it).

THE TWO FIXES:

1. PER-NODE TOOL ROUTING. A node's tools must attach to THAT node. When a node runs, give its forward() a nodeId-BOUND logger (ax forward
   opts accept a per-call logger — AxAIServiceOptions.logger; confirm) that emits tool/result activities TAGGED with the node's id. NO
   module-global "currentNodeId" (races under concurrent nodes — each node's logger closes over its OWN id). Extend the activity 'tool'/
   'result' variants (or add node-scoped ones) with an optional nodeId; the atoms reducer attaches a tagged tool to that node's state
   (a node carries an ordered list of its tool steps) instead of the main transcript. The MAIN turn (no node) keeps today's behavior
   (tools → transcript). Concurrency-correct: 3 parallel nodes firing tools at once each land under their own node, never interleaved
   into one stream. Keep fork-mem + the 4 guards.

2. NODEVIEW REDESIGN (master-detail subtree, like the workflow viewer). Each NODE is INDEPENDENTLY expandable (its own collapse state):
   collapsed = a one-line summary (label · model · tokens · tools-count · elapsed · status glyph); expanded = its OWNED tool steps
   (reuse the existing ToolView for each) PLUS its child nodes (recursively, each independently expandable). Running node auto-expands;
   done node collapses to summary. Show per-node meta: model (when multi-model lands) · tokens (from cost-meter/usage) · tool count ·
   elapsed. Match existing opentui style + keyboard model (Tab focus / Enter expand already exist — extend to nodes). Do NOT regress the
   normal single-turn transcript (tree shows only when nodes exist). The vibe = the workflow viewer: a clean expandable subtree where you
   read each node by expanding it separately.

PRINCIPLES: core stays EXACTLY 5 prims in orch.ts (this is the activity/atoms/chat.tsx layer + a per-node logger; no new core prim). Match
style. Real @ax-llm/ax types. Unavoidable any => 'ponytail:' + 'Upgrade:'. ${CHECK} green AND keep bun run lint green. For tool-routing,
the LIVE harness (${LIVE}) must show a parallel run where each node's tools are attributed to the right node (assert via the node state /
a small headless check of the reducer routing). Commit each fix --no-verify, conventional message. Do NOT git add -A — stage only your files.
`

const FIND_SCHEMA = { type: 'object', additionalProperties: false, required: ['area', 'facts', 'cites'],
  properties: { area: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } }, cites: { type: 'array', items: { type: 'string' } } } }
const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'liveVerified', 'liveOutput', 'filesChanged', 'diff', 'checkOutput', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string' }, liveVerified: { type: 'boolean' }, liveOutput: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } }, diff: { type: 'string' }, checkOutput: { type: 'string' },
    committed: { type: 'boolean' }, commitSha: { type: 'string' }, newPonytails: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lens', 'findings'],
  properties: { lens: { type: 'string' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
    properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } } },
}

phase('Study')
const study = (await parallel([
  () => agent(`Read src/agent.ts (liveLogger — how it emits tool/result activities, whether it can be per-call/nodeId-bound) + grep node_modules/@ax-llm/ax for AxAIServiceOptions.logger / per-forward logger. Read src/orch-tools.ts + src/orch-recipes.ts (how a node's forward/opts are built — where a nodeId-bound logger would attach). Report exactly how to give each node's forward its OWN logger tagged with the node id. Cite file:line.\n\n${SPEC}`,
    { label: 'tool-route', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read src/activity.ts (Activity union — tool/result/node variants) + src/atoms.ts (the reducer: case 'tool' → messages, case 'node' → OrchTree; the OrchNode shape). Report exactly how to (a) carry an optional nodeId on tool/result activities, (b) attach a tagged tool to its node's state (a node needs an ordered tool-steps list) instead of the main transcript, keeping the main-turn (no node) path unchanged. Cite file:line.\n\n${SPEC}`,
    { label: 'atoms', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
  () => agent(`Read src/chat.tsx NodeView + the existing ToolView + the expand/keyboard model (Tab focus, Enter expand, expNodes). Report exactly how to redesign NodeView into a master-detail subtree: each node independently expandable, collapsed=summary (label·model·tokens·tools·elapsed·glyph), expanded=owned tool steps (reuse ToolView) + child nodes recursively. Cite file:line.\n\n${SPEC}`,
    { label: 'nodeview', phase: 'Study', schema: FIND_SCHEMA, agentType: 'Explore' }),
])).filter(Boolean)
const STUDY = JSON.stringify(study, null, 1)
log(`studied ${study.length}/3`)

const FIXES = [
  { key: 'telemetry', title: 'telemetry', live: true,
    spec: `Add finer TELEMETRY so a slow turn (e.g. "hi" took 25s) is ATTRIBUTABLE — today the AxGen/chat.turn span is one opaque blob and readUsage (agent.ts ~:193) captures only prompt/completion tokens, NOT reasoning. CF Kimi K2.7 (and GLM) are THINKING models: they emit reasoning_content before the reply, so most of a slow turn is REASONING and we can't see it. Add:
(1) REASONING TOKENS — extend readUsage + the chat.turn/gen_ai span attributes to capture reasoning/thoughts tokens. Read the response's reasoning (ax AxChatResponseResult.thought/thoughtBlocks, or AxTokenUsage.thoughtsTokens/reasoningTokens — confirm which ax populates for the CF openai-compat reasoning_content field; if ax does NOT surface it, read it off the raw result/getChatLog). Span attrs: gen_ai.usage.prompt_tokens, completion_tokens, thoughts_tokens (+ keep existing).
(2) PROMPT SIZE — record the assembled system-prompt char count (BASE_PROMPT+ORCH_OVERLAY+projectDoc) + prompt tokens as a span attribute, so prompt bloat is visible.
(2b) SPAN GRANULARITY — THE BIG ONE. Today run_rlm + orchestrate are OPAQUE single spans (a 94s run_rlm black box): their internal stages/turns emit only NodeEvents (live UI tree), NOT OTel spans, so the motel TRACE can't show where the time went. FIX: emit OTel CHILD SPANS mirroring the NodeEvent tree — each RLM stage/turn (rlm:distiller, rlm:executor turn N, rlm:responder) and each orchestration node becomes a child span nested under run_rlm/orchestrate (use the ambient tracer from otel; start a span on the node 'start' event, end it on 'done'/'error', carry tokens/stage as attrs). AND thread tracer + traceContext into the RLM forward (rlm-tool.ts ~:139 currently passes only {abortSignal,mem}) so ax also emits gen_ai child spans for each internal RLM stage forward. Net: the trace mirrors the live tree — run_rlm → distiller → executor turn 1..N (each gen_ai) → responder, with timing + tokens per node. GATE: a live run whose motel trace (or the span dump) shows >1 child span under run_rlm/orchestrate (the internal turns), not one black box — quote the span list.
(3) TIMING BREAKDOWN — add span EVENTS around the forward: 'prompt.assembled' (with size), 'forward.sent', 'forward.received', 'parsed' (with timestamps) so the wall-clock splits into assemble vs model vs parse. (stream:false means model time is one fetch; still separate it from assemble+parse.)
Keep the existing OTel one-trace-per-session + gen_ai child spans intact. GATE: a live run (${LIVE} or a tiny live turn) whose trace/log now shows reasoning-token count + prompt size + the timing events — quote them, proving a slow turn is now attributable. Also REPORT the actual breakdown for a trivial "hi" (is it thinking? prompt size?). tsc + lint green, commit checkpoint.
NOTE (do NOT auto-apply — just report as findings): the FIX levers for the latency itself are (a) lower thinkingTokenBudget for simple turns, (b) trim the per-turn prompt (8000-char projectDoc + full ORCH_OVERLAY every turn), (c) stream:true. Surface these in the report; the user decides.` },
  { key: 'focus-sticky', title: 'focus-sticky', live: false,
    spec: `FIX THE INPUT FOCUS BUG PROPERLY (the prior focus-fix 7a6d8f2 is dep-keyed and STILL broken: after sending a msg / tabbing / a row click, the composer input loses focus and isn't highlighted). Root cause confirmed against ../opentui: focus is a SINGLE imperative focused-renderable; Renderable.focus() (Renderable.ts:414) early-returns if destroyed / already _focused / !_focusable; Input/TextArea repaint the highlight only inside focus()/blur() (updateColors). ax2 uses a static \`focused\` prop (fires once on mount) + a useEffect keyed on [view,busy,orchNodeCount,focus,expTurns,expTools,expNodes] — a MOUSE CLICK on a row or a focusRenderable steal changes NONE of those deps, so it never re-focuses; and a stale .focus() early-returns so the highlight never repaints.
CORRECT PATTERN (opentui composer): STICKY SELF-RESTORING focus — the input is the default focus owner; when it BLURS (anything steals focus), immediately re-focus it. Replace the dep-keyed useEffect with a blur-driven re-focus: subscribe to the textarea's blur (via the ref's blur event / opentui useBlur on the input, NOT the terminal-window useBlur) and call taRef.current?.focus() to grab focus back — UNLESS focus is intentionally on a transcript row (the Tab-cycle row-focus mode). Ensure the textarea is focusable. Confirm the exact blur hook/event + focusable wiring from ../opentui/packages/react + packages/core/src/renderables/{Input,TextArea}.ts before coding (do NOT guess the API). Keep the Tab-cycle row focus + Enter-expand working (the composer reclaims focus only when NOT in row-focus mode).
${CHECK} + lint green. NO headless gate — TUI focus CANNOT be headless-verified (the last fix shipped green + was broken). The Report MUST instruct the user to verify manually: \`bun run chat\`, type, send a msg, Tab to a row and back, click a row — the input must stay/return highlighted+typable each time. commit checkpoint.` },
  { key: 'cleanup', title: 'cleanup', live: false,
    spec: `Clear the RESIDUAL review findings — but ONLY the ones still present (the exceed run may have self-fixed some; RE-CONFIRM each in current code first, skip any already resolved). Each is small + behavior-preserving:
(1) DELTA CORRUPTS RESULT — src/atoms.ts (~:143): the node reducer applies resultPatch ('result': a.detail) on EVERY non-start event including 'delta', so a soft-budget overSoft 'delta' nudge transiently overwrites a node's result. Fix: apply the result patch ONLY on 'done'/'error', never 'delta'.
(2) sessionsRT LEAK — src/sessions.ts / src/atoms.ts (~:14): the per-session Map is never cleaned → unbounded growth. Fix: delete a session's entry when it is closed/removed in the UI (add a deleteSession path), or TTL.
(3) BUDGET ACCURACY — src/orch-recipes.ts (~:177, ~:191): the nudge/finalize extra forward's tokens are not charged (undercount), and usageOf is read twice per node. Fix: charge cumulative usage (cover both forwards) and read usageOf once (cache it).
(4) VOCAB — src/orch.ts (~:21) + src/orch-load.ts re-export: 'LeafOpts' was not renamed in the node-vocab unification. Rename LeafOpts → NodeOpts everywhere (behavior-preserving) so ONE word (node) holds. Check for any other stray leaf/worker/agent-as-noun unit names left and fold to node.
(5) DEAD CODE — src/atoms.ts (~:203): a dead string-match for the old 'max steps reached' behavior (graceful-maxsteps removed the throw). Remove it.
(6) RLM TIMEOUT — the per-node 120s NodeTimeoutError (orch-resilience.ts ~:40, AX2_LEAF_TIMEOUT_MS) GUILLOTINES run_rlm: a real RLM is long-horizon (distiller + N executor turns + responder, each a ~7s CF call), it hit 94s and the 120s turn timeout killed it. FIX: run_rlm (and an orchestrate run) must NOT be bound by the single-node 120s timeout — either exempt the run_rlm tool / long-horizon nodes from the node timeout, or give RLM a much larger budget (e.g. AX2_RLM_TIMEOUT_MS default ~600s), and/or reset the timeout on each actor-turn progress (a turn completing = liveness). Pick the cleanest; keep abortSignal honoring a real cancel. Confirm against the real trace (run_rlm was killed at the 120s turn boundary). Also (6b) the run_rlm tool return shape stringified to "[object Object]" in a caller — ensure runRlm returns/serializes a STRING answer (+ evidence) the model + tree render cleanly, not an object.
For EACH: confirm it still exists, fix it, keep ${CHECK} + bun run lint green. Skip cleanly any that exceed already fixed (note which). commit checkpoint (one commit, or per-fix). Do NOT git add -A — stage only your files.` },
  { key: 'tool-routing', title: 'tool-routing', live: true,
    spec: `Per-NODE tool routing. Give each node's forward() a nodeId-BOUND logger (per-call, closing over the node's id — NO module-global currentNodeId) that emits tool/result activities tagged with that node id. Extend activity tool/result variants with an optional nodeId; the atoms reducer attaches a tagged tool to that NODE's state (add an ordered tool-steps list to OrchNode) instead of the main transcript. Main turn (no node) unchanged. Concurrency-correct: parallel nodes' tools never interleave — each lands under its own node. Keep fork-mem + 4 guards. GATE: live harness — run a parallel orchestration where each node uses tools, and assert (via node state / a headless reducer check) that each node's tools are attributed to the RIGHT node, none leaking to the main transcript. Report the per-node tool attribution. tsc + lint green, commit checkpoint.` },
  { key: 'node-render', title: 'node-render', live: false,
    spec: `Redesign NodeView (src/chat.tsx) into a master-detail expandable UNICODE TREE (like the workflow viewer). Draw real box-drawing connectors per row from tree position: '├─' for a node with siblings below it, '└─' for the last child, '│ ' vertical run-through for each ANCESTOR level that still has siblings below, then the toggle ▸(collapsed)/▾(expanded), then the status glyph (●running ✓done ○queued ✗error), then label + right-aligned meta. Owned tool steps render one level deeper with the SAME connector logic. Build the connector prefix from depth + is-last-child + the ancestor open/closed chain. Each NODE independently expandable (own collapse state in expNodes): collapsed = one-line summary (label · model[when present] · tokens[from usage] · tools-count · elapsed · status glyph); expanded = its OWNED tool steps (reuse ToolView, from the tool-routing feature) THEN its child nodes recursively (each independently expandable). Running node auto-expands; done collapses to summary. ROLLING WINDOW (do NOT render all tool steps of a running node — the tree must stay bounded): a RUNNING node shows only its last N tool steps where N = clamp(BASE - k*velocity, 1, MAX) (velocity = tool-steps/sec over a rolling ~2s window; BASE ~3, MAX ~5; shrink faster on positive acceleration/burst, grow slower on decel, hysteresis to avoid flicker), with a '┄ +M more' affordance for the rolled-off steps; the FULL list shows only when the node is focus/expanded (override the window). Done node → one summary line (tools-count + per-kind tally), window gone. Each tool step carries a ts so velocity is computable (recompute on tool-event tick, NOT every frame — respect opentui batching). Extend the Tab-focus / Enter-expand keyboard model to nodes. Do NOT regress the single-turn transcript (tree only when nodes exist) or the existing tool/turn views. ${CHECK} + lint green. Verify by reasoning + review (note manual check: bun run chat, ^o, expand nodes, confirm each node's tools show under it). commit checkpoint.` },
]

const results = []
for (let i = 0; i < FIXES.length; i++) {
  const f = FIXES[i]
  if (budget.total && budget.remaining() < 80000) { log(`budget low — stop before ${f.key}`); break }
  phase(f.title)
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree, grounded in the study.\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} green + keep bun run lint green.${f.live ? ` THEN run the live harness (${LIVE}) — green ONLY with real proof (per-node tool attribution), set liveVerified=true + paste liveOutput.` : ''} Self-heal up to ${MAX_HEAL}. Mark shortcuts 'ponytail:' + 'Upgrade:'. ONE WORD vocab: node. When green, COMMIT alone (--no-verify) 'fix(orch): ${f.key} ...'. Report sha/diff/check tail/liveVerified/liveOutput/new ponytails. Do NOT git add -A — stage only your files.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++; log(`${f.key}: heal ${heal}`)
    impl = await agent(`"${f.key}" RED (${CHECK}/lint or live). Fix for real + re-verify${f.live ? ` (${LIVE})` : ''}, commit --no-verify.\nFAILING:\n${impl.checkOutput}\nLIVE:\n${impl.liveOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }
  const LENSES = [
    { k: 'correct', focus: `tool-routing: does EACH node's tools attach to its OWN node (concurrency-correct, no global currentNodeId, none leaking to the main transcript)? node-render: each node independently expandable, owned tools shown under it, child nodes recursive, summary meta correct? Reject if tools still dump in the main transcript. Cite file:line + live proof.` },
    { k: 'no-regress', focus: `single-turn transcript + existing tool/turn views + keyboard (Tab/Enter) NOT regressed? core still 5 prims? ONE-WORD vocab (node — no leaf/worker synonyms introduced)? no unmarked any/ponytail; lint green? Cite file:line.` },
  ]
  let reviews = (await parallel(LENSES.map(l => () =>
    agent(`Adversarially review committed "${f.key}". Skeptical. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : '(failed)'}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  log(`${f.key}: live=${impl ? impl.liveVerified : '?'} blockers=${blockers.length}`)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++; log(`${f.key}: harden ${hr}`)
    impl = await agent(`BLOCKERS in "${f.key}" — fix for real, re-verify${f.live ? ' (live)' : ''}, AMEND commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map(l => () =>
      agent(`Re-review "${f.key}"; blockers closed + live still real? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ''}\nLIVE:\n${impl ? impl.liveOutput : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap(r => (r.findings || []).filter(x => x.isBlocker))
  }
  results.push({ feature: f.key, status: impl ? impl.status : 'failed', commit: impl ? impl.commitSha : null, liveVerified: impl ? impl.liveVerified : false, liveOutput: impl ? (impl.liveOutput || '').slice(0, 300) : '', openBlockers: blockers, newPonytails: impl ? impl.newPonytails : [] })
}

phase('Report')
const report = await agent(
  `Final report (blunt, terse, markdown, no spin). Per fix (tool-routing, node-render): green/red, commit, proof. (1) do a parallel run's tools now render UNDER the owning node (not the main outer agent)? quote the live per-node attribution. (2) is the tree now a master-detail expandable subtree (each node expands separately, owned tools + child nodes + meta)? (3) core still 5 prims, ONE-WORD vocab, lint green, single-turn unbroken? (4) residual. (5) one honest line. Headline anything red or only compile-verified.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: 'report', phase: 'Report' })
return { features: results, report }
