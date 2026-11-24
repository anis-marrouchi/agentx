// The Hub's desktop status bar (#2101 P9a). It reads the same Claude plan
// windows as /usage/plan. Codex and Gemini stay unknown until their CLIs
// provide a reading; we never present a guessed percentage as usage.

export interface HubUsageWindow { window: string; utilization: number; resetsAt?: number }

export function hubUsageText(windows: HubUsageWindow[], now: number): string {
  const until = (ms: number): string => {
    const minutes = Math.ceil(ms / 60_000)
    return minutes < 60 ? minutes + "m" : minutes < 48 * 60 ? Math.ceil(minutes / 60) + "h" : Math.ceil(minutes / (24 * 60)) + "d"
  }
  const label = (key: string, short: string): string => {
    const w = windows.find((item) => item.window === key && Number.isFinite(item.utilization))
    if (!w) return short + " not known"
    const used = Math.round(Math.max(0, Math.min(1, w.utilization)) * 100)
    const reset = w.resetsAt && w.resetsAt > now
      ? " · resets in " + until(w.resetsAt - now)
      : ""
    return short + " " + used + "%" + reset
  }
  return label("five_hour", "5h") + " · " + label("seven_day", "7d")
}

export const HUB_STATUS_HTML = `<footer class="hs" id="hub-status" aria-label="Hub status">
  <span class="hs__brand">AgentX</span>
  <span id="hs-running">Running agents —</span>
  <span class="hs__usage" id="hs-claude">Claude: checking usage…</span>
  <span class="hs__usage" title="No Codex usage reading is available yet">Codex: not known</span>
  <span class="hs__usage" title="No Gemini usage reading is available yet">Gemini: not known</span>
  <span id="hs-version">Version —</span>
</footer>`

export const HUB_STATUS_CSS = `
.hs { position: fixed; z-index: 9; bottom: 0; left: 0; right: 0; height: 30px; display: flex; align-items: center; gap: 18px; padding: 0 18px; border-top: 1px solid var(--ax-border); background: var(--ax-bg); color: var(--ax-muted); font-size: 11.5px; white-space: nowrap; overflow-x: auto; font-variant-numeric: tabular-nums; }
.hs__brand { color: var(--ax-text); font-weight: 600; }
.hs__usage { color: var(--ax-text-2); }
.hs #hs-version { margin-left: auto; }
@media (min-width: 641px) { body { padding-bottom: 30px; } .ax-wall__nav { height: calc(100vh - 30px); } }
@media (max-width: 640px) { .hs { display: none; } }
`
