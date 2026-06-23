// PANEL + SEPARATOR — the reusable bordered-surface primitives, replacing the ad-hoc
// `<box border…>` chrome that messages.tsx (the message cards) and the centered overlays
// (which-key / dialog-select) each hand-rolled. opencode's design-system has a single
// Panel/border primitive every surface composes (ui/border.ts + the dialog/card chrome);
// rlmcode repeated the same box+border+padding spread in four files. This is that ONE
// primitive, so the card look lives in one place and every surface reads identically.
//
// Two variants cover every current usage:
//   - "accent" — a LEFT-BORDER accent card (border=["left"], paddingLeft): the per-turn
//     transcript cards (UserCard / QueuedCard / ErrorCard). The whole body sits inside the
//     card; the colored left edge + indent reads as "this is a <user/queued/error> block".
//   - "card"   — a fully-bordered, rounded, panel-bg card: the centered overlays (which-key,
//     dialog-select). Floats over the transcript with its own background + rounded frame.
//
// Pure presentation: no state, no key logic, no theme resolution (the caller passes the
// resolved border color + bg from its theme tokens — no inline hex here, theme.test's rule).
// `borderColor` is REQUIRED so a card never falls back to opentui's default border tint; the
// look is always theme-driven. opentui's <box> accepts border:boolean|BorderSides[] +
// borderStyle + borderColor + backgroundColor (../opentui/packages/core Box.ts:19-20), which
// these wrap 1:1.
import type { ReactNode } from "react"

// A border side set for the "accent" variant — opentui's BorderSides[]. Only "left" is used
// today (the accent card), but the prop is open so a future card can border other sides.
type Side = "top" | "right" | "bottom" | "left"

// opentui's flex Dimension (a column count, "auto", or a "N%" string). The width/maxWidth props
// take exactly this — typed here (vs `string`) so a stray non-dimension string can't slip in.
type Dimension = number | "auto" | `${number}%`

export type PanelProps = {
  /** "accent" = left-border card (transcript blocks); "card" = full rounded overlay card. */
  readonly variant: "accent" | "card"
  /** The border (+ for "card", the rounded frame) color — a resolved theme token, never hex. */
  readonly borderColor: string
  /** Background fill — only meaningful for the "card" overlay (a panel-bg float). */
  readonly backgroundColor?: string | undefined
  /** Which sides the "accent" variant borders (default ["left"] — the only current use). */
  readonly sides?: ReadonlyArray<Side> | undefined
  /** Left padding inside the card (default 2 — the transcript INDENT). */
  readonly paddingLeft?: number | undefined
  /** Top margin above the card (the per-card spacing the cards set individually). */
  readonly marginTop?: number | undefined
  /** Fixed width (the "card" overlays size themselves; the accent cards fill width). */
  readonly width?: Dimension | undefined
  /** Max width cap (the overlays clamp to 90% of the terminal). */
  readonly maxWidth?: Dimension | undefined
  readonly children: ReactNode
}

// PANEL — the bordered surface. "accent" → a left-border card (the transcript blocks);
// "card" → a rounded, panel-bg, fully-bordered float (the overlays). One <box> either way,
// so the border/padding spread the cards repeated now lives here.
export function Panel(props: PanelProps): ReactNode {
  const { variant, borderColor, backgroundColor, sides, paddingLeft, marginTop, width, children } = props
  if (variant === "accent") {
    // Left-border (default) accent card: the whole body sits inside, indented past the edge.
    return (
      <box
        flexDirection="column"
        border={(sides ?? ["left"]) as Array<Side>}
        borderColor={borderColor}
        style={{
          paddingLeft: paddingLeft ?? 2,
          width: width ?? "100%",
          ...(marginTop !== undefined ? { marginTop } : {}),
        }}
      >
        {children}
      </box>
    )
  }
  // "card": a fully-bordered, rounded, panel-bg float — the centered-overlay chrome.
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={borderColor}
      {...(backgroundColor !== undefined ? { backgroundColor } : {})}
      style={{
        width: width ?? "auto",
        maxWidth: props.maxWidth ?? "90%",
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: paddingLeft ?? 1,
        paddingRight: 1,
        ...(marginTop !== undefined ? { marginTop } : {}),
      }}
    >
      {children}
    </box>
  )
}

// SEPARATOR — a horizontal rule: one row of light box-drawing dashes in the border color, the
// thin divider opencode's design-system draws between dialog sections. A reusable line (vs a
// bordered box) so a header/footer can be visually split without a full box. `width` is the
// column count to fill; default 1 lets a flex parent stretch it. Pure.
export function Separator({ color, width }: { readonly color: string; readonly width?: number | undefined }): ReactNode {
  return (
    <text fg={color} selectable={false}>
      {"─".repeat(Math.max(1, width ?? 1))}
    </text>
  )
}
