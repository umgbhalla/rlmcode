// APP SHELL chrome extracted from chat.tsx so the App component stays small and the shell
// look (opencode session/index.tsx:1209-1412 layout + footer.tsx:52-91, termcast footer.tsx
// + row.tsx) lives in one file. Two pieces:
//   - <Composer>: the pinned, flexShrink:0 textarea card (left-border, accent/busy/error
//     tone) — the bottom-of-column input that never scrolls away (opencode prompt/index.tsx
//     pinned composer; termcast list.tsx :1887-1929 flexShrink:0 footer slot).
//   - <ActionBar>: the footer action-bar — cwd (left) · token/cost + "Cmd+K commands" (right),
//     justifyContent:space-between, flexShrink:0 (opencode footer.tsx:52-91 layout). DELIBERATELY
//     DROPS opencode's LSP/MCP/permission dots — rlmcode has neither subsystem (SPEC).
import { type ResolvedTheme } from "./theme.ts"

// cwd shortened to "~/…/leaf" style so the action-bar stays a single quiet line. The home
// prefix collapses to "~"; an absolute path keeps its leaf + one parent for context.
export const shortCwd = (cwd: string, home: string): string => {
  const p = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  const segs = p.split("/").filter(Boolean)
  if (segs.length <= 2) return p
  return `${p.startsWith("~") ? "~/…/" : "/…/"}${segs.slice(-2).join("/")}`
}

// Cost-meter for the action-bar: total tokens summed over the session's settled turns, plus a
// rough USD estimate. rlmcode has no real per-token price table (CF Workers AI is flat/free in
// dev), so cost is a coarse blended estimate — surfaced so the bar carries the "token/cost"
// the SPEC asks for, not a billing-grade figure.
// ponytail: flat blended $/Mtok constant (no per-model price table).
// Upgrade: when a price table lands, key the rate by model id from atoms meta.
const USD_PER_MTOK = 0.6
export const fmtCost = (tokens: number): string => {
  const usd = (tokens / 1_000_000) * USD_PER_MTOK
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? "<$0.01" : "$0.00"
}

// The action-bar text right cluster: "<tokens> tok · <cost> · Cmd+K commands". Pure so it's
// unit-testable and reads identically in the frame gate.
export const actionBarRight = (tokens: number, fmtTokens: (n: number) => string): string =>
  `${fmtTokens(tokens)} · ${fmtCost(tokens)} · Cmd+K commands`

// Footer ACTION-BAR — cwd left, token/cost + Cmd+K right (opencode footer.tsx:52-91 row +
// space-between). flexShrink:0 so it always reserves its line under the scrollbox.
export function ActionBar({ cwd, right, theme }: { cwd: string; right: string; theme: ResolvedTheme }) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} style={{ paddingLeft: 1, paddingRight: 1, paddingBottom: 1, flexShrink: 0 }}>
      <text fg={theme.textMuted}>{cwd}</text>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.textMuted}>{right}</text>
      </box>
    </box>
  )
}
