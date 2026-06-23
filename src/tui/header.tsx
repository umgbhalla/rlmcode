// CHAT-VIEW CHROME — the sticky header + the "N new" pill (HEADER-ANCHORS), plus the session
// LIST view, extracted from chat.tsx so the App component + the chat-view layout chrome live in
// one file and chat.tsx stays under its line budget. opencode anchors a sticky session header at
// the top of the transcript (component/session header :1209-1280) and a "scroll to bottom / N
// new" affordance bottom-right when the view is scrolled up (the jump-to-latest pill).
//
// REF-DRIVEN, NOT scroll-STATE (the claude_code anchor model): the header reads `active.id`
// (already a render input — it only changes on session switch), and the pill reads the scrollbox
// position IMPERATIVELY off a ref. Neither subscribes to scroll events, so a plain scroll does
// NOT trigger a React re-render. The pill re-evaluates on the renders that DO happen (a new turn
// arrives → `turnCount` changes → re-render; or the busy tick) — which is exactly when "N new"
// matters (a turn landed while you were scrolled up). Pure presentation; no logic/shape change.
import { useRef } from "react"
import { theme } from "./theme.ts"
import type { SessionView } from "./atoms.ts"

// SESSION HEADER — the anchored banner at the TOP of the chat view (flexShrink:0 so it never
// scrolls away and always reserves its line above the scrollbox). It reads "rlmcode · session
// <id>" — the product name bright, the "· session <id>" tail dim so the id reads as metadata. The
// `id` is the SessionView.id, the SAME value tagged on the motel `chat.session` span as session.id
// (atoms.ts newSessionAtom), so the header doubles as the trace-correlation handle the user asked
// for (read the id off the screen, grep it in motel). Re-renders only when `id` changes (it's the
// active session id — a render input that's stable between session switches).
export function SessionHeader({ id }: { id: string | null }) {
  return (
    <box flexDirection="row" flexShrink={0} style={{ paddingLeft: 1, paddingRight: 1 }}>
      <text fg={theme.text}>rlmcode</text>
      {id ? <text fg={theme.muted}>{` · session ${id}`}</text> : null}
    </box>
  )
}

// The scrollbox ref shape the pill reads — the opentui ScrollBoxRenderable getters we touch
// (scrollTop / scrollHeight + the viewport box's height). Narrowed to just these so the pill
// stays decoupled from the full renderable type. `any`-free read of a beta renderable surface.
type ScrollLike = { scrollTop: number; scrollHeight: number; viewport: { height: number } }

// isScrolledUp(sb): is the transcript scrolled UP from its bottom (so newer rows are below the
// fold)? Read imperatively from the scrollbox ref — NOT from scroll state — so calling it does not
// itself cause a re-render. A 1-cell tolerance absorbs the off-by-one at the sticky-bottom edge.
// Returns false when the ref isn't mounted yet or the content fits (nothing to scroll).
export const isScrolledUp = (sb: ScrollLike | null): boolean => {
  if (!sb) return false
  const maxTop = Math.max(0, sb.scrollHeight - sb.viewport.height)
  return maxTop > 0 && sb.scrollTop < maxTop - 1
}

// NEW PILL — the bottom-right "N new ↓" affordance shown when the transcript is scrolled UP and
// turns have arrived since you last sat at the bottom. REF-DRIVEN: `seenRef` records the turn
// count last observed while pinned to the bottom; the pill reads the live scroll position from
// `scrollRef` imperatively. No scroll listener / no scroll state ⇒ a scroll alone never re-renders;
// the pill updates on the renders that happen anyway (a new turn ⇒ turnCount change; the busy
// tick). When at the bottom it resets the baseline and shows nothing. Absolute-positioned so it
// floats over the transcript's bottom-right without reflowing it (opencode jump-to-latest pill).
export function NewPill({ scrollRef, turnCount, bottom = 0 }: { scrollRef: { current: ScrollLike | null }; turnCount: number; bottom?: number }) {
  // Baseline = the turn count we'd seen the last time the view was at the bottom. Starts at the
  // current count so an already-pinned view shows no pill until something NEW lands above the fold.
  const seenRef = useRef(turnCount)
  const up = isScrolledUp(scrollRef.current)
  // At the bottom (or not scrolled) ⇒ everything is seen: advance the baseline, hide the pill.
  if (!up) {
    seenRef.current = turnCount
    return null
  }
  const unseen = Math.max(0, turnCount - seenRef.current)
  if (unseen <= 0) return null
  // `bottom` floats it just ABOVE the composer (the caller passes the composer height) so the pill
  // sits at the transcript's bottom-right, not buried under the input — opencode's jump-to-latest.
  return (
    <box position="absolute" right={2} bottom={bottom} flexShrink={0}>
      <text fg={theme.busy} bg={theme.backgroundPanel}>{` ${unseen} new ↓ `}</text>
    </box>
  )
}

// SESSION LIST — the list-view chrome (moved here from chat.tsx with the chat-view chrome). The
// session rows with a per-session liveness spinner + the arm-to-close hint. Pure presentation.
export function List({ sessions, cursor, busySessions, frame, armedDelete }: { sessions: readonly SessionView[]; cursor: number; busySessions: ReadonlySet<string>; frame: string; armedDelete: string | null }) {
  return (
    <box flexDirection="column" padding={1}>
      <text fg={theme.muted}>SESSIONS · n new · ↑↓ move · enter open · d close · q quit</text>
      {sessions.length === 0 ? (
        <text fg={theme.muted}>no sessions. press n to start.</text>
      ) : (
        sessions.map((s, i) => {
          const working = busySessions.has(s.id)
          const arming = armedDelete === s.id
          return (
            <text key={s.id} fg={i === cursor ? theme.busy : theme.text}>
              {i === cursor ? "▸ " : "  "}
              {/* per-session liveness: a live spinner if this session has a turn in flight */}
              <span fg={working ? theme.busy : theme.faint}>{working ? `${frame} ` : "  "}</span>
              {s.title}
              {"  "}
              <span fg={theme.muted}>{`${s.messages.length} msg`}</span>
              {arming ? <span fg={theme.error}>{"  press d again to close"}</span> : null}
            </text>
          )
        })
      )}
    </box>
  )
}
