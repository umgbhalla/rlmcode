import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Tracer from "effect/Tracer"
import { AxMemory } from "@ax-llm/ax"
import { turn } from "/Users/umang/hub/ax2/src/agent.ts"
import { TracingLive } from "/Users/umang/hub/ax2/src/otel.ts"

const prog = Effect.gen(function* () {
  const parent = yield* Effect.useSpan(
    "chat.session", { kind: "server", attributes: { "session.id": "repro" } },
    (span) => Effect.succeed(Tracer.externalSpan({ traceId: span.traceId, spanId: span.spanId, sampled: true })),
  )
  const mem = new AxMemory()
  const reply = yield* turn(mem, parent, "repro")(
    "List all .ts files in /Users/umang/hub/ax2/src, then read each fully, then summarize each. Use tools step by step."
  ).pipe(
    Effect.catchCause((c) => Effect.succeed("CAUGHT-AT-SENDATOM: " + String(c)))
  )
  console.log("\n===FINAL REPLY===")
  console.log(reply.slice(0, 600))
})

await Effect.runPromise(prog.pipe(Effect.provide(TracingLive)) as any).catch(e => console.log("RUN ERR", e))
