// ponytail: lifted-ahead-of-use atom, only the demo references it. Upgrade: wire into chat.tsx or delete (atom + ui-atoms-demo.tsx + ui-atoms.test.ts).
// LIFTED near-verbatim from termcast/src/components/spinner.tsx — a pulsing-dot loading glyph
// (' ' · •) driven by the shared animation tick. Theme-aware: defaults to theme.muted, the
// idle-hint role in rlmcode's palette; pass `color` to override (e.g. theme.busy for in-flight).
import React from "react"
import { theme } from "../theme.ts"
import { useAnimationTick, TICK_DIVISORS } from "./animation-tick.tsx"

interface SpinnerProps {
  color?: string
}

const FRAMES = [" ", "·", "•"] as const

export const Spinner = ({ color }: SpinnerProps): React.ReactNode => {
  const tick = useAnimationTick(TICK_DIVISORS.SPINNER)
  const frame = FRAMES[tick % FRAMES.length]
  return (
    <text flexShrink={0} fg={color ?? theme.muted}>
      {frame}
    </text>
  )
}
