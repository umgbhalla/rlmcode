#!/usr/bin/env bun
// TEMP standalone probe: verify the rlm-node SANDBOX_RULE fix (name the `context` runtime var)
// makes the buried fact come back. Calls runRlm() DIRECTLY (onEvent defaults to no-op), so it
// does not depend on the concurrently-churning activity.ts sink / workflow layer. Delete after.
import { ai, type AxAIService } from "@ax-llm/ax"
import { runRlm } from "../src/core/rlm-node.ts"
import { MODEL, rateLimiter } from "../src/core/runtime.ts"

const apiKey = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
if (!apiKey || !accountId) throw new Error("needs CF creds in .env")
const svc: AxAIService = ai({ name: "openai", apiKey, apiURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`, config: { model: MODEL as never } })
svc.setOptions({ rateLimiter })

const blobLines: string[] = []
for (let i = 0; i < 60; i += 1) blobLines.push(`function helper${i}(x){ return x + ${i}; } // util ${i}`)
blobLines.splice(37, 0, "function registerAuthRoute(app){ app.post('/auth/login', loginHandler) } // <-- the auth route registrar")
const blob = blobLines.join("\n")

const nodes: string[] = []
const out = await runRlm(blob, "which function registers the /auth route? name it.", svc, "probe-rlm", new AbortController().signal, (e) => {
  nodes.push(`${e.type} ${"nodeId" in e ? e.nodeId : ""}`)
})
console.log("ANSWER:", out.answer)
console.log("EVIDENCE:", JSON.stringify(out.evidence))
console.log("NODE EVENTS:", nodes.length)
console.log("HAS_FACT:", /registerAuthRoute/.test(out.answer + JSON.stringify(out.evidence)) ? "YES ✓" : "NO ✗")
