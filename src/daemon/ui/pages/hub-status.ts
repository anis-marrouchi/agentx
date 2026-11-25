// The Hub's desktop status bar (#2101 P9a, R23, R25). It reads the same
// Claude plan windows as /usage/plan. Codex and Gemini stay unknown until
// their CLIs provide a reading; we never present a guessed percentage as
// usage. R25 (Orca's bottom bar): each item has an icon, and the CLI
// drop-down switches the engine of the agent in view; R23: the light/dark
// switch lives here, not in the side menu.

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

/** The engines an agent can run on, as Settings names them (wall-settings.client.ts
 *  ST_ENGINES). A function, not a const, so it ships to the browser with injectFns. */
export function hubEngines(): Array<[string, string]> {
  return [["claude-code", "Claude Code"], ["codex-cli", "Codex CLI"], ["opencode", "OpenCode"], ["sdk", "Anthropic API (SDK)"], ["orchestrator", "Orchestrator"]]
}

/** One agent the CLI drop-down can switch: from the live snapshot. */
export interface HubCliAgent { id: string; name: string; tier: string; node?: string; pendingTier?: string; running?: number }

export function hubRunsWord(n: number): string {
  return n === 1 ? "its 1 running job ends" : n > 1 ? "its " + n + " running jobs end" : "its running jobs end"
}

/** The note after a Switch: at once for an idle agent; a busy one switches
 *  when its running jobs end, and new runs wait till then (#2101 B2). */
export function hubCliSavedText(a: HubCliAgent, picked: string): string {
  const to = hubEngineName(picked)
  if (!(a.running && a.running > 0)) return "Saved. " + a.name + "'s next run uses " + to + "."
  return "Saved. " + a.name + " switches to " + to + " when " + hubRunsWord(a.running) + ". New runs wait and start on " + to + "."
}

/** The waiting line under the agent while a switch has not landed yet (#2101 B2). */
export function hubCliWaitText(a: HubCliAgent): string {
  if (!a.pendingTier || a.pendingTier === a.tier) return ""
  return "Waiting to switch: " + hubEngineName(a.tier) + " → " + hubEngineName(a.pendingTier) + " when " + hubRunsWord(a.running || 0) + ". Pick " + hubEngineName(a.tier) + " again to cancel the wait."
}

/** An engine's name; an engine we do not list keeps its own id. */
export function hubEngineName(tier: string): string {
  const e = hubEngines().find(([k]) => k === (tier || "claude-code"))
  return e ? e[1] : tier
}

/** The drop-down button's words: the agent in view and its engine. */
export function hubCliText(a: HubCliAgent | null | undefined): string {
  if (!a) return "CLI · pick an agent"
  const wait = a.pendingTier && a.pendingTier !== a.tier
  return hubEngineName(a.tier) + (wait ? " → " + hubEngineName(a.pendingTier!) + " (waiting)" : "") + " · " + a.name
}

/** The CLI drop-down (R25): which agent, then one choice per engine, then Save.
 *  `icon(tier)`, when given, puts the engine's own logo before its name
 *  (engine-icons.ts, #2272). */
export function hubCliHtml(list: HubCliAgent[], cur: string, note: { kind: string; text: string }, esc: (s: unknown) => string, icon?: (tier: string) => string): string {
  const a = list.find((x) => x.id === cur) || null
  const opts = '<option value="">Pick an agent</option>' + list.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === cur ? " selected" : "") + ">" + esc(x.name) + (x.node ? " · " + esc(x.node) : "") + "</option>").join("")
  const next = a ? a.pendingTier || a.tier || "claude-code" : ""
  const engines = a ? hubEngines().map(([k, label]) => '<label class="hsc__eng"><input type="radio" name="hsc-eng" value="' + esc(k) + '"' + (k === next ? " checked" : "") + ">" + (icon ? icon(k) : "") + "<span>" + esc(label) + "</span></label>").join("") : ""
  const wait = a ? hubCliWaitText(a) : ""
  return '<p class="hsa__lead">The engine this agent\'s next run uses. A run already going keeps its engine; a busy agent switches when its running jobs end.</p>' +
    '<label class="hsc__who">Agent <select data-hsc-agent aria-label="Agent">' + opts + "</select></label>" +
    (wait ? '<p class="hsa__note is-wait" data-hsc-wait>' + esc(wait) + "</p>" : "") +
    (a ? '<fieldset class="hsa__p"><legend>Engine</legend>' + engines + "</fieldset>" +
      '<div class="hsc__acts"><button type="button" class="ax-btn" data-hsc-save>Switch</button></div>' : "") +
    '<p class="hsa__note' + (note.kind ? " is-" + esc(note.kind) : "") + '" role="status">' + esc(note.text) + "</p>"
}

