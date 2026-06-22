process.env.AX2_MOCK = "1"
import { AxMemory } from "@ax-llm/ax"
import * as Tracer from "effect/Tracer"
import { sessionsRT } from "../../src/core/sessions.ts"
import { runTurn } from "../../src/core/run.ts"

const parent = Tracer.externalSpan({ traceId: "0".repeat(32), spanId: "0".repeat(16), sampled: true })
sessionsRT.set("s1", { mem: new AxMemory(), parent })

const nodes: string[] = []
for await (const ev of runTurn("s1", "orchestrate the scan")) {
  if ((ev as any).type === "node") nodes.push(JSON.stringify(ev))
  if ((ev as any).type === "reply") console.log("REPLY:", JSON.stringify((ev as any).result?.reply))
}
console.log("NODE EVENTS:", nodes.length)
nodes.slice(0,4).forEach(n=>console.log("  ", n))
process.exit(0)
