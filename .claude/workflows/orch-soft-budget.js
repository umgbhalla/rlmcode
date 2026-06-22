export const meta = {
  name: "orch-soft-budget",
  description:
    "Fix the ROOT-CAUSE budget model in ax2 orchestration, per the claude_code study: a HARD BudgetExhaustedError that kills a leaf mid-work is wrong — token budget should be ADVISORY (nudge/track), and the HARD ceiling should be maxSteps. Plus: scope leaf tools explicitly (Explore-style) and charge RLM per executor turn (not once-after). GATE = real CF-Kimi run, not tsc. Sequential on main, study-grounded, live-verified, commit each.",
  phases: [
    {
      title: "Study",
      detail:
        "current budget model (orch.ts allocate/charge/BudgetExhaustedError, orch-tools, rlm-tool, maxSteps) vs claude_code soft-nudge/hard-steps model",
    },
    {
      title: "soft-budget",
      detail:
        "token budget advisory (track+nudge, never discard a working leaf); maxSteps is the hard stop; high ceiling only aborts a true runaway",
    },
    {
      title: "leaf-scope",
      detail:
        "leaf system prompt explicitly scopes its tools + usage guidance (claude_code Explore-style)",
    },
    {
      title: "rlm-budget",
      detail:
        "RLM charges per executor turn (stream actorTurnCallback.usage), not once after the whole run",
    },
    {
      title: "Report",
      detail:
        "what a live run now proves: leaves complete real work, no spurious budget kills",
    },
  ],
};

const CHECK = "bun run check";
const LIVE = "AX2_LIVE=1 bun --env-file=.env scripts/orch-live.test.ts";
const MAX_HEAL = 5;
const MAX_HARDEN = 2;

const SPEC = `
ax2 self-orchestration on @ax-llm/ax (CF Kimi). Already live-verified working (leaf-real, decompose, rlm-wire) but with the WRONG
budget model. RE-CONFIRM names/lines at Study.

THE ROOT-CAUSE LESSON (from ../claude_code, see memory orchestration-reference-lessons):
  claude_code's TOKEN budget is ADVISORY — it soft-nudges at ~90% and CONTINUES the loop (tokenBudget.ts:64); the HARD ceiling is
  maxTurns/STEPS, checked AFTER an iteration (query.ts:1705). Subagents get NO token continuation.
  ax2 does the OPPOSITE: allocate()/charge() throws BudgetExhaustedError mid-run and DISCARDS the leaf's work (orch.ts ~54; rlm-tool.ts
  charges once AFTER the run). The 40k→2M bump was a band-aid; the MODEL is wrong — a leaf doing real work should never be thrown away
  for crossing a token line. The hard bound is maxSteps (ax enforces "max steps reached" per leaf forward); the token budget is a
  tracking/backstop signal, not a guillotine.

FIXES:
  1. SOFT BUDGET. The token budget must NOT discard a working leaf. Concretely: charge()/the orch boundary should TRACK spend and expose
     it (for the tree/usage), emit a nudge/log when over the soft ceiling, but the leaf result is ALWAYS returned. Keep a VERY HIGH hard
     ceiling (e.g. 20M or AX2_ORCH_TOKEN_BUDGET) that only aborts a genuine runaway (e.g. via abortSignal), never a single completed
     leaf. maxSteps (limits.maxSteps) stays the per-leaf hard stop. Update the orchestrate + run_orch_script handlers so a leaf over the
     soft line returns its real partial/whole result with a note, not a BudgetExhaustedError that nukes the branch. Preserve the typed
     BudgetExhaustedError for the genuine-runaway backstop only (or for explicit freeze()).
  2. LEAF TOOL SCOPING. The leaf system prompt (leafGen in orch-tools.ts: BASE_PROMPT + persona) should ALSO scope its tools explicitly
     — a short line listing its tools (bash/read_file/write_file/edit_file/glob/grep/web_fetch) + guidance (prefer glob/grep to find,
     read before edit, run real commands), like claude_code's Explore agent prompt. Keep it terse; do not bloat.
  3. RLM PER-TURN BUDGET (rlm-tool.ts ponytail ~:44). Charge RLM usage per executor turn via actorTurnCallback.usage (stream it) rather
     than once after the whole run, so a runaway actor can be signalled mid-run. Keep it advisory too (track + nudge, abort only on the
     hard runaway ceiling) — same soft model.

PRINCIPLES: core stays EXACTLY 5 prims in orch.ts. The 4 safety guards stay (BASE_TOOLS-only leaves, branch cap 4, abort, trusted-dir).
Fork mem per branch. Match style. Real @ax-llm/ax types. Unavoidable any => 'ponytail:' + 'Upgrade:'. ${CHECK} green AND, for budget/rlm
fixes, the LIVE harness (${LIVE}) must pass with REAL output (a heavy leaf completes, RLM answers) — NOT a BudgetExhaustedError. The live
harness is gated behind AX2_LIVE=1 (skips in normal lint). Commit each fix --no-verify, conventional message. KEEP bun run lint green.
`;

const FIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["area", "facts", "cites"],
  properties: {
    area: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    cites: { type: "array", items: { type: "string" } },
  },
};
const IMPL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "liveVerified",
    "liveOutput",
    "filesChanged",
    "diff",
    "checkOutput",
    "committed",
    "commitSha",
    "newPonytails",
    "notes",
  ],
  properties: {
    status: { type: "string" },
    liveVerified: { type: "boolean" },
    liveOutput: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    diff: { type: "string" },
    checkOutput: { type: "string" },
    committed: { type: "boolean" },
    commitSha: { type: "string" },
    newPonytails: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
};
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lens", "findings"],
  properties: {
    lens: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "isBlocker", "where", "problem", "fix"],
        properties: {
          severity: { type: "string" },
          isBlocker: { type: "boolean" },
          where: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
  },
};

phase("Study");
const study = (
  await parallel([
    () =>
      agent(
        `Read src/orch.ts (allocate/Budget/charge/BudgetExhaustedError), src/orch-tools.ts (boundary/budget usage, the orchestrate + run_orch_script handlers' catch of BudgetExhaustedError → partial), src/runtime.ts (limits.maxSteps), src/rlm-tool.ts (how it charges budget). Report the EXACT current budget model + where a leaf result gets discarded on BudgetExhaustedError, with file:line. This is what soft-budget rewires.\n\n${SPEC}`,
        {
          label: "budget-now",
          phase: "Study",
          schema: FIND_SCHEMA,
          agentType: "Explore",
        },
      ),
    () =>
      agent(
        `Read src/orch-tools.ts leafGen + PERSONAS, and src/agent.ts BASE_PROMPT. Report how the leaf system prompt is built today and exactly where to append a terse tool-scoping line (the leaf's tools + usage guidance). Also read ../claude_code built-in Explore/agent prompts if present for the scoping style. Cite file:line.\n\n${SPEC}`,
        {
          label: "leaf-prompt",
          phase: "Study",
          schema: FIND_SCHEMA,
          agentType: "Explore",
        },
      ),
    () =>
      agent(
        `Read src/rlm-tool.ts fully + the ax RLM callback shapes (actorTurnCallback payload {stage,turn,usage,isError} from node_modules/@ax-llm/ax/index.d.ts + ../ax/src). Report exactly how to charge usage PER executor turn via actorTurnCallback.usage instead of once-after, with the real payload field for token usage. Cite file:line.\n\n${SPEC}`,
        {
          label: "rlm-budget",
          phase: "Study",
          schema: FIND_SCHEMA,
          agentType: "Explore",
        },
      ),
  ])
).filter(Boolean);
const STUDY = JSON.stringify(study, null, 1);
log(`studied ${study.length}/3`);

