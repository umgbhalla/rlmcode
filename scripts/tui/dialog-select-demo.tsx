#!/usr/bin/env bun
// FRAME-GATE FIXTURE (not shipped, not in chat.tsx): mounts the generic DialogSelect<T> +
// its useDialogSelect controller (src/tui/dialog-select.tsx) through the REAL opentui
// createRoot/render path with the REAL key handler (useKeyboard) wired to the controller —
// exactly how chat.tsx will drive it. So the frame gate can prove the dialog OPENS, FILTERS as
// you type, MOVES the selection with ↑↓, shows its FOOTER, and SELECTS on Enter — without
// launching the whole app (standalone entry, like ui-atoms-demo). The driver launches this
// entry instead of chat.tsx for dialog-select.test.
//
// The list is CATEGORISED (two groups) + long enough (12 items) to exercise grouping + the
// scroll window. A selection writes a "selected: <title>" line below the dialog so Enter is
// observable in the captured cell grid.
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import React, { useState } from "react"
import { DialogSelect, useDialogSelect, type Option } from "../../src/tui/dialog-select.tsx"
import { theme } from "../../src/tui/theme.ts"

// 12 fruit across 2 categories — enough to show grouping + scroll, with distinct prefixes so a
// substring filter ("ber") narrows to a known subset the test can assert.
const ITEMS: Array<Option<string>> = [
  { title: "apple", value: "apple", category: "Common", hint: "a" },
  { title: "banana", value: "banana", category: "Common", hint: "b" },
  { title: "cherry", value: "cherry", category: "Common" },
  { title: "date", value: "date", category: "Common" },
  { title: "elderberry", value: "elderberry", category: "Common" },
  { title: "fig", value: "fig", category: "Common" },
  { title: "blackberry", value: "blackberry", category: "Berries" },
  { title: "blueberry", value: "blueberry", category: "Berries" },
  { title: "raspberry", value: "raspberry", category: "Berries" },
  { title: "strawberry", value: "strawberry", category: "Berries", description: "the red one" },
  { title: "gooseberry", value: "gooseberry", category: "Berries" },
  { title: "mulberry", value: "mulberry", category: "Berries" },
]

const Demo = (): React.ReactNode => {
  const [picked, setPicked] = useState<string | null>(null)
  const model = useDialogSelect(ITEMS, (v) => setPicked(v))

  // REAL key routing — the same surface chat.tsx wires to the controller: ↑↓ move, Enter
  // submit, Backspace edits the filter, a printable char appends. (No open/close here; the
  // dialog is always mounted in the fixture so the gate can drive it directly.)
  useKeyboard((k: any) => {
    if (k.name === "up") return model.move(-1)
    if (k.name === "down") return model.move(1)
    if (k.name === "home") return model.home()
    if (k.name === "end") return model.end()
    if (k.name === "return") return model.submit()
    if (k.name === "backspace") return model.backspaceQuery()
    const ch =
      typeof k.sequence === "string" && k.sequence.length === 1 && k.sequence >= " " && !k.ctrl && !k.meta
        ? k.sequence
        : ""
    if (ch !== "") return model.appendQuery(ch)
  })

  return (
    <box flexDirection="column" style={{ height: "100%" }}>
      {/* a selection sink so Enter is observable in the captured grid */}
      <text fg={theme.text}>{picked ? `selected: ${picked}` : "selected: (none)"}</text>
      <DialogSelect title="Pick a fruit" model={model} placeholder="search fruit…" theme={theme} maxRows={8} />
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<Demo />)
