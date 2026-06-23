export const meta = {
  name: 'release-readiness',
  description: 'Adversarial pre-tag audit for rlmcode v0.0.1: re-run every gate (check/test/test:tui/sdk:smoke/analyze/debt) for real + audit release hygiene (version consistency, CHANGELOG/README accuracy, license, .env.example), security/eval-honesty (unsandboxed warning, NO committed secrets, .gitignore), dead-code/debt/structure (yuku, ponytail Upgrade lines, crosscore boundary, file budgets, stray files), and the SDK barrel seam. Candidate blockers are adversarially verified; output GO/NO-GO + a verified blocker list. READ-ONLY except its report — does NOT tag (the tag is the human-controlled action).',
  phases: [
    { title: 'Audit', detail: '5 parallel lenses: gates / hygiene / security / dead-code / sdk-seam — run gates for real, cite file:line, list blockers + green-gate proofs' },
    { title: 'Verify', detail: 'adversarially verify each candidate blocker — is it a REAL release-blocker for a 0.0.1, or cosmetic?' },
    { title: 'Synthesize', detail: 'GO / NO-GO + the verified blocker list + version/CHANGELOG/gate confirmation' },
  ],
}

const FINDINGS = { type: 'object', additionalProperties: false, required: ['lens', 'greenGates', 'blockers', 'notes'],
  properties: {
    lens: { type: 'string' },
    greenGates: { type: 'array', items: { type: 'string' }, description: 'gates/checks CONFIRMED green, with evidence (exit code + output tail)' },
    blockers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'isBlocker', 'where', 'problem', 'fix'],
      properties: { severity: { type: 'string' }, isBlocker: { type: 'boolean' }, where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } },
    notes: { type: 'array', items: { type: 'string' } },
  } }
const VERDICT = { type: 'object', additionalProperties: false, required: ['where', 'isRealBlocker', 'reasoning'],
  properties: { where: { type: 'string' }, isRealBlocker: { type: 'boolean' }, reasoning: { type: 'string' } } }
const GONOGO = { type: 'object', additionalProperties: false, required: ['verdict', 'versionOk', 'changelogOk', 'gatesGreen', 'blockers', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['GO', 'NO-GO'] },
    versionOk: { type: 'boolean' }, changelogOk: { type: 'boolean' }, gatesGreen: { type: 'boolean' },
    blockers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['where', 'problem', 'fix'],
      properties: { where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } },
    summary: { type: 'string' },
  } }

const CTX = `rlmcode is about to be tagged v0.0.1 (HEAD on main, repo /Users/umang/hub/ax2). Version is bumped to 0.0.1 (package.json + src/core/sdk.ts RLM_VERSION + src/otel.ts SERVICE_VERSION); CHANGELOG.md is written; all 5 TUI features landed (diff-viewer, polish, static-commit, header-anchors, theme-support). This is the FINAL never-trust gate BEFORE the tag. Be adversarial — hunt ANY real release-blocker. A BLOCKER = something that would break or embarrass a 0.0.1: a RED gate, a committed secret, a broken/false README claim or dead asset link, a version inconsistency, a crash on the default path, a leaking SDK barrel. Cosmetic / nice-to-have / post-0.0.1 = NOT a blocker (put it in notes, do not block). Cite file:line + concrete evidence. Run commands for REAL; never assume green.`

