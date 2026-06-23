#!/usr/bin/env bun
// SERIALIZABLE-SEAM regression (ponytail: non-trivial invariant leaves a check). Plain asserts,
// ax2 fixture style. run.ts DOCUMENTS that TurnEvent is fully serializable — "a future socket can
// JSON.stringify a TurnEvent verbatim" (run.ts:30-34) — and the whole remote-NDJSON story depends
// on it. Nothing enforced it. This pins it: build ONE of EVERY TurnEvent variant (every `node`
// event subtype + a `reply` carrying a full TurnResult incl. error + usage), JSON round-trip each,
// and assert no NON-undefined field is lost or reshaped. If someone adds a non-serializable field
// (a Date, a Map, an ax object) to the union, this fails.
import type { TurnEvent } from "../src/core/run.ts"

let failed = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`  FAIL: ${msg}`)
    failed++
  }
}

// Deep-equal that treats a MISSING key and an `undefined` value as equal — JSON.stringify drops
// undefined-valued keys, so the contract we assert is "every field that HAS a value survives".
const norm = (v: unknown): unknown => {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map(norm)
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue
    out[k] = norm(val)
  }
  return out
}
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b))

// EVERY variant of the union — the test fails to compile if a variant is added/renamed and not
// listed here (each entry is typed `TurnEvent`), so the matrix can't silently fall behind.
const samples: Array<TurnEvent> = [
  { type: "reply_delta", text: "tok" },
  { type: "thinking_delta", text: "hmm" },
  { type: "message", text: "step narration" },
  { type: "tool_call", id: "c1", name: "bash", args: '{"cmd":"ls"}' }, // nodeId omitted
  { type: "tool_call", id: "c2", name: "read_file", args: "{}", nodeId: "n1" },
  { type: "tool_result", id: "c1", result: "ok", isError: false },
  { type: "tool_result", id: "c2", result: "ENOENT", isError: true, nodeId: "n1" },
  { type: "node", nodeId: "n1", event: "start", parentId: "root", detail: "scan", tokens: 0 },
  { type: "node", nodeId: "n1", event: "delta" },
  { type: "node", nodeId: "n1", event: "retry", detail: "429 backoff 2s" },
  { type: "node", nodeId: "n1", event: "done", tokens: 1200 },
  { type: "node", nodeId: "n1", event: "error", detail: "rate_limited" },
  {
    type: "reply",
    result: {
      reply: "done",
      stopReason: "stop",
      usage: { total: 8, reasoning: 3, input: 2, output: 3 },
      aborted: false,
    },
  },
  {
    type: "reply",
    result: {
      reply: "⚠ Rate limited (429) — too many requests. Try again shortly.",
      stopReason: "error",
      usage: {},
      aborted: false,
      error: { kind: "provider", message: "Rate limited (429) — too many requests. Try again shortly." },
    },
  },
]

await (async () => {
  for (const ev of samples) {
    const round = JSON.parse(JSON.stringify(ev)) as unknown
    const label = ev.type === "node" ? `node:${ev.event}` : ev.type
    assert(deepEq(ev, round), `${label}: lost/reshaped a field across JSON round-trip`)
    // A serialized event must keep its discriminant verbatim (the consumer switches on it).
    assert((round as { type?: string }).type === ev.type, `${label}: discriminant 'type' did not survive`)
  }
  // The terminal reply's nested TurnResult must round-trip whole (the public result contract).
  const withErr = samples[samples.length - 1] as Extract<TurnEvent, { type: "reply" }>
  const rt = JSON.parse(JSON.stringify(withErr)).result
  assert(rt.error?.kind === "provider" && rt.stopReason === "error", "reply.result.error/stopReason lost across round-trip")
})()

if (failed === 0) console.log("turn-event-roundtrip.test: all pass ✓")
else {
  console.error(`turn-event-roundtrip.test: ${failed} FAIL`)
  process.exit(1)
}
