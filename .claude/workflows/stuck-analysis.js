export const meta = {
  name: 'stuck-analysis',
  description: 'READ-ONLY analysis of WHY the rlmcode system sometimes gets stuck / crawls (observed: a simple chat turn at 218s "thinking", after 12 tool steps). Parallel investigators over the suspects — motel-trace evidence (where the time actually goes: slow CF steps vs a real hang/gap), CF contention (concurrent real-CF load + the rate limiter), turn-loop timeout/stall handling (is there a wall-clock cap on a normal turn? does a stalled CF stream hang streamingForward?), and over-exploration (why 12 steps for a trivial question). Adversarially verify each cause, synthesize a RANKED root-cause + fix list. Pure analysis — NO source edits, NO git. Writes docs/STUCK-ANALYSIS.md.',
  phases: [
    { title: 'Probe',     detail: 'parallel READ-ONLY investigators — motel evidence, CF contention, turn timeout/stall, over-exploration. Each returns causes (severity, isRootCause, where, evidence)' },
    { title: 'Verify',    detail: 'adversarial skeptic per claimed root cause — real (a hang / unbounded latency) or just expected slow-CF? demand trace/code evidence' },
    { title: 'Synthesize', detail: 'rank confirmed root causes + concrete fixes (per-turn wall-clock cap, stream-stall timeout, CF throttle/serialize, trim exploration); write docs/STUCK-ANALYSIS.md' },
  ],
}

const SPEC = `
rlmcode = TUI agent on @ax-llm/ax → CF Workers AI (Kimi K2.7, a THINKING model that streams reasoning_content). OBSERVED PROBLEM: a SIMPLE chat
turn ("can u write a .claude/workflow?") sat at "thinking… 218s" (3.6 min) after the agent did 12 tool steps (Bash/Search/9 reads), spinner live,
42.2k tok. Either a real HANG or unacceptable crawl. FIND why — read-only.

SUSPECTS:
- CF CONTENTION: multiple things hit the ONE CF endpoint concurrently (the campaign's workflows ran real-CF live proofs; the user's chat is real
  CF). Earlier measured: solo ~6.5s/turn, but 25-47s under concurrent load (CF saturation). With more concurrent real-CF, a turn's per-step latency
  balloons. The rate limiter (runtime.ts rateLimiter / RLM_MAX_RPS) — does it help or starve? Are there 429s in the traces?
- TURN TIMEOUT / STALL: a NORMAL chat turn (agent.ts turn() → chat.streamingForward drain in run.ts) — is there a WALL-CLOCK cap, or only maxSteps
  (RLM_MAX_STEPS, default 50)? If CF streams a chunk then STALLS (no more chunks, no done), does the for-await on streamingForward HANG forever (no
  per-stream/per-step timeout)? Nodes have withTimeout (orch-resilience); does the MAIN turn loop? This is the real-hang suspect.
- OVER-EXPLORATION: why 12 steps + 9 reads for a trivial question? The system prompt / the orchestration overlay (agent.ts) — does it over-encourage
  exploration/tool-use? maxSteps default? Each step = a CF round-trip, so 12 slow steps = minutes regardless of contention.
- THINKING-MODEL COST: Kimi streams a long reasoning_content; a verbose thinking pass + 12 steps + slow CF compounds. Is the elapsed "thinking" the
  client counter (run start → now) covering all 12 steps, i.e. it's been WORKING 218s (slow), not frozen?

STRICT READ-ONLY: do NOT edit source, do NOT git, do NOT touch src/tui (a UI workflow is editing it). You MAY read any file, run 'bun run check'
(tsc), query motel (curl 127.0.0.1:27686/api/traces?limit=40 + /api/traces/<id>/spans — find the long traces, read per-span timings, look for a
GAP = a span open with no child progress for a long time = a hang, vs continuous slow steps = just slow-CF). Distinguish HANG (a fix-able defect:
no timeout) from CRAWL (slow CF / over-exploration / contention — a tuning/UX fix). The ONLY write allowed is docs/STUCK-ANALYSIS.md.
`

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['suspect', 'causes'],
  properties: { suspect: { type: 'string' }, causes: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['title', 'severity', 'isRootCause', 'kind', 'where', 'evidence'],
    properties: {
      title: { type: 'string' }, severity: { type: 'string', description: 'critical | high | medium | low' },
      isRootCause: { type: 'boolean' }, kind: { type: 'string', description: 'hang | crawl | contention | ux' },
      where: { type: 'string' }, evidence: { type: 'string', description: 'trace id/span timing or code path — not a vibe' },
    } } } },
}
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['title', 'confirmed', 'reasoning', 'fix'],
  properties: { title: { type: 'string' }, confirmed: { type: 'boolean' }, reasoning: { type: 'string' }, fix: { type: 'string' } },
}

