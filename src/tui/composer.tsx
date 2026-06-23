// COMPOSER — the pinned prompt card, extracted from chat.tsx so the composer look + its focus
// model live in one file (opencode component/prompt/index.tsx:1403-1762, ported Solid→React;
// termcast row/footer geometry). chat.tsx stays under budget. Three stacked pieces, all
// flexShrink:0 so they ALWAYS reserve their lines under the scrollbox (the no-overlap contract):
//   1. bordered textarea card  — left-border, theme-tinted (accent idle / busy / armed-error),
//      paddingLeft:1 (opencode prompt textarea :1424-1501 left-border + tint).
//   2. metadata row            — the model name (opencode model meta :1502-1539, LSP/MCP DROPPED).
//   3. status row              — left: spinner + live hint (busy/armed/note/idle);
//                                right: "<tokens> tok · <cost> · Cmd+K commands" (opencode
//                                status line :1568-1737 left-spinner / right-cluster, space-between).
//
// FOCUS MODEL (captureFocus) — REPLACES the old BLURRED-reclaim hack in chat.tsx. The composer
// textarea is the DEFAULT focus owner and RECLAIMS focus the instant anything steals it (a row
// click, a Tab toggle, an orch re-render) — UNLESS a capture owner (a dialog / command palette)
// holds it (captureFocus=true), in which case the composer YIELDS and does NOT steal focus back.
// This is the termcast InFocus model (dialog.tsx:96-144 childrenInFocus = !dialogStack.length):
// one boolean gates whether the default owner reclaims. `useComposerFocus` owns the BLURRED
// subscription; `shouldReclaim` is the pure gate (unit-testable, the palette-doesn't-steal proof).
import { RenderableEvents } from "@opentui/core"
import { useEffect } from "react"
import { type ResolvedTheme } from "./theme.ts"
import { actionBarRight } from "./shell.tsx"

// The model id → a clean leaf label for the metadata row: "@cf/moonshotai/kimi-k2.7-code"
// → "kimi-k2.7-code" (opencode shows model.parsed().model, the bare model name). Pure.
export const modelLabel = (model: string): string => {
  const leaf = model.split("/").pop() ?? model
  return leaf.length > 0 ? leaf : model
}

// FOCUS GATE (pure, unit-testable) — the composer reclaims focus on blur ONLY when it is the
// rightful owner: the chat view is up AND no capture owner (dialog/palette) holds focus. When
// `captureFocus` is true the palette owns focus, so the composer YIELDS (returns false) and the
// keystrokes flow to the palette — it does NOT steal focus back. This is the SPEC contract.
export const shouldReclaim = (inChat: boolean, captureFocus: boolean): boolean => inChat && !captureFocus

// useComposerFocus — the captureFocus focus model. Subscribes to the textarea's BLURRED event
// and re-claims focus on the next tick, but ONLY when `shouldReclaim` holds. When a palette/dialog
// captures focus (captureFocus=true) the reclaim is gated off, so the composer stops stealing and
// the capture owner keeps the keystrokes. Re-runs when inChat / captureFocus flip so opening a
// palette immediately yields and closing it immediately re-claims. focus() early-returns when we
// already hold focus, so the initial focus + every re-render is a cheap no-op; only a real steal
// (while we're the rightful owner) triggers the deferred re-claim.
export const useComposerFocus = (
  taRef: React.MutableRefObject<any>,
  inChat: boolean,
  captureFocus: boolean,
): void => {
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    // When we're the rightful owner, take focus now; when a palette owns it, leave focus alone.
    if (shouldReclaim(inChat, captureFocus)) ta.focus?.()
    const reclaim = () => {
      // The steal (focusRenderable) is mid-flight when BLURRED fires; defer a tick so it settles,
      // then re-claim — but only if we're still the rightful owner (no palette captured focus).
      queueMicrotask(() => {
        if (shouldReclaim(inChat, captureFocus)) taRef.current?.focus?.()
      })
    }
    ta.on?.(RenderableEvents.BLURRED, reclaim)
    return () => ta.off?.(RenderableEvents.BLURRED, reclaim)
  }, [taRef, inChat, captureFocus])
}

// Composer status row text + tone (busy/armed/note/idle), pure so the frame gate reads it
// identically. Mirrors chat.tsx's statusBar but lives with the composer it drives.
export type ComposerStatus = { readonly text: string; readonly tone: string; readonly live: boolean }

export function Composer({
  taRef,
  theme,
  busy,
  armed,
  model,
  status,
  tokens,
  fmtTokens,
  spinnerFrame,
  placeholder,
  keyBindings,
  onContentChange,
  onSubmit,
  onPaste,
}: {
  taRef: React.MutableRefObject<any>
  theme: ResolvedTheme
  busy: boolean
  armed: boolean
  model: string
  status: ComposerStatus
  tokens: number
  fmtTokens: (n: number) => string
  spinnerFrame: string
  placeholder: string
  keyBindings: unknown
  onContentChange: () => void
  onSubmit: () => void
  onPaste: (event: unknown) => void
}) {
  // Border tone: armed (about to interrupt) → error, busy → busy/warning, else the accent.
  const border = armed ? theme.error : busy ? theme.busy : theme.accent
  const right = actionBarRight(tokens, fmtTokens)
  return (
    <box style={{ paddingLeft: 1, paddingRight: 1, paddingTop: 1, width: "100%", flexShrink: 0 }}>
      {/* 1. bordered textarea card — left-border, theme-tinted */}
      <box border={["left"]} borderColor={border} style={{ paddingLeft: 1, flexShrink: 0, width: "100%" }}>
        <textarea
          ref={taRef}
          width="100%"
          minHeight={1}
          maxHeight={8}
          keyBindings={keyBindings as any}
          onContentChange={onContentChange}
          onSubmit={onSubmit as any}
          onPaste={onPaste as any}
          focused
          cursorColor={theme.accent}
          focusedTextColor={theme.text}
          placeholder={placeholder}
          placeholderColor={theme.muted}
        />
      </box>
      {/* 2. metadata row — model name (LSP/MCP dropped: ax2 has neither) */}
      <box flexDirection="row" gap={1} style={{ paddingLeft: 2, flexShrink: 0 }}>
        <text fg={theme.textMuted}>{modelLabel(model)}</text>
      </box>
      {/* 3. status row — RIGHT-ALIGNED, left stays CLEAN. The live status (spinner + thinking/esc)
          shows ONLY mid-turn (status.live), prepended to the persistent token·Cmd+K cluster — so
          "thinking…" lives on the RIGHT, never in the input area (it used to double as the textarea
          placeholder AND here). justifyContent:flex-end keeps the whole row hard-right. */}
      <box flexDirection="row" justifyContent="flex-end" gap={1} style={{ paddingLeft: 2, paddingRight: 1, flexShrink: 0 }}>
        {status.live ? <text fg={status.tone} flexShrink={1}>{busy ? `${spinnerFrame} ` : ""}{status.text}</text> : null}
        <text fg={theme.textMuted} flexShrink={0}>{right}</text>
      </box>
    </box>
  )
}
