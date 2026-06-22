// Runnable headless SDK smoke: an EXTERNAL caller drives the ax2 core with NO Cloudflare env and
// NO Effect / OTel / @effect/atom wiring. Proves the public barrel (src/core/sdk.ts): createAgent
// over a caller-supplied AxAIService, then runTurn as a PLAIN AsyncGenerator (for-await-of). This
// file is the regression gate for the whole extraction — it imports ONLY the public surface.
//
//   bun examples/sdk-usage.ts        # exits 0 on success, 1 on any failed assertion
import { AxMockAIService } from "@ax-llm/ax"
// The ENTIRE surface a caller needs comes from the barrel — no reaching into internals.
import { type AxAIService, createAgent } from "../src/core/sdk.ts"

// ── plain ax2-style assertions ──────────────────────────────────────────────────
let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  } else {
    console.log(`ok: ${msg}`)
  }
}

// PROVE no-CF: snapshot CF env, then build everything without reading it.
const cfTokenBefore = process.env.CLOUDFLARE_API_TOKEN
const cfAccountBefore = process.env.CLOUDFLARE_ACCOUNT_ID

// ── caller-supplied stub AxAIService (NO network, deterministic) ────────────────
// ax's DSP parser maps the single output field `reply:string` straight off the raw content, so
// returning the text as content yields { reply: <text> }. No tools ⇒ one step, straight to reply.
const REPLY = "echo: hello from the stub"
const stubAi: AxAIService = new AxMockAIService({
  name: "stub",
  id: "stub-echo",
  features: { functions: true, streaming: false },
  chatResponse: async () => ({
    results: [{ index: 0, content: REPLY, finishReason: "stop" } as never],
    modelUsage: {
      ai: "stub",
      model: "stub/echo",
      tokens: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    } as never,
  }),
}) as unknown as AxAIService

// ── inject config: a non-CF model + base tools prove createAgent's DI ───────────
const agent = createAgent({ ai: stubAi, model: "stub/echo", maxSteps: 4, tokenBudget: 50_000, tools: "base" })

const main = async () => {
  // Drive ONE turn as a serializable event stream — the ONLY input is (sessionId, message), the
  // session is opened lazily. Collect every event type; the terminal {type:'reply'} carries the
  // normalized TurnResult. NO Effect, NO manual OTel — the SDK runs it on the app runtime inside.
  const types: string[] = []
  let reply: string | undefined
  let replyCount = 0
  let usageTotal: number | undefined
  let stopReason: string | undefined
  for await (const ev of agent.runTurn("sdk-smoke-1", "hello")) {
    types.push(ev.type)
    if (ev.type === "reply") {
      replyCount++
      reply = ev.result.reply
      usageTotal = ev.result.usage.total
      stopReason = ev.result.stopReason
    }
  }

  // ── assertions ────────────────────────────────────────────────────────────────
  assert(typeof reply === "string" && reply.length > 0, "a reply string came back")
  assert(reply === REPLY, `reply is the stub echo (got: ${JSON.stringify(reply)})`)
  // final-reply-once: exactly ONE terminal reply, and it is the LAST event.
  assert(replyCount === 1, `exactly one terminal reply (got ${replyCount})`)
  assert(types[types.length - 1] === "reply", `the reply is the LAST event (saw tail: ${types.slice(-3).join(",")})`)
  // hide #2: readUsage (kept internal) still flows the stub's tokens onto the normalized
  // TurnResult.usage; a clean reply maps to the 'stop' StopReason (no provider-wire leakage).
  assert(usageTotal === 8, `usage.total populated from the internal readUsage (got: ${usageTotal})`)
  assert(stopReason === "stop", `clean reply -> stopReason 'stop' (got: ${stopReason})`)
  // No CF env was touched, and the injected (non-CF) service was the one used.
  assert(
    process.env.CLOUDFLARE_API_TOKEN === cfTokenBefore && process.env.CLOUDFLARE_ACCOUNT_ID === cfAccountBefore,
    "no CF env was mutated (the stub ai needs none)",
  )
  assert(stubAi.getName() === "stub", "the injected (non-CF) AxAIService was the one used")
  // info() reads back the metadata surface.
  const info = agent.info()
  assert(info.model === "stub/echo" && info.maxSteps === 4 && info.tokenBudget === 50_000, "info() reflects the injected config")
  assert(info.toolNames.length > 0 && info.axVersion.length > 0, "info() exposes toolNames + axVersion")
  // closeSession drops the lazily-opened session.
  assert(agent.closeSession("sdk-smoke-1") === true, "closeSession released the opened session")
}

await main().catch((e) => {
  console.error("FAIL: runTurn threw", e)
  failed++
})

console.log(failed === 0 ? "\nSDK smoke: all pass ✓" : `\nSDK smoke: ${failed} FAILED`)
process.exit(failed ? 1 : 0)
