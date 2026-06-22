// orch-tasks — a TINY labelled task set for the GEPA router optimize (orch-optimize.ts).
// Each task carries human criteria + the EXPECTED router actions (the gold label the
// deterministic metric scores against). DELIBERATELY small: enough to exercise the
// optimize wiring + a real (manual) run, not a full benchmark.
//
// TRAIN and HELD-OUT (validation) are DISTINCT sets (no task overlap) — GEPA selects
// candidates on the held-out set, so reusing train would overfit (the ax-gepa rule).
// ponytail: hand-written labels (a few examples). Upgrade: grow the set from real
// orchestrate traces (mine the live tool's strategy/branch/model choices that scored well).
import type { RouterTask } from "./orch-optimize.ts"

// TRAIN — the examples GEPA bootstraps demos from + evolves the instruction against.
export const TRAIN_TASKS: ReadonlyArray<RouterTask> = [
  {
    task: "Summarize this 200-line file into 3 bullet points.",
    criteria: "Single, cheap, no fan-out — one model answers directly.",
    expectedActions: { model: "kimi", strategy: "parallel", branches: 1 },
  },
  {
    task: "Draft three different API designs for a rate limiter, then pick the best one.",
    criteria: "Generate several candidates, then judge — best-of-N.",
    expectedActions: { model: "kimi", strategy: "judge", branches: 3 },
  },
  {
    task: "Refactor this auth module and make sure you didn't break the security model.",
    criteria: "Produce then adversarially verify — correctness/safety matters.",
    expectedActions: { model: "glm", strategy: "verify", branches: 2 },
  },
  {
    task: "Parse this log dump into structured events, then aggregate them into a daily report.",
    criteria: "Staged structured transform — pipeline threads typed output stage to stage.",
    expectedActions: { model: "kimi", strategy: "pipeline", branches: 2 },
  },
  {
    task: "Propose four caching strategies for this read-heavy endpoint and choose one.",
    criteria: "Fan out candidates then judge the best.",
    expectedActions: { model: "kimi", strategy: "judge", branches: 4 },
  },
  {
    task: "Prove this concurrency fix is race-free by having skeptics try to break it.",
    criteria: "Adversarial verification of a single produced answer.",
    expectedActions: { model: "glm", strategy: "verify", branches: 2 },
  },
]

// HELD-OUT (validation) — DISTINCT tasks GEPA scores candidates on. Never in TRAIN.
export const VALIDATION_TASKS: ReadonlyArray<RouterTask> = [
  {
    task: "Rename a variable across this file and confirm the change.",
    criteria: "Trivial — one cheap node, no fan-out.",
    expectedActions: { model: "kimi", strategy: "parallel", branches: 1 },
  },
  {
    task: "Generate three migration plans for this schema change and select the safest.",
    criteria: "Candidates then judge.",
    expectedActions: { model: "kimi", strategy: "judge", branches: 3 },
  },
  {
    task: "Harden this crypto helper and have reviewers attack the implementation.",
    criteria: "Produce then adversarially verify — security-sensitive.",
    expectedActions: { model: "glm", strategy: "verify", branches: 2 },
  },
  {
    task: "Extract entities from these docs, then roll them up into a summary table.",
    criteria: "Staged structured transform — pipeline.",
    expectedActions: { model: "kimi", strategy: "pipeline", branches: 2 },
  },
]
