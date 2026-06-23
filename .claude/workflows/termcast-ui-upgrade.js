export const meta = {
  name: 'termcast-ui-upgrade',
  description: 'Adopt termcast/Raycast UI patterns into the ax2 opentui chat TUI (ActionPanel command-palette, List+Detail master/detail for sessions+transcript, theme tokens, descendant-driven focus model) WITHOUT regressing the current LIVE surface: collapsible transcript / per-tool views / the live NodeView orchestration tree / the animated input working-spinner / the Tab-cycles-focus + Enter-toggles keyboard model. Pure TUI layer under src/ (chat.tsx, toolui.ts, atoms.ts UI-state shape + new tui/ helpers) — NO core change (orch.ts 5 prims, agent.ts turn(), orch-run.orchestrate, orch-load.loadAndRunOrch, the activity-bus contract all untouched). Research -> prototype -> verify, feature-by-feature on main, each self-healed to bun-run-check-green + 2-lens adversarial review + committed.',
  phases: [
    { title: 'Scout',         detail: 'parallel read-only: pin ax2 chat.tsx/toolui.ts/atoms.ts CURRENT UI surface (node-tree + input-spinner + Tab/Enter focus are all live) + termcast list/actions/detail/footer/theme/descendants source — what to keep, what to graft' },
    { title: 'Plan',          detail: 'synthesize a behavior-preserving adoption plan: ordered grafts, the FULL invariant set (incl. node-tree / spinner / Tab-Enter focus), kept keyboard map, file targets — returns the actionable spec each feature consumes' },
    { title: 'theme-tokens',  detail: 'central theme token module replacing scattered hex literals (no visual change), so later features color via tokens not magic strings' },
    { title: 'focus-descendants', detail: 'replace the O(n) hand-rolled focusables array + modulo lookup with a descendant registry (O(1), stable across collapse/expand) keeping the exact Tab/Shift+Tab-cycle + Enter-toggles-focused behavior' },
    { title: 'action-panel',  detail: 'ActionPanel + Ctrl+K command palette over current per-turn/per-tool/session/app actions (copy/expand/interrupt/new/theme/orchestrate) with shortcut footer — additive, click+key+^o+/run paths preserved' },
    { title: 'master-detail', detail: 'session list + transcript as List+Detail master/detail with smart scroll-to-selected, keeping collapsible turns, per-tool ToolView bodies, the NodeView orchestration tree, and the input spinner intact' },
    { title: 'Report',        detail: 'final status, per-feature commit/diff, regression-guard results (all 6 invariants), residual risk, what is now usable, single best follow-up' },
  ],
}

// ───────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ───────────────────────────────────────────────────────────────────────────
const CHECK = 'bun run check'   // tsc --noEmit + Effect LS — the hard green gate
const LINT = 'bun run lint'     // check + analyze + debt — informational (pre-existing user dead exports stay red)
const SMOKE = 'bun run emit'    // headless trace smoke — must still run clean (proves the app boots / no import break)
const MAX_HEAL = 4
const MAX_HARDEN = 2

// Concrete paths (everything is under ax2; termcast is a sibling at ../termcast/termcast).
const AX2 = 'ax2'
const TERMCAST = 'termcast/termcast/src/components'

