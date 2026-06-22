# Orchestration GUIDE

The agent can run deterministic **multi-node** flows, not just single replies. The
unit everywhere is a **NODE** (`node`, `runNode`) — never "leaf/agent/worker/job".

Three tools:

| tool               | what                                                            |
| ------------------ | -------------------------------------------------------------- |
| `orchestrate`      | fan a task out across parallel sub-agent nodes, then combine   |
| `run_orch_script`  | run a saved `.ax/orch/<name>.ts` flow you authored             |
| `run_rlm`          | mine a BIG blob in a code runtime (kept out of the prompt)     |

---

## Decision guide — single turn vs `orchestrate` vs `run_orch_script` vs `run_rlm`

Pick the SMALLEST thing that does the job. In order of preference:

| do this …                | when …                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| **a single turn (you)**  | the work is trivial, or strictly sequential (`read → edit → test`), or one investigation. **Default.** Use your own file/shell tools. |
| **`orchestrate`**        | the work splits into INDEPENDENT parts (distinct `subtasks` — division of labour), OR you want best-of-N (`judge`/`best_of_n`) or a verified answer (`verify`), OR you want a planner to auto-decompose (`plan`). The 5 fixed strategies cover most fan-outs. |
| **`run_orch_script`**    | you need a SHAPED flow the fixed strategies don't express — a typed multi-stage `pipeline`, a `loopUntilDry`, a gated adversarial `verifiedStep`, per-stage model routing. `write_file` the script to `.ax/orch/<name>.ts`, then run it by name. |
| **`run_rlm`**            | the CONTEXT is a BIG blob (a 12k-line bundle, a giant log, a whole concatenated module) that won't fit a node's prompt window. The blob is loaded into a code runtime; a sub-LM writes JS to mine it. |

**DON'T orchestrate when:**

- The task is **trivial or strictly sequential** — do it directly. `read → edit → test`
  is **one node's task** (yours), not a fan-out.
- Do **not** fan out a one-liner. Do **not** spin a node up to read one file or run one
  command. Orchestration is for INDEPENDENT work or N-way redundancy.
- **Scale to what's asked**: don't request more `branches` than the task has distinct
  parts. One distinct part ⇒ no fan-out at all.

---

## Strategy menu (`orchestrate`'s `strategy`)

| strategy     | one-line when                                                       |
| ------------ | ------------------------------------------------------------------- |
| `parallel`   | fan DISTINCT subtasks, return all (default — division of labour)    |
| `judge`      | run N, one judge picks the single best verbatim                     |
| `verify`     | answer once, N skeptics vote accept/reject                          |
| `best_of_n`  | re-run the fan-out until the survivor count is stable, then judge   |
| `plan`       | a planner node auto-decomposes `task`, then fans out one node/part  |

```js
// division of labour — distinct subtasks, branch i works subtasks[i]
orchestrate({ subtasks: ['audit src/auth for bugs', 'check tests cover edge cases', 'review error handling'] })

// best of 3 — one judge picks the best
orchestrate({ task: 'design a token-bucket rate limiter', strategy: 'judge', branches: 3 })

// answer once + 3 skeptics vote
orchestrate({ task: 'is this DB migration safe to run?', strategy: 'verify', branches: 4 })

// auto-decompose then fan out one node per subtask
orchestrate({ task: 'refactor the auth module', strategy: 'plan' })

// route nodes to a stronger engine + thinking level
orchestrate({ subtasks: ['…','…'], model: 'glm', effort: 'high' })
```

Each strategy ships as a runnable reference script you can read or `/run` directly:

| strategy   | shipped script              | run it                                              |
| ---------- | --------------------------- | --------------------------------------------------- |
| `parallel` | `.ax/orch/fanout.ts`        | `run_orch_script({ name: 'fanout' })`               |
| `judge`    | `.ax/orch/judge.ts`         | `run_orch_script({ name: 'judge', message: '…' })`  |
| `verify`   | `.ax/orch/verify.ts`        | `run_orch_script({ name: 'verify', message: '…' })` |
| pipeline   | `.ax/orch/pipeline.ts`, `.ax/orch/structured-pipe.ts` | `run_orch_script({ name: 'pipeline', message: '…' })` |

---

## Hard rules

