import * as Registry from "effect/unstable/reactivity/AtomRegistry"
import { appAtom, newSessionAtom, sendAtom } from "./src/atoms.ts"
const reg = Registry.make()
reg.mount(appAtom); reg.mount(newSessionAtom); reg.mount(sendAtom)
reg.set(newSessionAtom, undefined)
await new Promise((r) => setTimeout(r, 400))
reg.set(sendAtom, "Hi, my name is Orin. Reply in 3 words.")
await new Promise((r) => setTimeout(r, 9000))
reg.set(sendAtom, "What is my name? One word.")
await new Promise((r) => setTimeout(r, 9000))
const s = reg.get(appAtom); const a = s.sessions.find(x=>x.id===s.activeId)
console.log("MSGS:", a?.messages.map(m=>m.who+":"+m.text).join(" | "))
await new Promise((r) => setTimeout(r, 2500))