const FIXES = [
  {
    key: "soft-budget",
    title: "soft-budget",
    live: true,
    spec: `Rewire the token budget to ADVISORY per the root-cause lesson. A leaf that completes its work must ALWAYS return its result — never get discarded by a BudgetExhaustedError mid-orchestration. Track spend + expose it (tree/usage), nudge/log when over a SOFT ceiling, but return the real result. Keep a very high HARD ceiling (AX2_ORCH_TOKEN_BUDGET default ~20_000_000) that aborts only a genuine runaway (prefer abortSignal), and keep maxSteps (limits.maxSteps) as the per-leaf hard stop. Update orchestrate + run_orch_script so a leaf over the soft line yields its real output, not an error. Keep BudgetExhaustedError typed for the runaway backstop / explicit freeze() only. GATE: live harness (${LIVE}) — a heavy real leaf COMPLETES and returns real output, NOT BudgetExhaustedError. Report the actual output.`,
  },
  {
    key: "leaf-scope",
    title: "leaf-scope",
    live: false,
    spec: `In src/orch-tools.ts leafGen: append a terse tool-scoping line to the leaf system prompt (after BASE_PROMPT+persona) listing the leaf's tools (bash, read_file, write_file, edit_file, glob, grep, web_fetch) and 1-2 lines of usage guidance (prefer glob/grep to locate, read before edit, run real commands before answering), Explore-style. Keep it short — do not restate all of BASE_PROMPT. ${CHECK} green; keep lint green.`,
  },
  {
    key: "rlm-budget",
    title: "rlm-budget",
    live: true,
    spec: `In src/rlm-tool.ts: charge RLM usage PER executor turn via actorTurnCallback.usage (the real token field from study) instead of once after the whole run, under the SAME soft model (track + nudge, abort only on the hard runaway ceiling — never discard a completed RLM answer). Remove/relax the once-after ponytail. GATE: live RLM smoke still answers the buried fact (${LIVE}) and is not killed by budget. Report the actual RLM answer.`,
  },
];

