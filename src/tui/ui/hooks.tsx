// LIFTED verbatim from termcast/src/hooks.tsx — a stable callback that always invokes the
// LATEST handler. Lets an event handler be passed into an effect with an empty dep array (or
// to a memoized child) without re-running the effect or going stale on props/state.
import { useCallback, useLayoutEffect, useRef } from "react"

export const useEvent = <T extends (...args: never[]) => unknown>(handler: T): T => {
  const handlerRef = useRef<T>(handler)

  useLayoutEffect(() => {
    handlerRef.current = handler
  })

  return useCallback((...args: Parameters<T>) => {
    const fn = handlerRef.current
    return fn(...args)
  }, []) as T
}
