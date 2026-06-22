// LIVE verify (real CF-Kimi) for the workflow({script}) prims: Kimi AUTHORS a JS script, then
// the in-process engine runs it through buildWorkflowPrims over the EXISTING recipes. Proves
// node events render in the OrchTree and a real synthesized result returns. NOT compile-only.
//
// Run: bun scripts/_workflow_live.ts   (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
import { ax } from "@ax-llm/ax"
import { llm } from "../src/runtime.ts"
import { setActivitySink } from "../src/activity.ts"
import { WORKFLOW_TOOLS } from "../src/workflow.ts"

// Capture node lifecycle events off the activity bus so we can PROVE nodes rendered.
const nodeEvents: string[] = []
setActivitySink((a) => {
  if (a.kind === "node") nodeEvents.push(`${a.event} ${a.nodeId}${a.detail ? " — " + String(a.detail).slice(0, 60) : ""}`)
})

const workflowFunc = WORKFLOW_TOOLS[0]!.func as (
  args: { script: string },
  extra?: { sessionId?: string; ai?: typeof llm; abortSignal?: AbortSignal },
) => Promise<string>

// ── (a) Kimi AUTHORS a fan-out + judge script, then we run it ──────────────────────────
const author = ax("task:string, api:string -> script:string")
author.setDescription(
  "You write a SHORT JS orchestration script body for an in-process workflow engine. The body may ONLY use these prims (already in scope, do NOT redeclare): phase(title), log(msg), agent(prompt)->Promise<string|null>, parallel(thunks)->Promise<(string|null)[]> (BARRIER, null on throw), judge(candidates, criteria?)->Promise<string>, rlm(context,query)->Promise<string>, budget, args. End with a `return`. Return ONLY the body statements (no function wrapper, no markdown fences, no backticks).",
)

const run = async () => {
  console.log("=== (a) authoring a fan-out+judge script via real CF-Kimi ===")
  const authored = (await author.forward(llm, {
    task: "Compare three one-line approaches to reversing a string in JavaScript, then pick the best.",
    api: "phase/log/agent/parallel/judge/rlm/budget/args",
  })) as { script?: string }
  let script = String(authored.script ?? "").trim()
  // Strip any stray fences the model added.
  script = script.replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim()
  console.log("--- AUTHORED SCRIPT (a) ---\n" + script + "\n---------------------------")

  console.log("\n=== running the authored script (a) in-process on real CF ===")
  const out = await workflowFunc({ script }, { sessionId: "live-a", ai: llm })
  console.log("--- RESULT (a) ---\n" + out + "\n------------------")

  // ── (b) a fixed rlm() blob-mine script — prove the rlm node-kind works AS a prim ──────
  console.log("\n=== (b) rlm() blob-mine script (fixed, real CF) ===")
  const blob = [
    "// module routes.js",
    ...Array.from({ length: 40 }, (_, i) => `function handler${i}(req,res){ return res.send('${i}') }`),
    "function registerAuthRoute(app){ app.post('/auth/login', loginHandler) } // <-- the auth route registrar",
    ...Array.from({ length: 40 }, (_, i) => `function misc${i}(){ return ${i} }`),
  ].join("\n")
  const scriptB = "return await rlm(args.blob, 'which function registers the /auth route? name it.');"
  const outB = await workflowFunc(
    { script: scriptB } as { script: string },
    { sessionId: "live-b", ai: llm },
  )
  // args carries the blob — but the tool builds args=undefined; inline the blob into the script instead.
  const scriptB2 = `const BLOB = ${JSON.stringify(blob)}; return await rlm(BLOB, 'which function registers the /auth route? name it.');`
  const outB2 = await workflowFunc({ script: scriptB2 }, { sessionId: "live-b2", ai: llm })
  console.log("--- RESULT (b inline) ---\n" + outB2 + "\n------------------")
  void outB

  console.log("\n=== NODE EVENTS (proves nodes rendered in the OrchTree) ===")
  console.log(nodeEvents.join("\n"))
}

run().then(
  () => process.exit(0),
  (e) => {
    console.error("LIVE FAILED:", e)
    process.exit(1)
  },
)
