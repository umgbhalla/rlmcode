// FRAME GATE — the ⌘K command palette actually WORKS (opens, filters, runs, closes), driven
// through the REAL chat.tsx under the terminal-control PTY (RLM_MOCK=1, zero network). The
// composer advertises "Cmd+K commands"; this proves the key does something, not just shows.
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

await report("palette", async (a) => {
  const d = await launchDriver({ cols: 80, rows: 26 })
  try {
    await d.waitForFrame((f) => /press n|no sessions|SESSIONS/i.test(f), 8000)
    await d.type("n") // new session → chat view
    await d.waitForFrame((f) => /message kimi/i.test(f), 8000)

    // OPEN — Ctrl+K raises the centered command dialog. Wait for the FOOTER (the last-painted
    // line) so we assert a FULLY-rendered dialog, not a half-drawn transitional frame.
    await d.ctrl("k")
    const open = await d.waitForFrame((f) => /esc close/.test(f), 6000)
    a.has(open, /Commands/, "Ctrl+K opens the palette")
    a.has(open, /New session/, "palette lists real commands")
    a.has(open, /↵ run · ↑↓ select · esc close/, "palette shows the run/nav/close footer")

    // FILTER — typing narrows to matching commands; non-matching ones drop out.
    await d.type("scroll")
    const filt = await d.waitForFrame((f) => /Scroll to bottom/.test(f) && !/New session/.test(f), 5000)
    a.has(filt, /Scroll to bottom/, "typing filters to matching commands")
    a.hasNot(filt, /New session/, "non-matching commands are filtered out")

    // RUN — Enter executes the highlighted command AND closes the palette (here: a scroll, safe).
    await d.key("Enter")
    const ran = await d.waitForFrame((f) => !/Commands/.test(f), 5000)
    a.hasNot(ran, /Commands/, "Enter runs the command and closes the palette")
    a.has(ran, /message kimi/, "focus returns to the composer after the palette closes")
  } finally {
    await d.stop()
  }
})
