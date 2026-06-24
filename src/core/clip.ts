// THE one clip — a leaf with NO core-engine imports, so every module that needs to bound a
// payload for a span attribute / activity detail shares this single copy without an import cycle.
// orch.ts (which imports orch-spans.ts) re-exports it, runtime.ts re-exports it for the drivers,
// and orch-spans.ts (a leaf orch.ts imports) pulls it straight from here — all cycle-free.
// Stringify an unknown payload, bounded: a string passes through, anything else JSON.stringifies
// (falling back to String() if that throws), then truncates to `max` with a … ellipsis.
export const clip = (v: unknown, max = 256): string => {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v) } catch { return String(v) } })()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
