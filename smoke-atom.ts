import * as Registry from "effect/unstable/reactivity/AtomRegistry"
import { messagesAtom, busyAtom, sendAtom } from "./src/atoms.ts"

const reg = Registry.make()
reg.mount(sendAtom)      // builds runtime + tracing layer
reg.mount(messagesAtom)
reg.subscribe(messagesAtom, (m) => console.log("messages ->", m.map(x => `${x.who}:${x.text}`)))
reg.subscribe(busyAtom, (b) => console.log("busy ->", b))

console.log("setting send('Hello, name is Bob. 3 words.')")
reg.set(sendAtom, "Hello, my name is Bob. Reply in 3 words.")

await new Promise((r) => setTimeout(r, 12000))
console.log("FINAL:", reg.get(messagesAtom).map(x => `${x.who}:${x.text}`))
