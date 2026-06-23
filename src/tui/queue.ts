// MESSAGE QUEUE (opencode pending-prompt) — the busy-aware submit + auto-flush, extracted from
// chat.tsx so the App component stays under its complexity/size budget. A prompt submitted WHILE a
// turn is in flight must NOT start a second concurrent turn (or be dropped): it is HELD in a
// single pending slot and AUTO-SENT once the turn settles, rendered meanwhile as a dim "↑ queued"
// card (messages.tsx QueuedCard). State is UI-local here, so the Msg/session shapes stay UNCHANGED.
import { useEffect, useRef, useState } from "react"

// useMessageQueue(busy, activeId, send): owns the pending slot + the two effects that drive it.
//   - `queued`      — the held message (null ⇒ nothing pending; the render gates the QueuedCard on it).
//   - `sendOrQueue` — submit: busy ⇒ HOLD (replace any prior pending, one slot like opencode);
//                     idle ⇒ send immediately.
// The busy→idle effect flushes the slot (send + clear); a session switch (activeId change) drops a
// pending prompt (it belongs to the session it was typed in). Both transitions are edge-gated off a
// ref so a queue-while-idle path can't double-fire and a re-render can't re-send.
export const useMessageQueue = (
  busy: boolean,
  activeId: string | null,
  send: (msg: string) => void,
): { readonly queued: string | null; readonly sendOrQueue: (text: string) => void } => {
  const [queued, setQueued] = useState<string | null>(null)
  const sendOrQueue = (text: string): void => (busy ? setQueued(text) : send(text))

  // FLUSH on busy→idle: the held prompt auto-sends, turning the dim "↑ queued" card into a real
  // user turn. Edge-gated (prevBusy) + guarded on a non-null slot so it fires exactly once.
  const prevBusy = useRef(busy)
  useEffect(() => {
    if (prevBusy.current && !busy && queued !== null) {
      send(queued)
      setQueued(null)
    }
    prevBusy.current = busy
  }, [busy, queued, send])

  // A queued prompt belongs to the session it was typed in — drop it when the active session changes.
  useEffect(() => setQueued(null), [activeId])

  return { queued, sendOrQueue }
}