/** The connection chip's words and state (R25): what the last live read said. */
export function hubConnState(o: { live: boolean; error: boolean; online: boolean }): { state: string; text: string } {
  if (!o.online) return { state: "off", text: "Offline" }
  if (o.error) return { state: "err", text: "Reconnecting…" }
  if (!o.live) return { state: "wait", text: "Connecting…" }
  return { state: "ok", text: "Connected" }
}

const HS_ICON = {
  node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/></svg>',
  gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-6"/></svg>',
  cli: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 4 4-4 4M12 17h7"/></svg>',
  theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2" fill="currentColor"/></svg>',
  down: '<svg class="hs__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>',
}

export const HUB_STATUS_HTML = `<footer class="hs" id="hub-status" aria-label="Hub status">
  <span class="hs__conn" id="hs-conn" data-state="wait" role="status"><i class="hs__dot" aria-hidden="true"></i><span id="hs-conn-t">Connecting…</span></span>
  <span class="hs__i" id="hs-node" title="The machines this Hub reads">${HS_ICON.node}<span id="hs-node-t">Machine —</span></span>
  <span class="hs__i">${HS_ICON.agents}<span id="hs-running">Running agents —</span></span>
  <span class="hs__i hs__usage">${HS_ICON.gauge}<span id="hs-claude">Claude: checking usage…</span></span>
  <span class="hs__usage" title="No Codex usage reading is available yet">Codex: not known</span>
  <span class="hs__usage" title="No Gemini usage reading is available yet">Gemini: not known</span>
  <span class="hs__gap"></span>
  <button type="button" class="hs__btn hs__acct" id="hs-acct" aria-expanded="false" aria-controls="hs-acct-pop" hidden>Accounts</button>
  <button type="button" class="hs__btn" id="hs-cli" aria-haspopup="dialog" aria-expanded="false" aria-controls="hs-cli-pop" title="Switch the CLI of the agent in view" hidden><span id="hs-cli-i" class="hs__eng">${HS_ICON.cli}</span><span id="hs-cli-t">CLI</span>${HS_ICON.down}</button>
  <button type="button" class="hs__btn" data-wall-theme title="Light / dark" aria-label="Switch light or dark">${HS_ICON.theme}<span>Theme</span></button>
  <span class="hs__i">${HS_ICON.tag}<span id="hs-version">Version —</span></span>
</footer>
<section class="hsa" id="hs-acct-pop" aria-label="CLI accounts for new runs" hidden></section>
<section class="hsa hsc" id="hs-cli-pop" aria-label="Switch the CLI of an agent" hidden></section>`