// The non-negotiable scope + invariants the whole workflow is bound by. Threaded into every agent call.
// RE-GROUNDED to current chat.tsx (~672 lines): the node-tree, the animated input
// spinner, and the Tab/Enter focus model are ALL LIVE TODAY — they are invariants, not TODOs.
const SPEC = `
TARGET = ax2 chat TUI (opentui + React via @opentui/react). PURE TUI LAYER ONLY.
  Files you MAY touch: ${AX2}/src/chat.tsx, ${AX2}/src/toolui.ts, ${AX2}/src/atoms.ts (ONLY its UI-state/view shape — SessionView/Msg/TurnMeta/OrchNode/OrchTree — NOT the Effect session-action semantics), and NEW helper modules under ${AX2}/src/tui/ (create the folder).
  Files you MUST NOT change (core — out of scope, changing them fails review): ${AX2}/src/orch.ts, ${AX2}/src/orch-recipes.ts, ${AX2}/src/orch-run.ts, ${AX2}/src/orch-load.ts, ${AX2}/src/agent.ts, ${AX2}/src/otel.ts, ${AX2}/src/sessions.ts, ${AX2}/src/tools.ts, ${AX2}/src/activity.ts.
  The activity-bus contract (Activity union, emitActivity, setActivitySink) and atoms' Effect session actions (sendAtom / orchestrateAtom / runScriptAtom / newSessionAtom / appAtom / busyAtom via appRuntime.fn) are CONTRACTS — read & consume, never alter their behavior or signatures. NodeEvents flow orch.emit -> activity bus -> atoms installSink -> OrchTree patch; that pipeline is live and out of scope.

SOURCE OF PATTERNS = termcast (Raycast-compatible opentui components) at ${TERMCAST}:
  list.tsx (master-detail List+Detail, ScrollBox centering, spacingMode, accessory column widths, descendants, footer shortcuts),
  actions.tsx (ActionPanel offscreen descendants, Ctrl+K dialog, ActionPanel.Section grouping, {modifiers,key} shortcut model),
  detail.tsx + metadata.tsx (detail pane + key/value metadata layout),
  footer.tsx (shortcut hint row), markdown.tsx (themed markdown), theme-picker.tsx + theme.tsx (theme tokens/persistence),
  spinner.tsx (reference only — ax2 already has its own input spinner, see invariant 5), form/ (descendant + scroll-to-field — reference only, ax2 has no form yet).
  READ termcast source directly (it is opentui-native); do NOT npm-doc Raycast. Adapt patterns — do NOT vendor termcast wholesale or add its zustand store. ax2 state lives in atoms (@effect/atom-react) + local React useState; keep that.

HARD INVARIANTS — a feature that regresses ANY of these FAILS review (re-verified after every feature). chat.tsx line cites are approximate (current ~672-line file):
  1. Collapsible transcript: middle steps collapse by default; in-progress turns auto-expand (chat.tsx isExpanded = expTurns.has(t.idx) || t.final === null, ~line 402). Click a ▸/▾ (TurnView ~178-189) AND key-expand both still work.
  2. Per-tool views: each tool row expands to its tool-specific body; edits render a real <diff> (ToolView ~128-150, <diff> ~139); cheap reads with self-evident summaries get no expander (toolHasBody/toolDiff/toolPreview/toolSummary/toolIcon/toolLabel in toolui.ts).
  3. LIVE NodeView orchestration tree: the recursive live tree (chat.tsx NodeView ~235-282, depth INDENT, status glyph nodeGlyph/nodeColor, expNodes via useNodeExpansion, childrenOf via childrenIndex ~306) renders below the transcript whenever orch nodes exist (active.orch, roots gate ~615). running nodes auto-expand (n.status === "running" || expNodes.has(id), ~255). It is fed by ^o (orchestrate) and /run (runScript). Transcript-only when no orch nodes. DO NOT regress this — it is the headline live feature.
  4. Animated input working-spinner: while busy, the textarea PLACEHOLDER shows an animated braille spinner + elapsed seconds on the prompt's LEFT EDGE — useWorking(busy) (~86-97, SPIN_FRAMES "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏" ~81), placeholder = busy ? \`\${work.frame} thinking… \${work.elapsed}s · esc to interrupt\` : "message kimi" (~652). It is on the INPUT prompt, NOT a transcript dangle. Must keep ticking only while busy and reset on idle.
  5. Tab-cycles-focus / Enter-toggles-expand keyboard model: focusables[] (~406-411) lists "turn:\${idx}" then its "tool:\${id}" rows (only when that turn is expanded); focusedKey = modulo wrap (~411); Tab/Shift+Tab move focus (onChatKey ~561: setFocus((f) => f + (k.shift ? -1 : 1))); Enter on EMPTY input toggles the focused row (toggleFocused, ~563 + 412-417). focus resets on session change (~362). This Tab/Enter ring MUST behave identically (same focusables set given collapse state, same wrap, same toggle target).
  6. Keyboard model preserved (every existing binding keeps its meaning): list view ↑/↓(or k/j) move, Enter open, n new, q/Esc quit; chat view type+Enter send, Shift+Enter newline, ↑/↓ history (when input empty / mid-recall, histActive), PgUp/PgDn/Home/End scroll, Tab cycles focus, Enter expands focused row (empty input), Esc back (idle) / Esc-twice interrupt (busy, armed), ^o orchestrate, /run <script> load+run, ← back (empty,idle), select-to-copy (useSelectionHandler), big-paste collapse (onPaste). NEW bindings (Ctrl+K palette etc.) are ADDITIVE and must NOT shadow these.
  7. No core change, no activity-bus contract change, no new heavy dep. opentui elements only (box/text/scrollbox/textarea/markdown/diff/span + @opentui/react hooks useKeyboard/useFocus/useBlur/useSelectionHandler/useTerminalDimensions).

PONYTAIL ETHOS (lazy-senior): no speculative ceremony. Adopt a termcast pattern ONLY where it removes real pain (scattered hex, O(n) focus rebuild + indexOf, no command surface, no master-detail). Skip patterns ax2 has no use for YET (pagination, toast, vim-mode, navigation-stack persistence, dropdown filtering, Form, theme persistence) — name them as deferred in the plan, do NOT build them. Any deliberate shortcut gets a 'ponytail:' comment WITH an 'Upgrade:' trigger line (bun run debt enforces). Match surrounding code style exactly.

GREEN GATE = ${CHECK} clean. ${LINT} may stay RED ONLY on the documented pre-existing user dead exports (history, clipboard, toolui, agent.ts abortTurn etc.) — never blame those on this work, never delete the user's in-flight files. Every NEW export YOU add MUST be consumed (by chat.tsx or a sibling) or analyze flags it. ${SMOKE} must still run clean after each feature (import-graph sanity).
`