const SUSPECTS = [
  { key: 'motel-evidence', prompt: `Query motel (curl 127.0.0.1:27686/api/traces?limit=40) for rlmcode traces, find the LONGEST-duration ones (the 218s-class turn or similar). For the longest, GET /api/traces/<id>/spans and read per-span timings. WHERE does the time go — is it (a) many sequential AxGen/Tool spans each taking 10-40s (slow CF / contention), or (b) ONE span open for a huge gap with no child progress (a HANG — no timeout)? Count the steps. Report the trace ids + the per-span breakdown as evidence; classify hang vs crawl.` },
  { key: 'turn-timeout', prompt: `Read agent.ts turn() (the streamingForward drain) + run.ts runTurn + orch-resilience.ts (the withTimeout nodes use). Is there a WALL-CLOCK timeout on a NORMAL chat turn, or only maxSteps (RLM_MAX_STEPS)? Critically: if CF streams a chunk then STALLS (stops sending, never emits done), does the 'for await (const d of chat.streamingForward(...))' loop HANG forever with no per-chunk/per-stream timeout + no abort? Trace the abort path (turnAborters / the AbortSignal into forward). Is a stalled stream un-recoverable except by the user hitting esc? Report the exact code path + whether a hang is possible (the real-defect suspect).` },
  { key: 'cf-contention', prompt: `Read runtime.ts (the rateLimiter / RLM_MAX_RPS / minIntervalRateLimiter) + how turns + workflow nodes share the ONE CF service. Quantify: with N concurrent real-CF callers (the user's chat + any workflow live-proof + orch fan-out nodes), what's the per-call latency vs the rate limit? Look in motel for 429/rate_limited or long gaps that correlate with concurrent activity. Is the rate limiter too aggressive (queuing/starving) or absent? Report whether contention explains 218s (with evidence) + the tuning fix.` },
  { key: 'over-exploration', prompt: `Why does the agent do 12 steps + 9 reads for a TRIVIAL question ("can u write a workflow?")? Read agent.ts BASE_PROMPT + the orchestration overlay (RLM_WORKFLOW_OVERLAY) + RLM_MAX_STEPS default + the tool-loop. Does the prompt over-encourage exploration/tool-use (vs "answer directly for simple asks")? Is maxSteps too high (50)? Each step is a CF round-trip → 12 steps = minutes even at solo latency. Report the prompt/maxSteps drivers + the fix (steer the model to answer trivial asks directly / cap exploration).` },
]

phase('Probe')
const probes = (await parallel(SUSPECTS.map(s => () =>
  agent(`READ-ONLY stuck-analysis — suspect "${s.key}". ${s.prompt}\n\nReturn causes (severity, isRootCause, kind hang|crawl|contention|ux, where file:line/trace-id, evidence concrete). Distinguish a real HANG (fixable defect) from a CRAWL (tuning/UX). NO edits.\n\n${SPEC}`,
    { label: `probe:${s.key}`, phase: 'Probe', schema: FINDINGS, agentType: 'Explore' })
))).filter(Boolean)
const all = probes.flatMap(p => (p.causes || []).map(c => ({ ...c, suspect: p.suspect })))
log(`probe: ${all.length} causes; ${all.filter(c => c.isRootCause).length} flagged root; hangs=${all.filter(c => c.kind === 'hang').length}`)

phase('Verify')
const toVerify = all.filter(c => c.isRootCause || c.severity === 'critical' || c.severity === 'high' || c.kind === 'hang')
const verdicts = (await parallel(toVerify.map(c => () =>
  agent(`Adversarially verify this claimed root cause of the system getting stuck — REAL or expected/over-stated? Read the cited code/trace yourself. A HANG (no timeout → indefinite freeze) is a real defect; a CRAWL (slow CF, over-exploration, contention) is a tuning/UX issue (still worth fixing, but classify it right). Give the concrete fix.\nCAUSE: ${c.title}\nKIND: ${c.kind}\nWHERE: ${c.where}\nEVIDENCE: ${c.evidence}\n\n${SPEC}`,
    { label: `verify:${(c.title || '').slice(0, 30)}`, phase: 'Verify', schema: VERDICT, agentType: 'Explore' })
))).filter(Boolean)
const confirmed = verdicts.filter(v => v.confirmed)
log(`verify: ${confirmed.length}/${toVerify.length} confirmed`)

phase('Synthesize')
const report = await agent(
  `Synthesize WHY rlmcode gets stuck (blunt, terse, markdown) AND write docs/STUCK-ANALYSIS.md (the ONE additive write only — NOT src, NOT git). Structure: (1) headline — is the 218s a HANG (defect, no timeout) or a CRAWL (slow-CF/contention/over-exploration)? quote the trace evidence. (2) RANKED root causes (title · kind · where · the fix). (3) the fixes, prioritized: e.g. a per-turn WALL-CLOCK cap + a stream-stall timeout (if a hang is possible), CF throttle/serialize concurrent callers, steer the model to answer trivial asks directly + cap maxSteps. (4) which is the campaign priority (a hang = urgent pre-0.0.1; a crawl = a tuning/UX phase). Be honest — separate the real hang-defect from the slow-CF reality.\n\nCAUSES:\n${JSON.stringify(all, null, 1)}\n\nVERDICTS:\n${JSON.stringify(verdicts, null, 1)}`,
  { label: 'synthesize', phase: 'Synthesize', agentType: 'general-purpose' })
return { causes: all.length, confirmed: confirmed.length, report }
