// TUI SCREENSHOT/RECORDING CAPTURE — drives the REAL chat.tsx headlessly under terminal-control
// (RLM_MOCK=1, zero network) into a rich EXPANDED state (new session → a turn → the orchestration
// node-tree fully expanded with per-node tool clusters → streaming reply), and writes the captured
// cell-grid frame to assets/demo-frame.txt. Used for the README screenshot; the vhs .tape
// (assets/demo.tape) renders the animated gif from the same flow.
//
// Run: bun scripts/tui/screenshot.ts            (writes assets/demo-frame.txt + prints it)
// Wide capture so the full tree + composer + footer fit: 120x40.
import { writeFileSync, mkdirSync } from "node:fs"
import { launchDriver } from "./driver.ts"

const COLS = Number(process.env.SHOT_COLS ?? 120)
const ROWS = Number(process.env.SHOT_ROWS ?? 40)
const OUT = process.env.SHOT_OUT ?? "assets/demo-frame.txt"

const main = async (): Promise<void> => {
  // No velocity cap → the full node tree shows (the showpiece). Stream on for the thinking block.
  const d = await launchDriver({ cols: COLS, rows: ROWS, env: { RLM_MOCK_STREAM: "1", RLM_ORCH_MAX_SHOWN: "999" } })
  try {
    await d.waitForFrame((f) => /press n|SESSIONS|no sessions/i.test(f), 8000)
    await d.key("n") // new session
    await d.waitForFrame((f) => /message|kimi/i.test(f), 8000)
    // A turn that triggers the mock orchestration tree (the rich UX).
    await d.type("orchestrate the auth refactor")
    await d.key("Enter")
    // Wait for the full tree to settle (fan-out + Σ footer = the tree is drawn).
    await d.waitForFrame((f) => /fan-?out/i.test(f) && /Σ|tok/i.test(f), 15000)
    // Expand: Tab into the tree, open a node (best-effort — flow may shift post-migration).
    await d.key("Tab").catch(() => {})
    await d.key("Enter").catch(() => {})
    // Settle, then capture the richest frame.
    await new Promise((r) => setTimeout(r, 400))
    const frame = await d.frame()
    mkdirSync("assets", { recursive: true })
    writeFileSync(OUT, frame)
    console.log(frame)
    console.log(`\n[screenshot] wrote ${OUT} (${COLS}x${ROWS})`)
  } finally {
    await d.stop()
  }
}

main().catch((e) => {
  console.error("[screenshot] failed:", e?.message ?? e)
  process.exit(1)
})