// ───────────────────────────────────────────────────────────────────────────
// SCHEMAS (real JSON-Schema for every structured agent() call)
// ───────────────────────────────────────────────────────────────────────────
const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'facts', 'cites', 'keep', 'graft'],
  properties: {
    area: { type: 'string', description: 'the scout key' },
    facts: { type: 'array', items: { type: 'string' }, description: 'verbatim signatures / structures / mechanisms found' },
    cites: { type: 'array', items: { type: 'string' }, description: 'file:line for each fact' },
    keep: { type: 'array', items: { type: 'string' }, description: 'ax2 behaviors that MUST be preserved (the invariants this area touches)' },
    graft: { type: 'array', items: { type: 'string' }, description: 'termcast pattern(s) worth adopting here, or "none" with reason' },
  },
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'features', 'invariants', 'keyboardMap', 'deferred', 'risks'],
  properties: {
    summary: { type: 'string', description: 'one-paragraph adoption strategy' },
    features: {
      type: 'array',
      description: 'the ordered grafts (should map to the theme-tokens / focus-descendants / action-panel / master-detail phases)',
      items: {
        type: 'object', additionalProperties: false,
        required: ['key', 'title', 'goal', 'files', 'termcastRefs', 'preserves', 'doneWhen'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string', description: 'what changes and why it removes real pain' },
          files: { type: 'array', items: { type: 'string' }, description: 'concrete paths under ax2/src' },
          termcastRefs: { type: 'array', items: { type: 'string' }, description: 'termcast file:line patterns to adapt' },
          preserves: { type: 'array', items: { type: 'string' }, description: 'which hard invariants this feature must not break (cite the numbered list incl. node-tree / spinner / Tab-Enter focus)' },
          doneWhen: { type: 'array', items: { type: 'string' }, description: 'observable acceptance checks' },
        },
      },
    },
    invariants: { type: 'array', items: { type: 'string' }, description: 'the regression guards every feature is re-verified against — MUST include the live node-tree, the input spinner, and the Tab/Enter focus ring' },
    keyboardMap: {
      type: 'array',
      description: 'the FINAL keyboard map: existing bindings unchanged (incl. ^o, /run, Tab, Enter-toggle) + any additive ones',
      items: {
        type: 'object', additionalProperties: false,
        required: ['keys', 'context', 'action', 'status'],
        properties: {
          keys: { type: 'string' },
          context: { type: 'string', description: 'list | chat | palette | global' },
          action: { type: 'string' },
          status: { type: 'string', description: 'existing | new' },
        },
      },
    },
    deferred: { type: 'array', items: { type: 'string' }, description: 'termcast patterns deliberately NOT built now (pagination/toast/vim/nav-stack/Form/theme-persistence) with the triggering use case that would justify them later' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'filesChanged', 'diff', 'checkOutput', 'smokeOk', 'invariantsHeld', 'committed', 'commitSha', 'newPonytails', 'notes'],
  properties: {
    status: { type: 'string', description: 'green | red (green = bun run check clean modulo pre-existing user dead exports)' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string', description: 'unified git diff of THIS feature' },
    checkOutput: { type: 'string', description: 'final check tail: "clean" or verbatim errors' },
    smokeOk: { type: 'boolean', description: 'bun run emit still runs clean (no import/boot break)' },
    invariantsHeld: {
      type: 'array',
      description: 'each hard invariant (all 7, incl. node-tree / spinner / Tab-Enter focus) + how it was verified to still hold',
      items: {
        type: 'object', additionalProperties: false,
        required: ['invariant', 'held', 'evidence'],
        properties: {
          invariant: { type: 'string' },
          held: { type: 'boolean' },
          evidence: { type: 'string', description: 'file:line or behavior trace showing it still works' },
        },
      },
    },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    newPonytails: { type: 'array', items: { type: 'string' }, description: 'ponytail: markers added, each WITH its Upgrade: trigger' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'verdict', 'findings'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', description: 'pass | blockers (blockers = at least one isBlocker finding)' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
        properties: {
          severity: { type: 'string', description: 'low | med | high' },
          isBlocker: { type: 'boolean' },
          where: { type: 'string', description: 'file:line' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'perFeature', 'usableNow', 'regressionsFound', 'residualRisk', 'nextStep', 'markdown'],
  properties: {
    headline: { type: 'string', description: 'blunt: how many of the 4 grafts landed green, anything partial/failed' },
    perFeature: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['feature', 'status', 'commit', 'enables', 'openBlockers'],
        properties: {
          feature: { type: 'string' },
          status: { type: 'string' },
          commit: { type: 'string' },
          enables: { type: 'string' },
          openBlockers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    usableNow: { type: 'array', items: { type: 'string' }, description: 'what the user can now do in the TUI (Ctrl+K palette? master-detail? themed?)' },
    regressionsFound: { type: 'array', items: { type: 'string' }, description: 'any hard invariant that broke (collapsible transcript / per-tool views / live node-tree / input spinner / Tab-Enter focus / keyboard map) + whether it was fixed' },
    residualRisk: { type: 'array', items: { type: 'string' }, description: 'new ponytails (with Upgrade triggers), deferred patterns, pre-existing lint-red exports (not ours)' },
    nextStep: { type: 'string', description: 'the single most valuable follow-up' },
    markdown: { type: 'string', description: 'full blunt terse markdown report for the ax2 author' },
  },
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE 1 — SCOUT  (parallel, read-only: no shared writes => barrier-fan-out is safe)
// ───────────────────────────────────────────────────────────────────────────
phase('Scout')
const SCOUTS = [
  { key: 'ax2-transcript', agentType: 'Explore', prompt:
    `Read ${AX2}/src/chat.tsx IN FULL and ${AX2}/src/toolui.ts. Report verbatim: the Turn/Msg/TurnMeta shapes + toTurns() reduction (~58-76); the collapsible-transcript machinery (expTurns/expTools Sets, isExpanded rule "expTurns.has(t.idx) || t.final === null" ~402, the ▸/▾ click handlers in TurnView ~178-189 and the key-expand path); the per-tool view contract (toolHasBody/toolIcon/toolLabel/toolSummary/toolPreview/toolDiff in toolui.ts, PreviewLine, ToolHeader/ToolView ~105-150 incl. the real <diff> ~139); and the LIVE NodeView recursive orchestration tree (~235-282: props id/nodes/childrenOf/depth/expNodes/onToggle, depth INDENT, nodeGlyph/nodeColor status glyph, running-auto-expand rule ~255, childrenIndex ~306, useNodeExpansion ~317, the orchestration render gate ~615 active.orch.roots). ALSO report useWorking(busy) (~86-97) + SPIN_FRAMES (~81) + the animated placeholder (~652) — the input working-spinner. These five (collapsible transcript, per-tool views, LIVE node-tree, input spinner, Tab/Enter focus) are LIVE invariants the upgrade must preserve, not future work.` },
  { key: 'ax2-focus-keyboard', agentType: 'Explore', prompt:
    `Read ${AX2}/src/chat.tsx focusing on the focus + keyboard model. Report verbatim: the hand-rolled focusables string array (~406-411 — how it is rebuilt each render from turns, the "turn:\${idx}" / "tool:\${id}" ids, the modulo focusedKey wrap, the O(n) rebuild + the kind/val split in toggleFocused ~412-417, focus reset on session change ~362); EVERY useKeyboard handler — onListKey (~533) and onChatKey (~557) and the top useKeyboard (~573, ^c exit + ^o orchestrate gate) — and the COMPLETE binding map for both views (Tab/Shift+Tab cycle ~561, Enter-toggles-focused-on-empty ~563, Esc handleEscape arm/interrupt ~550, ← back ~560, PgUp/PgDn/Home/End scrollPage ~520, ↑/↓ history via histActive/recall ~492, n/q/k/j, ^o submitOrchestrate ~461, /run via runMatch ~449, send/newline via inputKeys ~25, select-copy useSelectionHandler ~381, big-paste onPaste ~475); the scrollbox usage (stickyScroll/stickyStart ~595, scrollPage); and useFocus/useBlur (~366 focus-gated bell) / useSelectionHandler / useTerminalDimensions usage. This whole keyboard contract MUST survive untouched; the focusables array is exactly what focus-descendants replaces (same ids, same wrap, same toggle behavior).` },
  { key: 'ax2-colors-state', agentType: 'Explore', prompt:
    `Read ${AX2}/src/chat.tsx and ${AX2}/src/atoms.ts. Report: EVERY hardcoded color hex literal in chat.tsx with its semantic role + line — the statusBar tones (#f38ba8 / #ffd166 / #a6e3a1 / #585b70 ~51-56), statusColor/previewColor (~99-102), the tool hot/dim colors (#ffffff/#cdd6f4/#9399b2/#585b70 in ToolHeader ~120-123), nodeColor/nodeGlyph (~232-233), the user-row #66aaff / border #45475a (~175-176), the spinner placeholderColor (#ffd166/#585b70 ~653), and the mdStyle SyntaxStyle.create() usage (~21); and from atoms.ts the EXACT view-state contract the UI consumes: SessionView/Msg/TurnMeta/OrchNode/OrchTree shapes (~19-44) and appAtom/busyAtom/sendAtom/orchestrateAtom/runScriptAtom/newSessionAtom signatures (these Effect actions + the installSink activity-bus->OrchTree projection ~91-146 are a CONTRACT — note which fields are pure view-state vs session semantics). theme-tokens replaces the hex; master-detail reads this state. The OrchTree/OrchNode shape and how installSink patches it are out of scope to change.` },
  { key: 'termcast-list-detail', agentType: 'Explore', prompt:
    `Read ${TERMCAST}/list.tsx and ${TERMCAST}/detail.tsx and ${TERMCAST}/metadata.tsx. Report the ADAPTABLE master-detail mechanics with file:line: how List renders a left list + right Detail pane (width split, minHeight ratchet to prevent jump), the ScrollBox-ref + elementRef scroll-to-selected centering formula (targetScrollTop = itemTop - viewportHeight/2), spacingMode (single vs two-line), accessoryTagsLayout column widths, and how Detail/Metadata lay out key/value. Flag what is termcast-zustand-coupled (do NOT copy that) vs pure-layout (adaptable). ax2 will use atoms/useState, not zustand, and the Detail pane must host ax2's EXISTING transcript body — collapsible turns, per-tool ToolView, AND the live NodeView orchestration tree — not termcast's own renderers.` },
  { key: 'termcast-actions-footer', agentType: 'Explore', prompt:
    `Read ${TERMCAST}/actions.tsx and ${TERMCAST}/footer.tsx. Report with file:line: the ActionPanel structure (ActionPanel.Section grouping, Action props {title,icon,shortcut:{modifiers,key},onAction,style}), the offscreen-descendants mechanism that lets Ctrl+K open an actions dialog and drive selection by keyboard, and the footer shortcut-hint row (↵ first action, ^k actions, ↑↓ nav). Separate the pure pattern (shortcut model + section grouping + footer render) from termcast infra (Offscreen/zustand/navigation stack) ax2 should NOT pull in. ax2 will build a minimal palette over its own atoms + a plain box overlay, and the palette's bindings must NOT shadow ax2's existing ^o / /run / Tab / Enter-toggle / Esc bindings.` },
  { key: 'termcast-theme-descendants', agentType: 'Explore', prompt:
    `Read ${TERMCAST}/theme.tsx, ${TERMCAST}/theme-picker.tsx, ${TERMCAST}/markdown.tsx, and find termcast's descendants utility (search ${TERMCAST}/../internal and ${TERMCAST}/../examples for createDescendants/useListDescendant/descendants). Report with file:line: the theme token shape (palette keys, how components read color via tokens not hex, SyntaxStyle from theme), and the descendants pattern (createDescendants -> provider + register hook giving O(1) auto-indexed selection stable across filter/reorder). Flag the persistence/zustand parts ax2 should drop. ax2's theme-tokens = a plain token module (no persistence yet); ax2's focus-descendants = a minimal local registry replacing the focusables array (~406-411 in chat.tsx) while keeping its EXACT "turn:\${idx}"/"tool:\${id}" ids, modulo wrap, and Enter-toggles-focused semantics.` },
]
const scouts = (await parallel(SCOUTS.map((s) => () =>
  agent(`${s.prompt}\n\nReturn structured. area="${s.key}". Copy signatures/structures VERBATIM; cite file:line for every fact; do not invent. List the ax2 behaviors to KEEP and the termcast pattern to GRAFT (or "none" + reason).\n\n${SPEC}`,
    { label: s.key, phase: 'Scout', schema: SCOUT_SCHEMA, agentType: s.agentType })
))).filter(Boolean)
const FACTS = JSON.stringify(scouts, null, 1)
log(`scouted ${scouts.length}/${SCOUTS.length} areas`)

// ───────────────────────────────────────────────────────────────────────────
// PHASE 2 — PLAN  (single synthesis: ordered grafts, invariants, kept keyboard map)
// ───────────────────────────────────────────────────────────────────────────
phase('Plan')
const plan = await agent(
  `You are the senior who owns ax2's TUI. From the scout facts, synthesize a BEHAVIOR-PRESERVING adoption plan that grafts termcast/Raycast patterns into the ax2 chat TUI in the order: theme-tokens -> focus-descendants -> action-panel -> master-detail.\n\nGround truth: the ax2 chat TUI is ALREADY a rich live surface — collapsible transcript, per-tool <diff> views, a LIVE recursive NodeView orchestration tree (fed by ^o orchestrate and /run scripts via the activity bus), an animated input working-spinner on the prompt's left edge, and a Tab-cycles-focus + Enter-toggles-expand keyboard ring. The upgrade must NOT regress any of these; it adds tokens / O(1) focus / a command palette / a master-detail frame AROUND them.\n\nFor EACH of those four features give: goal (the real pain it removes — no speculative ceremony), concrete file targets under ${AX2}/src, the termcast file:line patterns to adapt, which hard invariants (cite the numbered list — esp. #3 live node-tree, #4 input spinner, #5 Tab/Enter focus) it must preserve, and observable doneWhen checks. Produce the FINAL keyboard map (every existing binding unchanged — incl. ^o, /run, Tab, Enter-toggle, Esc-arm — plus only the additive ones, Ctrl+K palette and any master-detail nav, explicitly marked new, none shadowing an existing key). List the termcast patterns you are DELIBERATELY DEFERRING (pagination, toast, vim-mode, navigation-stack persistence, dropdown filtering, Form, theme persistence) each with the triggering use case that would later justify it — do NOT plan to build them now. Keep it lazy-senior: smallest graft that removes the pain, reuse ax2's atoms/useState (NOT termcast zustand).\n\nThis plan is the spec each later feature consumes — be exact and actionable.\n\nSCOUT FACTS (ground truth):\n${FACTS}\n\n${SPEC}`,
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA, agentType: 'Explore' })
const PLAN = JSON.stringify(plan, null, 1)
log(`plan: ${plan.features.length} features, ${plan.deferred.length} deferred patterns, ${plan.keyboardMap.length} keybindings mapped`)

// ───────────────────────────────────────────────────────────────────────────
// FEATURES — built strictly IN ORDER on main (shared working tree => SEQUENTIAL,
// no parallel writers). Each: implement -> self-heal to green -> 2-lens
// adversarial review -> harden blockers -> commit. Review fan-out is read-only
// (parallel barrier safe).
// ───────────────────────────────────────────────────────────────────────────
const FEATURES = [
  { key: 'theme-tokens', title: 'theme-tokens', spec:
    `Create ${AX2}/src/tui/theme.ts exporting a single theme token object (semantic keys derived from the EXACT hex roles the scout found: accent #66aaff, agentReply #a6e3a1, toolName #cdd6f4, dim #585b70, hot #ffffff, muted #9399b2, ok #a6e3a1, warn #ffd166, danger #f38ba8, border #45475a, running #7f849c, etc.) plus the mdStyle/SyntaxStyle wiring (~line 21). Replace EVERY hardcoded hex literal in ${AX2}/src/chat.tsx — statusBar tones, statusColor/previewColor, ToolHeader hot/dim colors, nodeColor/nodeGlyph, the user-row + border, AND the input-spinner placeholderColor (~653) — with a token read. NO visual change: tokens must resolve hex-for-hex to the SAME colors currently shown (verify each). The node-tree colors and the spinner colors come from tokens after this too. Adapt termcast theme.tsx's token shape but DROP its zustand store + persistence (deferred). Keep it a plain exported const + getter; chat.tsx imports it. Do not touch any non-TUI file.` },
  { key: 'focus-descendants', title: 'focus-descendants', spec:
    `Replace the hand-rolled focusables string array + modulo lookup in ${AX2}/src/chat.tsx (~406-417) with a minimal local descendant registry in ${AX2}/src/tui/descendants.ts (adapt termcast's createDescendants/useListDescendant pattern, but a TINY local version — no zustand, plain React context + ref-counted index map giving O(1) auto-indexed selection stable across collapse/expand). Focusable ids stay EXACTLY as today ("turn:\${idx}", "tool:\${id}") and the build rule is identical: a "turn:\${idx}" entry per turn with steps, then its "tool:\${id}" rows ONLY when that turn isExpanded. Tab/Shift+Tab cycle + Enter-toggles-focused (on empty input) MUST behave IDENTICALLY — same wrap-around modulo, same focusedKey, same toggleFocused target (turn->toggleTurn, tool->toggleTool), same focus reset on session change. This is a pure internal refactor: zero behavior change, removes the O(n) rebuild + the implicit indexOf cost. Keep NodeView, the transcript rendering, and the input spinner exactly as-is (the orch node-tree has its OWN expansion via useNodeExpansion — do NOT fold it into this focus ring unless behavior is provably identical).` },
  { key: 'action-panel', title: 'action-panel', spec:
    `Add an ActionPanel + Ctrl+K command palette in ${AX2}/src/tui/action-panel.tsx (adapt termcast actions.tsx: Action {title,icon?,shortcut:{modifiers,key},onAction} + ActionPanel.Section grouping + a {modifiers,key} shortcut model; but build the overlay as a PLAIN opentui box/text overlay driven by ax2 atoms/useState + the new descendant registry for keyboard selection — do NOT import termcast Offscreen/zustand/navigation). Surface the actions that ALREADY exist as ad-hoc handlers, grouped: Turn-level (copy reply, expand/collapse via toggleTurn), Tool-level (copy tool body, expand via toggleTool), Orchestration-level (run demo orchestration = ^o submitOrchestrate, run script = /run), Session-level (new session, quit), App-level (change theme — wire to theme-tokens; interrupt-when-busy = handleEscape/abortTurn). Wire Ctrl+K to open the palette (additive — must NOT shadow ANY existing binding: ^o, /run, Tab, Enter-toggle, Esc-arm, ↑/↓ history all keep meaning; Esc closes the palette, Enter runs the highlighted action, ↑/↓ move within it). Add a footer shortcut-hint row (adapt footer.tsx, colored via theme tokens) replacing/augmenting the current IDLE_HINT statusBar line (~49) — keep the ^o / /run / tab / enter hints visible. The existing click ▸/▾ + direct key paths + the live node-tree + the input spinner MUST keep working unchanged — the palette is an alternate entry, not a replacement.` },
  { key: 'master-detail', title: 'master-detail', spec:
    `Restructure the chat view into a termcast-style List+Detail master/detail in ${AX2}/src/chat.tsx using a new ${AX2}/src/tui/list-detail.tsx helper (adapt list.tsx: left master = session list (or turn list), right Detail pane = the selected turn's transcript body / tool detail; width split with a minHeight ratchet so the pane does not jump; ScrollBox-ref + elementRef scroll-to-selected centering targetScrollTop = itemTop - viewportHeight/2 wired to keyboard selection from the descendant registry). CRITICAL — preserve ALL hard invariants: collapsible turns (expTurns rule), per-tool ToolView bodies + <diff>, the LIVE NodeView orchestration tree (it must still render below/within the transcript whenever active.orch.roots is non-empty, running-auto-expand intact), the animated input working-spinner (useWorking placeholder on the prompt, untouched), the Tab/Enter focus ring, and the FULL keyboard map (incl. ^o / /run). The detail pane renders the SAME transcript/tool/NodeView content as today — do NOT swap in termcast renderers. Transcript-only fallback when the terminal is too narrow for a split (graceful, mark 'ponytail:' width threshold WITH 'Upgrade:' responsive breakpoints). Optional spacingMode token (default = current density) — do not change default look. This is the largest graft: lean on the prior three features (tokens, descendants, palette) and keep the diff reviewable.` },
]

const results = []
for (let i = 0; i < FEATURES.length; i++) {
  const f = FEATURES[i]
  if (budget.total && budget.remaining() < 90000) { log(`budget low (${Math.round(budget.remaining() / 1000)}k) — stopping before ${f.key}`); break }
  phase(f.title)

  // implement (edits main, self-heals to green, commits)
  let impl = await agent(
    `Implement TUI feature "${f.key}" in the ax2 main working tree (current branch). Earlier features in this run are ALREADY committed — build on them.\n\nFEATURE SPEC:\n${f.spec}\n\nRules: ${CHECK} MUST end green (modulo the documented pre-existing user dead exports). Run ${SMOKE} after — it must still run clean (no import/boot break). Self-heal: if check or smoke is red, fix and re-run, up to ${MAX_HEAL} attempts. Mark any deliberate shortcut with a 'ponytail:' comment AND an 'Upgrade:' trigger line. VERIFY each hard invariant still holds — ESPECIALLY #3 the live NodeView orchestration tree (running-auto-expand), #4 the animated input working-spinner, and #5 the Tab/Enter focus ring — cite file:line / behavior; a regression here is a failure, not a note. When green, COMMIT this feature alone with --no-verify and a conventional message 'feat(tui): ${f.key} ...'. Report commit sha, the diff, check tail, smokeOk, the invariant table (all 7), any new ponytails.\n\nADOPTION PLAN (the spec to follow):\n${PLAN}\n\nSCOUT FACTS (ground truth — copy signatures, do not invent):\n${FACTS}\n\n${SPEC}`,
    { label: `impl:${f.key}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })

  let heal = 0
  while (impl && impl.status !== 'green' && heal < MAX_HEAL && (!budget.total || budget.remaining() > 60000)) {
    heal++
    log(`${f.key}: heal ${heal} (check red)`)
    impl = await agent(
      `Feature "${f.key}" left ${CHECK} RED (or ${SMOKE} broken). Diagnose + fix in the working tree, re-run until ${CHECK} is green (modulo pre-existing user dead exports) AND ${SMOKE} runs clean, then commit with --no-verify. Do not regress any hard invariant while fixing (esp. the live node-tree, the input spinner, the Tab/Enter focus ring).\n\nFAILING:\n${impl.checkOutput}\n\nReturn the structured result.\n\n${SPEC}`,
      { label: `heal:${f.key}:${heal}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
  }

  // adversarial review — 2 lenses, parallel (read-only => safe barrier fan-out)
  const LENSES = [
    { k: 'regression', focus:
      `REGRESSION + INVARIANTS: did "${f.key}" preserve EVERY hard invariant — collapsible transcript (expTurns rule + ▸/▾ click + key-expand), per-tool ToolView bodies + <diff>, the LIVE NodeView orchestration tree (still renders on active.orch.roots, running nodes auto-expand, childrenOf recursion intact, fed by ^o + /run), the animated input working-spinner (useWorking placeholder ticks while busy on the prompt's LEFT edge, NOT in the transcript), the Tab/Enter focus ring (same "turn:\${idx}"/"tool:\${id}" focusables given collapse state, same modulo wrap, Enter-toggles-focused on empty input), and the COMPLETE keyboard map (no existing binding changed meaning, no new binding shadows ^o/\\/run/Tab/Enter/Esc)? Reproduce the binding map + the focusables build rule from the diff and prove nothing was dropped or shadowed. Cite file:line.` },
    { k: 'scope-debt', focus:
      `SCOPE + DEBT: did it stay PURE TUI (no edit to orch.ts/orch-recipes.ts/orch-run.ts/orch-load.ts/agent.ts/otel.ts/sessions.ts/tools.ts/activity.ts, no change to atoms' Effect session-action semantics — sendAtom/orchestrateAtom/runScriptAtom — or the activity-bus->OrchTree installSink contract)? Did it AVOID vendoring termcast wholesale / importing zustand / building deferred patterns (pagination/toast/vim/nav-stack/Form/theme-persistence) nobody asked for? Any UNMARKED any/ponytail, new unconsumed dead export, or a visual change in theme-tokens that should have been color-preserving (hex-for-hex, incl. node-tree + spinner colors)? Cite file:line.` },
  ]
  const reviews = (await parallel(LENSES.map((l) => () =>
    agent(`Adversarially review the just-committed "${f.key}" change (read the touched files + the diff). Default skeptical. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : '(impl failed — review the working tree)'}\n\nADOPTION PLAN:\n${PLAN}\n\n${SPEC}`,
      { label: `review:${f.key}:${l.k}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
  ))).filter(Boolean)
  let blockers = reviews.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
  log(`${f.key}: ${reviews.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0)} findings, ${blockers.length} blockers`)

  // harden blockers (re-verify both lenses each round)
  let hr = 0
  while (impl && blockers.length > 0 && hr < MAX_HARDEN && (!budget.total || budget.remaining() > 60000)) {
    hr++
    log(`${f.key}: harden ${hr} (${blockers.length} blockers)`)
    impl = await agent(
      `Review found BLOCKERS in "${f.key}". Fix each in the working tree, keep it PURE TUI + every hard invariant intact (esp. the live node-tree, the input spinner, the Tab/Enter focus ring), re-run ${CHECK} to green and ${SMOKE} clean, then AMEND the feature commit (--no-verify).\n\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\nReturn the structured result.\n\n${SPEC}`,
      { label: `harden:${f.key}:${hr}`, phase: f.title, schema: IMPL_SCHEMA, agentType: 'general-purpose' })
    const rr = (await parallel(LENSES.map((l) => () =>
      agent(`Re-review "${f.key}" for your lens; confirm blockers closed, no new ones, no invariant regressed. LENS — ${l.focus}\n\nDIFF:\n${impl ? impl.diff : ''}\n\n${SPEC}`,
        { label: `reverify:${f.key}:${l.k}:${hr}`, phase: f.title, schema: REVIEW_SCHEMA, agentType: 'Explore' })
    ))).filter(Boolean)
    blockers = rr.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker))
  }

  results.push({
    feature: f.key,
    status: impl ? impl.status : 'failed',
    commit: impl ? impl.commitSha : null,
    smokeOk: impl ? impl.smokeOk : false,
    invariantsHeld: impl ? impl.invariantsHeld : [],
    openBlockers: blockers,
    newPonytails: impl ? impl.newPonytails : [],
    healUsed: heal,
    files: impl ? impl.filesChanged : [],
  })
}

// ───────────────────────────────────────────────────────────────────────────
// REPORT — actionable synthesis of what landed + what is now usable
// ───────────────────────────────────────────────────────────────────────────
phase('Report')
const report = await agent(
  `Write the final report for the ax2 author (blunt, terse, full technical substance). termcast/Raycast UI patterns were grafted into the ax2 chat TUI feature-by-feature on main (theme-tokens, focus-descendants, action-panel, master-detail), each committed.\n\nCover: (1) HEADLINE — how many of the 4 grafts landed green, anything partial/failed — say it plainly, do NOT oversell. (2) PER-FEATURE — status, commit sha, what it enables, open blockers. (3) WHAT IS NOW USABLE — can the user open a Ctrl+K command palette? is the transcript a master-detail List+Detail? is color themed via tokens? does the keyboard map still match the old one (incl. ^o / /run / Tab / Enter-toggle)? (4) REGRESSIONS FOUND — any of the hard invariants (collapsible transcript / per-tool views / LIVE NodeView tree / animated input spinner / Tab-Enter focus ring / keyboard model) that broke, and whether it was fixed. (5) RESIDUAL RISK — new ponytails (with Upgrade triggers), the deferred termcast patterns (pagination/toast/vim/nav-stack/Form/theme-persistence) and their triggers, the known lint-red pre-existing user dead exports (NOT ours). (6) NEXT — the single most valuable follow-up. If anything is red or has open blockers, headline it.\n\nRESULTS (JSON):\n${JSON.stringify(results, null, 1)}\n\nPLAN (for deferred list + invariants):\n${PLAN}`,
  { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, agentType: 'Explore' })

return { plan, features: results, report }
