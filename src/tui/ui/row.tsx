// ponytail: lifted-ahead-of-use atom, only the demo references it. Upgrade: wire into chat.tsx or delete (atom + ui-atoms-demo.tsx + ui-atoms.test.ts).
// LIFTED near-verbatim from termcast/src/components/row.tsx — a horizontal layout container
// that distributes width EVENLY across its children. Each child is wrapped in a flex-grow box
// (flexGrow:1 flexBasis:0 flexShrink:1) so they split the available columns equally — handy
// for side-by-side detail panels / equal-flex node columns. `gap` is the inter-child spacing.
import type { BoxProps } from "@opentui/react"
import React, { type ReactNode } from "react"

export interface RowProps extends BoxProps {
  /** Gap between children in columns (default: 1). */
  gap?: number
  children: ReactNode
}

export const Row = (props: RowProps): React.ReactNode => {
  const { gap = 1, children, ...rest } = props
  return (
    <box flexDirection="row" gap={gap} width="100%" {...rest}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child
        return (
          <box flexGrow={1} flexBasis={0} flexShrink={1}>
            {child}
          </box>
        )
      })}
    </box>
  )
}