export const HUB_STATUS_CSS = `
.hs { position: fixed; z-index: 9; bottom: 0; left: 0; right: 0; height: 30px; display: flex; align-items: center; gap: 18px; padding: 0 18px; border-top: 1px solid var(--ax-border); background: var(--ax-bg); color: var(--ax-muted); font-size: 11.5px; white-space: nowrap; overflow-x: auto; font-variant-numeric: tabular-nums; }
.hs__usage { color: var(--ax-text-2); }
.hs__i, .hs__conn, .hs__btn { display: inline-flex; align-items: center; gap: 5px; }
.hs svg { width: 13px; height: 13px; flex: none; }
.hs__gap { margin-left: auto; }
.hs__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ax-muted); }
.hs__conn[data-state="ok"] .hs__dot { background: var(--ax-green); }
.hs__conn[data-state="err"] .hs__dot, .hs__conn[data-state="off"] .hs__dot { background: var(--ax-amber, #f5a524); }
.hs__conn[data-state="err"], .hs__conn[data-state="off"] { color: var(--ax-amber-ink, var(--ax-text)); }
.hs__btn { font: inherit; color: var(--ax-text-2); background: none; border: 1px solid transparent; border-radius: var(--ax-radius-sm); padding: 2px 6px; cursor: pointer; }
.hs__btn:hover, .hs__btn[aria-expanded="true"] { background: var(--ax-surface-3); color: var(--ax-text); }
.hs__btn:focus-visible { outline: 2px solid var(--ax-ring, var(--ax-accent)); outline-offset: 1px; }
.hs__chev { width: 11px; height: 11px; }
.hsa { position: fixed; z-index: 10; bottom: 36px; right: 18px; width: min(520px, calc(100vw - 36px)); max-height: 70vh; overflow: auto; padding: 12px 14px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-bg); box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: var(--ax-fs-sm); }
.hsa__lead, .hsa__hint, .hsa__note { margin: 0 0 8px; color: var(--ax-muted); font-size: var(--ax-fs-xs); }
.hsa__note.is-ok { color: var(--ax-green-d, var(--ax-text)); }
.hsa__note.is-err { color: var(--ax-red-ink, var(--ax-red)); }
.hsa__note.is-wait { color: var(--ax-amber-ink, var(--ax-text)); }
.hsa__p { border: 0; border-top: 1px solid var(--ax-border); margin: 8px 0 0; padding: 8px 0 4px; }
.hsa__p legend { font-weight: 600; padding: 0; }
.hsa__hint code { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); }
.hsc__who { display: flex; align-items: center; gap: 8px; }
.hsc__who select { flex: 1; min-width: 0; font: inherit; padding: 4px 8px; border: 1px solid var(--ax-border); border-radius: 6px; background: var(--ax-surface); color: var(--ax-text); }
.hsc__eng { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.hsc__eng .ax-eng, .hs__eng .ax-eng { width: 15px; height: 15px; }
.hs__eng { display: inline-flex; }
.hsc__acts { margin: 8px 0; }
@media (min-width: 641px) { body { padding-bottom: 30px; } .ax-wall__nav { height: calc(100vh - 30px); } }
.hs__acct { font: inherit; color: var(--ax-text-2); background: none; border: 1px solid var(--ax-border); border-radius: 999px; padding: 1px 10px; cursor: pointer; }
.hs__acct[aria-expanded="true"] { border-color: var(--ax-accent); color: var(--ax-text); }
.hsa__p legend small { color: var(--ax-muted); font-weight: 400; font-family: var(--ax-mono); }
.hsa__row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 3px 0; }
.hsa__row code, .hsa__hint code { font-family: var(--ax-mono); font-size: var(--ax-fs-xs); overflow-wrap: anywhere; }
.hsa__miss { color: var(--ax-amber, #b26b00); font-style: normal; }
.hsa__rm { font: inherit; font-size: var(--ax-fs-xs); background: none; border: 0; color: var(--ax-muted); cursor: pointer; text-decoration: underline; }
.hsa__add { display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; gap: 6px; margin: 6px 0; }
.hsa__add input { font: inherit; padding: 4px 8px; border: 1px solid var(--ax-border); border-radius: 6px; background: var(--ax-surface); color: var(--ax-text); }
/* Up to 1180 px (the icon nav), everything still fits on one line: the
   Claude reading and the CLI button shorten with an ellipsis (the CLI
   drop-down names the agent), Accounts is its one word (the full words
   stay in its title), Codex and Gemini are left out (both "not known" today) and
   Theme is its icon (#2101 "fits 900 px"). */
.hs > * { flex: none; }
.hs > .hs__usage.hs__i { flex: 0 1 auto; min-width: 60px; overflow: hidden; }
#hs-claude, #hs-cli-t { overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 1180px) {
  .hs { gap: 12px; padding: 0 10px; overflow-x: hidden; }
  .hs > .hs__usage:not(.hs__i), .hs__btn[data-wall-theme] > span { display: none; }
  .hs__acct-s { display: none; }
  #hs-cli-t { max-width: 120px; }
}
@media (max-width: 640px) { .hs, .hsa { display: none; } }
/* Each thing once (R27): on a computer the version is the bar's; the title
   row keeps only "Restart pending" and "as of". A phone has no bar, so its
   title row keeps the version. */
@media (min-width: 641px) { .wbl .wbl__v, .wbl .wbl__since { display: none; } }
`