const results = [];
for (let i = 0; i < FIXES.length; i++) {
  const f = FIXES[i];
  if (budget.total && budget.remaining() < 90000) {
    log(`budget low — stop before ${f.key}`);
    break;
  }
  phase(f.title);
  let impl = await agent(
    `Implement "${f.key}" in the ax2 main working tree, grounded in the study (use real ax APIs).\n\nSPEC:\n${f.spec}\n\nRules: ${CHECK} green + keep bun run lint green.${f.live ? ` THEN run the live harness (${LIVE}) — green ONLY if real output (heavy leaf completes / RLM answers), set liveVerified=true + paste liveOutput. A BudgetExhaustedError or empty = RED.` : ""} Self-heal up to ${MAX_HEAL}. Mark shortcuts 'ponytail:' + 'Upgrade:'. When green, COMMIT alone (--no-verify) 'fix(orch): ${f.key} ...'. Report sha/diff/check tail/liveVerified/liveOutput/new ponytails. Do NOT git add -A (unrelated dirty scripts/ from another session) — stage only your files.\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
    {
      label: `impl:${f.key}`,
      phase: f.title,
      schema: IMPL_SCHEMA,
      agentType: "general-purpose",
    },
  );
  let heal = 0;
  while (
    impl &&
    impl.status !== "green" &&
    heal < MAX_HEAL &&
    (!budget.total || budget.remaining() > 60000)
  ) {
    heal++;
    log(`${f.key}: heal ${heal}`);
    impl = await agent(
      `"${f.key}" RED (${CHECK}/lint or live). Fix for real + re-verify${f.live ? ` (${LIVE} must give real output)` : ""}, commit --no-verify.\nFAILING:\n${impl.checkOutput}\nLIVE:\n${impl.liveOutput}\n\nSTUDY:\n${STUDY}\n\n${SPEC}`,
      {
        label: `heal:${f.key}:${heal}`,
        phase: f.title,
        schema: IMPL_SCHEMA,
        agentType: "general-purpose",
      },
    );
  }
  const LENSES = [
    {
      k: "really-works",
      focus: `For "${f.key}": is the budget now SOFT — does a completed leaf return its real result instead of being discarded by BudgetExhaustedError (prove with live output)? Is maxSteps the hard stop? For rlm-budget: per-turn charge wired + RLM still answers? Reject compile-only proof. Cite file:line + quote live output.`,
    },
    {
      k: "safety",
      focus: `4 guards intact (BASE_TOOLS-only leaves, branch cap 4, abort, trusted-dir)? core still 5 prims? runaway is STILL bounded (a true infinite loop aborts via maxSteps + the high hard ceiling)? fork-mem per branch? no unmarked any/ponytail; lint green; single-turn + ^o unbroken? Cite file:line.`,
    },
  ];
  let reviews = (
    await parallel(
      LENSES.map(
        (l) => () =>
          agent(
            `Adversarially review committed "${f.key}". Skeptical; for live fixes demand the real output. LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : "(failed)"}\nLIVE:\n${impl ? impl.liveOutput : ""}\n\n${SPEC}`,
            {
              label: `review:${f.key}:${l.k}`,
              phase: f.title,
              schema: REVIEW_SCHEMA,
              agentType: "Explore",
            },
          ),
      ),
    )
  ).filter(Boolean);
  let blockers = reviews.flatMap((r) =>
    (r.findings || []).filter((x) => x.isBlocker),
  );
  log(
    `${f.key}: live=${impl ? impl.liveVerified : "?"} blockers=${blockers.length}`,
  );
  let hr = 0;
  while (
    impl &&
    blockers.length > 0 &&
    hr < MAX_HARDEN &&
    (!budget.total || budget.remaining() > 60000)
  ) {
    hr++;
    log(`${f.key}: harden ${hr}`);
    impl = await agent(
      `BLOCKERS in "${f.key}" — fix for real, re-verify${f.live ? " (live)" : ""}, AMEND commit (--no-verify).\nBLOCKERS:\n${JSON.stringify(blockers, null, 1)}\n\n${SPEC}`,
      {
        label: `harden:${f.key}:${hr}`,
        phase: f.title,
        schema: IMPL_SCHEMA,
        agentType: "general-purpose",
      },
    );
    const rr = (
      await parallel(
        LENSES.map(
          (l) => () =>
            agent(
              `Re-review "${f.key}"; blockers closed + live still real? LENS — ${l.focus}\nDIFF:\n${impl ? impl.diff : ""}\nLIVE:\n${impl ? impl.liveOutput : ""}\n\n${SPEC}`,
              {
                label: `reverify:${f.key}:${l.k}:${hr}`,
                phase: f.title,
                schema: REVIEW_SCHEMA,
                agentType: "Explore",
              },
            ),
        ),
      )
    ).filter(Boolean);
    blockers = rr.flatMap((r) => (r.findings || []).filter((x) => x.isBlocker));
  }
  results.push({
    feature: f.key,
    status: impl ? impl.status : "failed",
    commit: impl ? impl.commitSha : null,
    liveVerified: impl ? impl.liveVerified : false,
    liveOutput: impl ? (impl.liveOutput || "").slice(0, 300) : "",
    openBlockers: blockers,
    newPonytails: impl ? impl.newPonytails : [],
  });
}

phase("Report");
const report = await agent(
  `Final report (blunt, terse, markdown, no spin). Per fix (soft-budget, leaf-scope, rlm-budget): green/red, commit, and for live fixes QUOTE the real CF-Kimi output proving a leaf/RLM COMPLETES (not killed by budget). Then: (1) is the budget model now SOFT (advisory token, hard maxSteps) — no more spurious BudgetExhaustedError on working leaves? (2) is a true runaway still bounded? (3) 4 guards intact? lint green? (4) residual ponytails. (5) one honest line: is ax2 orchestration now reliable end-to-end. Headline anything red or only compile-verified.\n\nRESULTS:\n${JSON.stringify(results, null, 1)}`,
  { label: "report", phase: "Report" },
);
return { features: results, report };