1. **DISTINCT subtasks, never N copies.** Pass `subtasks` for division of labour.
   Only omit them (run `task` on every branch) when you genuinely want N **redundant**
   attempts (e.g. `best_of_n`).
2. **Fork memory per branch.** In a custom script call `ctx.optsFor()` for a fresh
   `AxMemory` per parallel node — **never** share a mutating memory across concurrent
   branches (their histories would interleave and corrupt each other).
3. **Stay bounded.** `branches` caps at 100 (~8 run at once via `parallelLimit`, the
   rest queue). A per-run advisory token budget nudges at the soft line; only a hard
   runaway ceiling aborts.
4. **Pick model + thinking per node.** `model: 'kimi'` (default) or `'glm'`; `effort:
   'low' | 'medium' | 'high' | 'xhigh' | 'max'`. In a script: `optsFor({ model: 'glm',
   effort: 'high' })`.
5. **One level deep.** Sub-agent nodes carry the file/shell tools ONLY and cannot
   themselves orchestrate (structural guard).
6. **An RLM actor writes PURE JS.** Inside `run_rlm` the sub-LM runs in a sandboxed
   ES-module runtime — **NEVER** `require`/`import` (they throw); the data is already a
   runtime variable.

---

## Custom scripts — `run_orch_script`

Write a script to `.ax/orch/<name>.ts` (trusted dir; escaping paths are rejected)
exporting `orchestrate(ctx, prims)`, then `run_orch_script({ name })`. A script needs
**NO runtime imports** — everything comes through `prims`.

```ts
export const orchestrate = async (ctx, prims) => { /* … */ return { reply: '…' } }
```

**`ctx`** = `{ sessionId, message, rootId, ai, model, budget, onEvent, optsFor(choice?), usageOf }`

- `message` — the user input passed to the tool.
- `rootId` — stable id your nodes nest under (`` `${rootId}/extract` ``).
- `ai` — the `AxAIService` to forward against.
- `optsFor(choice?)` — **fresh forked `AxMemory`** per call (multi-model: pass
  `{ model, effort }`).
- `budget` — advisory token gate; `usageOf(gen)` reads a node's usage to charge it.
- `onEvent` — the live-tree event sink.

**`prims`** = 5 core + `gen` factory + 13 recipes/helpers (18 items total):

| group           | members                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| core (5)        | `node`, `parallel`, `pipeline`, `emit`, `allocate`                             |
| factory (1)     | `gen(signature, description?)` → builds a typed `AxGen` inline                 |
| basic recipes (5)   | `runNode`, `judge`, `loopUntilDry`, `adversarialVerify`, `structuredPipeline` |
| verified-step (3)   | `untilGate`, `verifyHarden`, `verifiedStep`                                |
| journal (3)         | `journaledNode`, `loadJournal`, `saveJournal`                              |
| routing (2)         | `resolveModel`, `MODELS`                                                   |

**core + factory + basic recipes:**

- `node(gen, opts)(ai, input)` — the only thing that calls ax `forward()`.
- `runNode(spec, ai, input)` — runs ONE node bracketed by start→done|error events,
  charges the budget, handles graceful max-steps. **Prefer this** over bare `node`.
- `parallel(thunks)` — fan-out, failed slots → `null` (`.filter(Boolean)`).
- `pipeline(items, ...stages)` — fan-through async generator, **no barrier**.
- `structuredPipeline(stages, ai, input, onEvent, rootId)` — thread TYPED structured
  outputs stage→stage.
- `judge(ai, candidates, judgeGen, opts, mapInput)` — N candidates → one verbatim pick.
- `loopUntilDry(body, isDry, max)` — repeat `body` until `isDry(prev, next)`.
- `adversarialVerify(produce, skeptics, accept?)` — produce once, fan skeptics, tally
  votes (**default-refuted**: accepted only if the votes carry it).

**verified-step recipes** — produce → cheap-gate → adversarial-harden, all
budget-bounded (compose ONLY adversarialVerify + your closures; no 6th core prim):

- `untilGate(produce, gate, max=4)` — run `produce(prevFailure)`, check `gate(result)`;
  on failure re-run with the prior result fed back so it self-corrects, up to `max`.
  Returns `{ result, passed }` (best-so-far, never throws). Use when a step has a cheap
  pass/fail check (tests pass / non-empty / compiles).
