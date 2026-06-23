#!/usr/bin/env bun
// FRAME-GATE FIXTURE (not shipped, not in chat.tsx): mounts the lifted ui-atoms — <Row> with
// two equal-flex labeled cells plus a <Spinner> — through the REAL opentui createRoot/render
// path, so the frame gate can assert the Row STRUCTURE (both cell labels present, side by
// side) without depending on the spinner glyph phase (which cycles ' ' · •). Boots the same
// renderer chat.tsx uses; the driver launches this entry instead of chat.tsx for ui-atoms.test.
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import React from "react"
import { Row } from "../../src/tui/ui/row.tsx"
import { Spinner } from "../../src/tui/ui/spinner.tsx"
import { theme } from "../../src/tui/theme.ts"

const Demo = (): React.ReactNode => (
  <box flexDirection="column" padding={1}>
    <Row gap={2}>
      <text fg={theme.text}>cell-left</text>
      <text fg={theme.text}>cell-right</text>
    </Row>
    <box flexDirection="row" gap={1}>
      <Spinner color={theme.busy} />
      <text fg={theme.muted}>working</text>
    </box>
  </box>
)

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<Demo />)
