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
    // A reading taken before its window reset no longer says anything about
    // current use, so we do not show its old percentage.
    if (w.resetsAt && w.resetsAt <= now) return short + " not known (reset since last reading)"
    const used = Math.round(Math.max(0, Math.min(1, w.utilization)) * 100)
    const reset = w.resetsAt ? " · resets in " + until(w.resetsAt - now) : ""
    return short + " " + used + "%" + reset
  }
  return label("five_hour", "5h") + " · " + label("seven_day", "7d")
}

/** One provider row of the account picker (#2101 P9b): what GET /api/admin/hub/accounts returns. */
export interface HubAccountsProvider {
  provider: string; label: string; envVar: string; signIn: string; active: string
  profiles: Array<{ name: string; dir: string; exists: boolean }>
}

/** The bar's short line: each provider's active profile. */
export function hubAccountsText(view: HubAccountsProvider[]): string {
  return view.map((p) => p.label + ": " + p.active).join(" · ")
}

/** The picker: per provider, one radio per profile, a remove for added ones, and an add form. */
export function hubAccountsHtml(view: HubAccountsProvider[], esc: (s: string) => string): string {
  return '<p class="hsa__lead">New runs use the profile picked here. A run already going keeps its account. Sign in once per directory with the CLI itself; AgentX never reads the token.</p>' +
    view.map((p) => '<fieldset class="hsa__p"><legend>' + esc(p.label) + ' <small>' + esc(p.envVar) + '</small></legend>' +
      p.profiles.map((x) => '<label class="hsa__row"><input type="radio" name="hsa-' + esc(p.provider) + '" data-hsa-use="' + esc(p.provider) + '" value="' + esc(x.name) + '"' + (x.name === p.active ? " checked" : "") + '>' +
        '<span><b>' + esc(x.name) + '</b> <code>' + esc(x.dir) + '</code>' + (x.exists ? "" : ' <em class="hsa__miss">folder not there yet</em>') + '</span>' +
        (x.name === "default" ? "" : '<button type="button" class="hsa__rm" data-hsa-rm="' + esc(p.provider) + '" data-name="' + esc(x.name) + '" aria-label="Remove ' + esc(x.name) + '">Remove</button>') + '</label>').join("") +
      '<form class="hsa__add" data-hsa-add="' + esc(p.provider) + '"><input name="name" placeholder="work" maxlength="40" aria-label="Profile name" required><input name="dir" placeholder="~/.' + (p.provider === "codex" ? "codex" : "claude") + '-work" aria-label="Config folder" required><button type="submit" class="ax-btn ax-btn--ghost">Add</button></form>' +
      '<p class="hsa__hint">Sign in: <code>' + esc(p.signIn) + '</code></p></fieldset>').join("") +
    '<p class="hsa__note" id="hsa-note" role="status"></p>'
}

export const HUB_STATUS_HTML = `<footer class="hs" id="hub-status" aria-label="Hub status">
  <span class="hs__brand">AgentX</span>
  <span id="hs-running">Running agents —</span>
  <span class="hs__usage" id="hs-claude">Claude: checking usage…</span>
  <span class="hs__usage" title="No Codex usage reading is available yet">Codex: not known</span>
  <span class="hs__usage" title="No Gemini usage reading is available yet">Gemini: not known</span>
  <button type="button" class="hs__acct" id="hs-acct" aria-expanded="false" aria-controls="hs-acct-pop" hidden>Accounts</button>
  <span id="hs-version">Version —</span>
</footer>
<section class="hsa" id="hs-acct-pop" aria-label="CLI accounts for new runs" hidden></section>`

export const HUB_STATUS_CSS = `
.hs { position: fixed; z-index: 9; bottom: 0; left: 0; right: 0; height: 30px; display: flex; align-items: center; gap: 18px; padding: 0 18px; border-top: 1px solid var(--ax-border); background: var(--ax-bg); color: var(--ax-muted); font-size: 11.5px; white-space: nowrap; overflow-x: auto; font-variant-numeric: tabular-nums; }
.hs__brand { color: var(--ax-text); font-weight: 600; }
.hs__usage { color: var(--ax-text-2); }
.hs #hs-version { margin-left: auto; }
@media (min-width: 641px) { body { padding-bottom: 30px; } .ax-wall__nav { height: calc(100vh - 30px); } }
.hs__acct { font: inherit; color: var(--ax-text-2); background: none; border: 1px solid var(--ax-border); border-radius: 999px; padding: 1px 10px; cursor: pointer; }
.hs__acct[aria-expanded="true"] { border-color: var(--ax-accent); color: var(--ax-text); }
.hsa { position: fixed; z-index: 10; bottom: 36px; right: 18px; width: min(520px, calc(100vw - 36px)); max-height: 70vh; overflow: auto; padding: 12px 14px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-bg); box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: var(--ax-fs-sm); }
.hsa__lead, .hsa__hint, .hsa__note { margin: 0 0 8px; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.hsa__p { border: 0; border-top: 1px solid var(--ax-border); margin: 0; padding: 8px 0 4px; }
.hsa__p legend { font-weight: 600; padding: 0; }
.hsa__p legend small { color: var(--ax-muted); font-weight: 400; font-family: var(--ax-mono); }
.hsa__row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 3px 0; }
.hsa__row code, .hsa__hint code { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }
.hsa__miss { color: var(--ax-amber, #b26b00); font-style: normal; }
.hsa__rm { font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; color: var(--ax-muted); cursor: pointer; text-decoration: underline; }
.hsa__add { display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; gap: 6px; margin: 6px 0; }
.hsa__add input { font: inherit; padding: 4px 8px; border: 1px solid var(--ax-border); border-radius: 6px; background: var(--ax-surface); color: var(--ax-text); }
@media (max-width: 640px) { .hs, .hsa { display: none; } }
`