- `verifyHarden(value, skeptics, fix, max=2, accept?)` — `adversarialVerify` the value;
  while refuted and under `max`, call `fix(value, votes)` and re-verify. Returns
  `{ value, accepted, votes }`. Use to harden an answer against N skeptics with a repair
  loop.
- `verifiedStep({ produce, gate, skeptics, fix, budget?, gateMax?, hardenMax?, accept? })`
  — THE composed verified step: `untilGate` then `verifyHarden`, with a SOFT-budget
  early-out (over soft ⇒ return best-so-far, never infinite). Returns
  `{ value, passedGate, accepted, votes, stoppedOnBudget }`. Use when one unit of work
  must both pass a gate AND survive skeptics under a token ceiling.

**journal recipes** — opt-in crash/network-resilient resume (OFF by default; normal
nodes are unaffected unless a script passes `{ enabled: true }` + a `Journal`):

- `journaledNode(gen, opts, spec)(ai, input)` — wraps `node()`: a key HIT replays the
  cached result (no `forward()`), a MISS runs the node, records it, and `persist()`s.
  Use for long multi-node runs you want to resume after a crash.
- `loadJournal(sessionId)` → `Promise<Journal>` — read (or init) the resume journal.
- `saveJournal(journal)` → `Promise<void>` — persist it (the default `persist`).

**routing helpers** — for a script to enumerate/route the model pool (you usually pass
`{ model, effort }` straight to `optsFor()`; these are for inspecting the pool):

- `resolveModel(name)` → the chosen pool entry (`'kimi'` default | `'glm'`). Route a
  node by `optsFor({ model: resolveModel('glm').id })`.
- `MODELS` — the full two-entry registry (enumerate/label the pool: Kimi + GLM).

> **DEFAULT to a pipeline over parallel** when stages depend on each other. Use
> `parallel` only for genuinely independent work. Add a barrier (collect all then
> proceed) **only** when a stage needs ALL prior results.

### Template — typed structured pipeline

```ts
// .ax/orch/digest.ts  →  run_orch_script({ name: 'digest', message: '…' })
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, onEvent, optsFor, usageOf, budget } = ctx
  const { gen, structuredPipeline } = prims

  // stage k's OUTPUT field name MUST equal stage k+1's INPUT field name.
  const extract = gen("message:string -> facts:json", "Extract { topic, points } as JSON.")
  const summarise = gen("facts:json -> summary:string", "Summarise the facts in one paragraph.")

  const out = (await structuredPipeline(
    [
      { gen: extract, opts: optsFor(), nodeId: `${rootId}/extract`, phase: "extract", budget, usageOf: (g) => usageOf(g) },
      { gen: summarise, opts: optsFor(), nodeId: `${rootId}/summarise`, phase: "summarise", budget, usageOf: (g) => usageOf(g) },
    ],
    ai,
    { message },
    onEvent,
    rootId,
  )) as { summary?: string }

  return { reply: out.summary ?? "(no summary)" }
}
```

### Template — parallel fan-out with forked memories

```ts
// .ax/orch/fanout.ts
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { parallel, runNode, gen } = prims

  const personas = ["You are a terse senior engineer.", "You are a careful reviewer."]
  const replies = await parallel(
    personas.map((p, i) => async () => {
      const nodeId = `${rootId}/cand-${i}`
      onEvent({ type: "start", nodeId, parentId: rootId, phase: `candidate ${i + 1}` })
      const out = await runNode(
        { nodeId, gen: gen("message:string -> reply:string", `${p} Answer directly.`), opts: optsFor(), onEvent, budget, usageOf: (g) => usageOf(g) },
        ai,
        { message },
      )
      return (out as { reply?: string }).reply ?? ""
    }),
  )
  const reply = replies.find((r): r is string => typeof r === "string" && r.length > 0) ?? "(none)"
  return { reply }
}
```

### Template — `loopUntilDry` (refine until it converges)

