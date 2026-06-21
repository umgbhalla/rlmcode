// Terminal-native clipboard copy. OSC52 works over SSH/tmux (terminal does the
// copy); pbcopy is the local-darwin fast path. Both best-effort, errors swallowed.
import { spawn } from "node:child_process"

const osc52 = (text: string) => {
  try {
    const b64 = Buffer.from(text, "utf8").toString("base64")
    process.stdout.write(`\x1b]52;c;${b64}\x07`)
  } catch {
    /* ignore */
  }
}

const pbcopy = (text: string) => {
  try {
    const p = spawn("pbcopy")
    p.on("error", () => {})
    p.stdin.on("error", () => {})
    p.stdin.end(text)
  } catch {
    /* ignore */
  }
}

/** Copy text to the clipboard. Returns false for empty input (nothing copied). */
export const copyToClipboard = (text: string): boolean => {
  if (!text || text.length === 0) return false
  osc52(text)
  if (process.platform === "darwin") pbcopy(text)
  return true
}
