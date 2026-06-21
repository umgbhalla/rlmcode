import * as Registry from "effect/unstable/reactivity/AtomRegistry"
import { appAtom, newSessionAtom, sendAtom } from "./src/atoms.ts"

const reg = Registry.make()
reg.mount(appAtom)
reg.mount(newSessionAtom)
reg.mount(sendAtom)

const prompt = `Run a quick smoke test of your tools in this exact order. Use each tool once and report the first line of its result:
1. bash: echo "bash-ok"
2. glob: pattern "src/*.ts"
3. grep: pattern "export const" path src output_mode content head_limit 3
4. read_file: path src/tools.ts limit 5
5. write_file: path /tmp/ax2-smoke-write.txt content "write-ok"
6. edit_file: path /tmp/ax2-smoke-write.txt old_string "write-ok" new_string "edit-ok"
7. web_fetch: url https://example.com
After all 7, reply with a single markdown list: tool name and first 30 chars of result.`

reg.set(newSessionAtom, undefined)
await new Promise((r) => setTimeout(r, 400))
reg.set(sendAtom, prompt)
await new Promise((r) => setTimeout(r, 25000))

const s = reg.get(appAtom)
const a = s.sessions.find((x) => x.id === s.activeId)
console.log("--- MESSAGES ---")
for (const m of a?.messages ?? []) {
  if (m.kind === "you") console.log("YOU:", m.text.slice(0, 120))
  else if (m.kind === "agent") console.log("AGENT:", m.text.slice(0, 300))
  else console.log(`TOOL ${m.name} [${m.status}]:`, m.result.slice(0, 120))
}