```ts
// .ax/orch/refine.ts  →  run_orch_script({ name: 'refine', message: '…' })
import type { OrchLoadCtx, OrchPrims } from "../../src/orch-load.ts"

export const orchestrate = async (ctx: OrchLoadCtx, prims: OrchPrims) => {
  const { message, rootId, ai, budget, onEvent, optsFor, usageOf } = ctx
  const { runNode, loopUntilDry, gen } = prims

  const draft = gen("message:string -> reply:string", "Improve the answer; return your best current version.")
  let round = 0
  // Re-run the body until two consecutive outputs are (nearly) the same length, OR the
  // SOFT budget is crossed (never infinite — overSoft() is the early-out, max=6 is the cap).
  const final = await loopUntilDry(
    async () => {
      if (budget.overSoft()) return "(stopped: over soft budget)"
      const nodeId = `${rootId}/round-${round++}`
      const out = await runNode(
        { nodeId, parentId: rootId, gen: draft, opts: optsFor(), onEvent, budget, usageOf: (g) => usageOf(g) },
        ai,
        { message },
      )
      return (out as { reply?: string }).reply ?? ""
    },
    (prev, next) => Math.abs(prev.length - next.length) < 16, // "dry" = converged
    6,
  )
  return { reply: final }
}
```

### Template — `plan` (auto-decompose, then fan out)

The `plan` STRATEGY of the `orchestrate` tool already does this — a planner node splits
`task` into distinct subtasks, then fans out one node per subtask:
`orchestrate({ task: 'refactor the auth module', strategy: 'plan' })`. Reach for a SCRIPT
only when you need to post-process the plan (e.g. judge the per-subtask results). To
hand-roll decomposition in a script: run one planner gen to produce a JSON subtask list,
then `parallel()` over it (one forked-memory `runNode` per subtask) exactly like
`.ax/orch/fanout.ts` but with the list coming from the planner instead of a constant.

### Budget-gated loops

Once `budget.overSoft()`, stop adding rounds — never infinite. `verifiedStep` does this
for you (returns `stoppedOnBudget`); in a hand-rolled `loopUntilDry`/`verifyHarden` loop,
check `overSoft()` between rounds and return best-so-far (see the `loopUntilDry` template
above). (See the prims table above for the full recipe list — `judge`, `loopUntilDry`,
`adversarialVerify`, the verified-step trio, the journal trio, and the routing helpers.)

### Shipped reference scripts (read these, or `/run` them)

| script                        | strategy / shape           | exercises                                            |
| ----------------------------- | -------------------------- | ---------------------------------------------------- |
| `.ax/orch/fanout.ts`          | `parallel` (DISTINCT work) | `parallel` + `runNode` over forked memories          |
| `.ax/orch/judge.ts`           | best-of-N                  | `parallel` candidates + `judge` verbatim pick        |
| `.ax/orch/verify.ts`          | adversarial verify         | `adversarialVerify` (produce once + N skeptics vote) |
| `.ax/orch/pipeline.ts`        | 3-stage typed pipeline     | `structuredPipeline` (facts→outline→summary)         |
| `.ax/orch/structured-pipe.ts` | 2-stage typed pipeline     | `structuredPipeline` (message→facts→summary)         |
| `.ax/orch/example.ts`         | parallel best-effort       | `parallel` + `runNode`, first non-empty reply        |

Every one of these LOADS + RUNS through `run_orch_script` (no invented API — they use only
the real `ctx`/`prims`).

---

## `run_rlm` — mine a big blob

```js
run_rlm({ context: <the entire 12k-line bundle.js>, query: 'which function registers the /auth route and what middleware does it apply?' })
```

The blob is loaded into a code runtime; the sub-LM writes JS (`slice`/regex/`llmQuery`)
to explore it and returns an answer + evidence. **Prefer this over `orchestrate`** when
the context is too big to fit a node's prompt window. The actor writes **PURE sandboxed
JS** — no `require`/`import`; the data is already a runtime variable. Single level: the
RLM cannot orchestrate or call file tools.

---

## Anti-patterns

- ❌ **Fanning out a trivial/sequential chore.** `read → edit → test` is one node — do
  it directly.
- ❌ **N copies of the same subtask** under `parallel` (that's redundancy, not division
  of labour — only `best_of_n`/`judge` want redundancy).
- ❌ **Sharing one `AxMemory` across concurrent branches** — always `optsFor()` per node.
- ❌ **`parallel` when stages depend on each other** — use a pipeline; barrier only when
  a stage needs ALL prior results.
- ❌ **`require`/`import` inside an RLM actor** — it throws; the data is a runtime var.
- ❌ **Reifying a new pattern into the core** — the engine core stays the 5 prims;
  compose recipes in userland scripts, never add a 6th primitive.
- ❌ **Over-scaling `branches`** — match the count to the distinct parts of the task.
