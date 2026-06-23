#!/usr/bin/env bun
// FRAME-GATE FIXTURE (not shipped, not in chat.tsx): mounts the NEW autocomplete popup
// (src/tui/autocomplete.tsx) wired to a REAL opentui <textarea> through the REAL createRoot/render
// path, so the frame gate can assert the popup BEHAVIOR end-to-end — type "@", the popup opens
// with files, typing narrows the list, ↵ inserts the picked path into the textarea — without
// launching the full chat.tsx (the composer wiring is the SEPARATE wire-autocomplete step). This
// fixture IS that wiring in miniature: the composer's trigger DETECTION (detectTrigger on every
// keystroke via onContentChange) + the focus YIELD (route ↑↓/↵/esc to the controller while the
// popup is open) + apply the spliced text back to the textarea.
//
// DETERMINISM: the @ file source is a CANNED set (no live repo walk) so the asserted rows are
// fixed; the / command source is a canned list. Zero network, zero fs. The driver launches this
// entry instead of chat.tsx for autocomplete.test.
import { createCliRenderer, RenderableEvents } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import React, { useEffect, useRef, useState } from "react"
import { Autocomplete, useAutocomplete, type AcItem } from "../../src/tui/autocomplete.tsx"
import { theme } from "../../src/tui/theme.ts"

// Canned @ file set — fixed rows so the test asserts stable content (NOT the live repo tree).
const FILES = [
  "src/tui/atoms.ts",
  "src/tui/chat.tsx",
  "src/tui/composer.tsx",
  "src/core/agent.ts",
  "README.md",
]
// Canned / command list — the shape the composer would pass from the palette registry.
const COMMANDS: Array<AcItem> = [
  { value: "new", display: "/new", hint: "n", kind: "command" },
  { value: "quit", display: "/quit", hint: "ctrl+c", kind: "command" },
]

const Demo = (): React.ReactNode => {
  const taRef = useRef<any>(null)
  const [text, setText] = useState("")

  const ac = useAutocomplete({
    commands: COMMANDS,
    loadFiles: () => Promise.resolve(FILES), // canned (deterministic) — no fs walk in the test
    onInsert: ({ text: next, cursor }) => {
      // apply the spliced text back to the REAL textarea + restore the cursor (composer does this)
      taRef.current?.setText?.(next)
      try {
        taRef.current.cursorOffset = cursor
      } catch {
        /* setter may not be present in every build */
      }
      setText(next)
    },
  })

  // Trigger DETECTION — the composer feeds the controller every keystroke (text + cursor).
  const syncFromInput = () => {
    const ta = taRef.current
    const t: string = ta?.plainText ?? ""
    const c: number = typeof ta?.cursorOffset === "number" ? ta.cursorOffset : t.length
    setText(t)
    ac.sync(t, c)
  }

  // Focus YIELD (mode-stack) — while the popup is open the composer routes ↑↓/↵/esc to the
  // controller instead of the textarea; otherwise the textarea owns keys. We grab these globally
  // (the fixture has no other focus owner) and consult the controller first.
  useKeyboard((k: any) => {
    if (ac.mode !== false) {
      const name = k.name as "up" | "down" | "return" | "escape" | "tab"
      if (name === "up" || name === "down" || name === "return" || name === "escape" || name === "tab") {
        if (ac.onKey(name)) return
      }
    }
  })

  // Keep the textarea focused so typed chars land (the composer's captureFocus owns this normally).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.focus?.()
    const refocus = () => queueMicrotask(() => taRef.current?.focus?.())
    ta.on?.(RenderableEvents.BLURRED, refocus)
    return () => ta.off?.(RenderableEvents.BLURRED, refocus)
  }, [])

  return (
    <box flexDirection="column" style={{ height: "100%" }}>
      <box style={{ flexGrow: 1 }}>
        <text fg={theme.muted}>autocomplete fixture</text>
      </box>
      {/* the popup floats above the composer card (bottom-anchored) */}
      <Autocomplete
        mode={ac.mode}
        items={ac.items}
        selected={ac.selected}
        query={text}
        theme={theme}
        left={1}
        bottom={4}
        width={56}
      />
      <box border={["left"]} borderColor={theme.accent} style={{ paddingLeft: 1, flexShrink: 0, width: "100%" }}>
        <textarea
          ref={taRef}
          width="100%"
          minHeight={1}
          maxHeight={6}
          focused
          onContentChange={syncFromInput}
          cursorColor={theme.accent}
          placeholder="type @ or /"
          placeholderColor={theme.muted}
        />
      </box>
      {/* echo the committed text so the test can assert the inserted token landed in the input */}
      <box style={{ flexShrink: 0, paddingLeft: 2 }}>
        <text fg={theme.textMuted}>{`input: ${text}`}</text>
      </box>
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<Demo />)