const LENSES = [
  { k: 'gates', p: `GATES lens. Run each, report the EXACT exit code + output tail: \`bun run check\` (tsc), \`bun run test\` (hermetic suite), \`bun run test:tui\` (PTY frame gate, ~31 tests, needs termctrl), \`bun run sdk:smoke\`, \`bun run analyze\`, \`bun run debt\`. greenGates = those that pass (cite exit 0 + tail). blockers = any RED (paste the failing output). Run them for REAL — this is the release gate.` },
  { k: 'hygiene', p: `RELEASE-HYGIENE lens. (1) VERSION: grep package.json + src/core/sdk.ts + src/otel.ts — all 0.0.1, and NO stray "0.1.0" anywhere in src/. (2) CHANGELOG.md vs \`git log --oneline\` + the code — claims real, no invented features, headline present. (3) README.md — does every claimed feature EXIST in src (workflow prims, rlm, themes + /theme, sticky session header, native diff, ⌘K, the SDK barrel)? Do ALL asset links resolve (assets/demo.gif, tui.png, palette.png, theme.png, motel.png exist on disk)? (4) LICENSE + THIRD-PARTY-LICENSES.md present; .env.example present and lists CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (the creds runtime.ts reads). Cite file:line.` },
  { k: 'security', p: `SECURITY / EVAL-HONESTY lens. (1) UNSANDBOXED warning present + honest (README warning block + the host-authority ponytail in src/core/workflow.ts ~line 13). (2) NO COMMITTED SECRETS — \`git grep\` the TRACKED tree for a real Cloudflare token / api key / bearer / "sk-" / a CLOUDFLARE_API_TOKEN with a value; .env must be gitignored AND not tracked (\`git ls-files | grep env\`). (3) .gitignore covers .env, .rlmcode.json (theme persist), the history jsonl. (4) tool-desc/overlay honestly states in-process host access (the eval-honesty commit). A committed secret OR a missing unsandboxed warning = hard BLOCKER. Cite file:line.` },
  { k: 'deadcode', p: `DEAD-CODE / DEBT / STRUCTURE lens. (1) \`bun run analyze\` (yuku) clean — no dead exports, unused imports, circular deps, per-fn budget breaches. (2) every \`ponytail:\` marker has an \`Upgrade:\` line (\`bun run debt\` 0 orphan). (3) crosscore boundary holds — no module outside src/core/ + src/app/ deep-imports a non-barrel src/core/* (analyze enforces; confirm it passed). (4) file-size budgets — any new src file over budget (barrel 300 / impl 500), chat.tsx under 1000? (5) stray/misplaced ROOT files or orphan committed workflow scripts that should not ship in a 0.0.1. Cite file:line.` },
  { k: 'sdkseam', p: `SDK-SEAM lens. (1) examples/sdk-usage.ts imports ONLY ../src/core/sdk.ts (+ @ax-llm/ax) — barrel-only, no deep core import. (2) the barrel src/core/sdk.ts leaks NO Effect / Cause / AxMemory / AxSpan / ChatError / OtelTracerProvider type past it. (3) the public types (TurnEvent / TurnResult / TurnOptions / StopReason / TokenUsage / TurnError / AgentOptions / Info / LogLine) are serializable. (4) \`bun run sdk:smoke\` green. A barrel leak or broken seam = BLOCKER for an SDK release. Cite file:line.` },
]

phase('Audit')
const audits = (await parallel(LENSES.map(l => () =>
  agent(`${l.p}\n\n${CTX}`, { label: `audit:${l.k}`, phase: 'Audit', schema: FINDINGS, agentType: 'Explore' })
))).filter(Boolean)
const candidates = audits.flatMap(a => (a.blockers || []).filter(b => b.isBlocker))
log(`audited ${audits.length}/${LENSES.length} lenses; ${candidates.length} candidate blocker(s)`)

phase('Verify')
const verified = candidates.length === 0 ? [] : (await parallel(candidates.map(b => () =>
  agent(`Adversarially verify this CANDIDATE release-blocker for rlmcode v0.0.1. Is it a REAL blocker (would break or embarrass a 0.0.1), or cosmetic/false/post-0.0.1? Check the ACTUAL repo — reproduce it. Default isRealBlocker=false unless you can SHOW it breaks.\nCANDIDATE: ${JSON.stringify(b)}\n\n${CTX}`,
    { label: `verify:${String(b.where || '').slice(0, 28)}`, phase: 'Verify', schema: VERDICT, agentType: 'Explore' })
))).filter(Boolean)
const realCount = verified.filter(v => v.isRealBlocker).length
log(`${realCount} confirmed real blocker(s) of ${candidates.length} candidate(s)`)

phase('Synthesize')
const synth = await agent(
  `Synthesize the rlmcode v0.0.1 release GO/NO-GO. GO only if ALL gates are green AND there is no CONFIRMED real blocker AND the version is 0.0.1 everywhere AND CHANGELOG + README are accurate. blockers[] = only the CONFIRMED real blockers (with fixes) — exclude cosmetic notes. Be blunt.\nAUDITS:\n${JSON.stringify(audits, null, 1)}\nVERIFIED:\n${JSON.stringify(verified, null, 1)}\n\n${CTX}`,
  { label: 'synthesize', phase: 'Synthesize', schema: GONOGO })
return {
  verdict: synth,
  confirmedBlockers: verified.filter(v => v.isRealBlocker),
  lenses: audits.map(a => ({ lens: a.lens, greenGates: a.greenGates, candidateBlockers: (a.blockers || []).filter(b => b.isBlocker).length, notes: a.notes })),
}
