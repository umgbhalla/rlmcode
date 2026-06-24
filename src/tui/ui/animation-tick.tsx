// LIFTED near-verbatim from termcast/src/components/animation-tick.tsx — a shared global
// tick so every animated node (spinner, future loading bars) pulses in sync off ONE timer.
// Components subscribe to a global counter that increments every 20ms; each picks a divisor
// so its re-render cadence is a multiple of the base. Pass divisor 0 to disable (no sub).
import React from "react"

type TickListener = (tick: number) => void

const BASE_INTERVAL_MS = 20

// The shared-tick singleton is encapsulated in ONE factory closure: the mutable cursor
// (`globalTick`) and the timer handle (`intervalId`) live inside `createTicker`, not at
// module scope, so start/stop/subscribe thread that state through their shared parent
// rather than writing free module bindings (no hidden cross-closure module coupling).
const createTicker = (): { subscribe: (listener: TickListener) => () => void } => {
  let globalTick = 0
  let intervalId: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<TickListener>()

  const start = (): void => {
    if (intervalId) return
    intervalId = setInterval(() => {
      globalTick++
      for (const listener of listeners) listener(globalTick)
    }, BASE_INTERVAL_MS)
  }

  const stop = (): void => {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  const subscribe = (listener: TickListener): (() => void) => {
    listeners.add(listener)
    if (listeners.size === 1) start()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) stop()
    }
  }

  return { subscribe }
}

const ticker = createTicker()

/**
 * Subscribe to the shared animation tick.
 * @param divisor Re-render only when tick is divisible by this; 0 disables (no subscription).
 * @returns the current tick value, divided by the divisor.
 */
export const useAnimationTick = (divisor: number = 1): number => {
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    if (divisor <= 0) {
      setTick(0)
      return
    }
    const unsubscribe = ticker.subscribe((currentTick) => {
      if (currentTick % divisor === 0) setTick(Math.floor(currentTick / divisor))
    })
    return unsubscribe
  }, [divisor])

  return tick
}

// Tick divisors per node type (base interval 20ms). SPINNER pulses every 200ms.
export const TICK_DIVISORS = {
  LOADING_BAR: 2, // 40ms wave
  LOADING_TEXT: 1, // 20ms faster wave
  SPINNER: 10, // 200ms pulse
} as const
