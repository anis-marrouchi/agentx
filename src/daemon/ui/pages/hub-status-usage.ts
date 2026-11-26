// --- The status bar's engines and agents, with hover drop-downs (#2101 R5, R28) ---
//
// R28a: an item only for the plan engines an agent runs on now (its tier):
//   Claude Code and Codex. An engine no agent uses has no item.
// R28b: each item has a small bar per limit window (5 hours and week) with
//   the % used. Hovering opens a drop-down with a bar per window, the reset
//   time and when it was read. A reading taken before its window reset says
//   nothing about now: its row goes, never a guess.
// R28c: the drop-down has "Add account", which opens the accounts form
//   (#2206, hub-status.ts hubAccountsHtml) at that engine's add row.
// R28f: hovering the agents item lists every agent with its state, its
//   engine and quick actions, all existing Hub actions: Chat, Open run,
//   Pause / Resume new work (the Agents page hold) and Stop run (asks
//   first, as the Task page does).
// R28g: a number that cannot be read hides its row; "not known" is never
//   written. A window a run reported without a percentage shows its status
//   and reset time, without a bar.
// R28h: every engine in use gets the drop-down; it lists the agents that
//   use the engine.
// R28d: an engine with added accounts (#2206) shows a section per account
//   in its drop-down, each with its own bars; the item keeps the bars of
//   the account new runs use.
// R28e: an API engine (Anthropic API, Orchestrator, OpenCode) has no plan
//   limit: its item shows what its agents' runs cost today, from the run
//   costs this machine records (the Cost page's numbers). An engine whose
//   agents run elsewhere, or only on unpriced (local) models, shows its
//   name only: no guessed sum.
// R28i: an item whose account in use is at or near a limit is marked.
//
// Functions, not consts, so they ship to the browser with injectFns. The
// numbers come from GET /api/admin/hub/usage (daemon/hub-usage-api.ts).

/** One window of an engine's usage, as /api/admin/hub/usage gives it. */
export interface HubUseRow { window: string; utilization?: number; resetsAt?: number; status?: string; at: number }

/** One CLI account's usage (R28d), as /api/admin/hub/usage gives it. */
export interface HubAccountUse { name: string; active: boolean; rows: HubUseRow[]; readAt: number | null; source: string; plan?: string; signedOut?: boolean }

/** One engine's usage, as /api/admin/hub/usage gives it. */
export interface HubEngineUse { engine: string; rows: HubUseRow[]; readAt: number | null; source: string; plan?: string; accounts?: HubAccountUse[] }

/** Today's run cost on this machine (R28e), as /api/admin/hub/usage gives it. */
export interface HubSpendUse { since: number; byAgent: Record<string, number>; unpriced: Record<string, number>; agentIds: string[] }

/** An API engine's spend today: the sum over its agents that run here
 *  (none when no agent of it runs here), unpriced runs, and how many of its
 *  agents run on another machine. */
export interface HubSpendView { usd?: number; unpriced: number; byAgent: Record<string, number>; elsewhere: number }

/** An agent that runs on an engine. */
export interface HubUseAgent { id: string; name: string; node?: string }

/** A row ready to draw: its label, the % used or a status, and its colour. */
export interface HubUseView { key: string; label: string; short: string; pct?: number; status?: string; resetsAt?: number; at: number; tone: string }

/** The engines that have a plan limit to show, in bar order. */
export function hubPlanEngines(): string[] {
  return ["claude-code", "codex-cli"]
}

/** The engines billed per token, with no plan limit (R28e), in bar order. */
export function hubApiEngines(): string[] {
  return ["sdk", "orchestrator", "opencode"]
}

/** The engine's short name on the bar. */
export function hubEngineShort(engine: string): string {
  const n: Record<string, string> = { "claude-code": "Claude", "codex-cli": "Codex", sdk: "API", orchestrator: "Orchestrator", opencode: "OpenCode" }
  return n[engine] || engine
}

/**
 * R28a: the engines the agents run on now, plan engines first, each with its
 * agents, from the live snapshot's nodes. An agent listed by two machines
 * counts once.
 */
export function hubEnginesInUse(nodes: Array<{ name?: string; agents?: Array<{ id?: string; name?: string; tier?: string }> }>): Array<{ engine: string; agents: HubUseAgent[] }> {
  const plan = hubPlanEngines().concat(hubApiEngines())
  const by: Record<string, HubUseAgent[]> = {}
  const seen: Record<string, boolean> = {}
  for (const n of nodes || []) {
    for (const a of (n && n.agents) || []) {
      if (!a || !a.id || seen[a.id]) continue
      seen[a.id] = true
      const tier = a.tier || "claude-code"
      if (plan.indexOf(tier) < 0) continue
      ;(by[tier] = by[tier] || []).push({ id: a.id, name: a.name || a.id, ...(n.name && { node: n.name }) })
    }
  }
  return plan.filter((e) => by[e]).map((e) => ({ engine: e, agents: by[e].sort((x, y) => String(x.name).localeCompare(String(y.name))) }))
}

/**
 * The rows to draw for an engine, 5 hours first, then the week, then the
 * rest. A row with neither a percentage nor a status, or whose window has
 * reset since it was read, is left out (R28b, R28g).
 */
export function hubUsageRows(rows: HubUseRow[] | null | undefined, now: number): HubUseView[] {
  const order = (k: string): number => (k === "five_hour" ? 0 : k === "seven_day" ? 1 : 2)
  const out: HubUseView[] = []
  for (const r of rows || []) {
    if (!r || typeof r.window !== "string") continue
    if (r.resetsAt && r.resetsAt <= now) continue
    const has = typeof r.utilization === "number" && isFinite(r.utilization)
    if (!has && !r.status) continue
    const k = r.window
    const model = /^seven_day_(\w+)$/.exec(k)
    const mins = /^window_(\d+)m$/.exec(k)
    const label = k === "five_hour" ? "5 hours" : k === "seven_day" ? "Week" : model ? "Week · " + model[1].charAt(0).toUpperCase() + model[1].slice(1)
      : mins ? hubSpan(Number(mins[1])) : k.replace(/_/g, " ")
    const short = k === "five_hour" ? "5h" : k === "seven_day" ? "wk" : ""
    const pct = has ? Math.round(Math.max(0, Math.min(1, r.utilization as number)) * 100) : undefined
    const tone = pct !== undefined ? (pct >= 90 ? "high" : pct >= 70 ? "warn" : "ok")
      : r.status === "rejected" ? "high" : r.status === "allowed_warning" ? "warn" : "ok"
    out.push({ key: k, label, short, ...(pct !== undefined && { pct }), ...(pct === undefined && { status: r.status }), ...(r.resetsAt && { resetsAt: r.resetsAt }), at: r.at, tone })
  }
  return out.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key))
}

/** R28i: the worst tone of an engine's rows: "high" at the limit, "warn" near it, else "". */
export function hubEngineTone(rows: HubUseView[]): string {
  return rows.some((r) => r.tone === "high") ? "high" : rows.some((r) => r.tone === "warn") ? "warn" : ""
}

/** R28e: an API engine's spend today, from its agents; null when not read. */
export function hubSpendView(agents: HubUseAgent[], spend: HubSpendUse | null | undefined): HubSpendView | null {
  if (!spend) return null
  const out: HubSpendView = { unpriced: 0, byAgent: {}, elsewhere: 0 }
  let usd = 0, here = false
  for (const a of agents) {
    // Spend is kept on the machine an agent runs on: one not listed here is not summed.
    if ((spend.agentIds || []).indexOf(a.id) < 0) { out.elsewhere++; continue }
    here = true
    const v = Number((spend.byAgent || {})[a.id]) || 0
    out.byAgent[a.id] = v
    usd += v
    out.unpriced += Number((spend.unpriced || {})[a.id]) || 0
  }
  if (here) out.usd = usd
  return out
}

/** Money as the Cost page writes it (cost.ts fmtCost, wall-spend.ts). */
export function hubUsd(v: number): string {
  const n = isFinite(v) ? v : 0
  if (Math.abs(n) >= 10000) return "$" + (n / 1000).toFixed(1) + "K"
  if (n === 0) return "$0"
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4)
  return "$" + n.toFixed(2)
}

/** A window's length in words: "1 hour", "5 hours", "2 days". */
export function hubSpan(minutes: number): string {
  const n = minutes >= 1440 ? Math.round(minutes / 1440) : Math.max(1, Math.round(minutes / 60))
  return n + (minutes >= 1440 ? (n === 1 ? " day" : " days") : n === 1 ? " hour" : " hours")
}

/** A run's limit status in words. */
export function hubStatusWord(s: string | undefined): string {
  return s === "rejected" ? "Limit reached" : s === "allowed_warning" ? "Near the limit" : "Allowed"
}

/** "in 12m", "in 3h 10m", "in 2d 4h". */
export function hubIn(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000))
  if (m < 60) return "in " + m + "m"
  if (m < 48 * 60) return "in " + Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "")
  return "in " + Math.floor(m / 1440) + "d" + (Math.floor((m % 1440) / 60) ? " " + Math.floor((m % 1440) / 60) + "h" : "")
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function hubAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return m + " min ago"
  if (m < 48 * 60) return Math.floor(m / 60) + " h ago"
  return Math.floor(m / 1440) + " days ago"
}

/** A reset time on the viewer's clock: "14:05", or "Fri 14:05" past a day. */
export function hubClock(ms: number, now: number): string {
  const d = new Date(ms)
  const hm = (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes()
  return ms - now > 24 * 3600_000 ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + hm : hm
}

/** The bar item's inside: the engine's logo, its name, and a small bar per
 *  5-hour and week window that has a percentage; for an API engine, its
 *  spend today in place of a bar (R28e). */
export function hubEngineChipHtml(engine: string, rows: HubUseView[], esc: (s: unknown) => string, icon: (tier: string) => string, spend?: HubSpendView | null): string {
  const bars = rows.filter((r) => r.short && r.pct !== undefined).map((r) =>
    '<span class="hsu__w" data-tone="' + r.tone + '"><span class="hsu__k">' + r.short + '</span><span class="hsu__m" role="progressbar" aria-label="' + esc(r.label) + ' used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + r.pct + '"><i style="width:' + r.pct + '%"></i></span><b>' + r.pct + "%</b></span>").join("")
  // No percentage, but a run said the limit is reached or near: a dot says so.
  const tone = hubEngineTone(rows)
  const flag = !bars && tone ? '<i class="hsu__flag" data-tone="' + tone + '" aria-hidden="true"></i>' : ""
  // R28i: the item's colour says it; a screen reader hears it.
  const said = tone ? '<span class="hsu__sr">' + hubStatusWord(tone === "high" ? "rejected" : "allowed_warning") + "</span>" : ""
  // $0 with only unpriced runs would mislead: a local engine shows its name only.
  const usd = spend && spend.usd !== undefined && !(spend.usd === 0 && spend.unpriced > 0)
    ? '<b class="hsu__usd">' + hubUsd(spend.usd) + '</b><span class="hs__long"> today</span>' : ""
  return icon(engine) + '<span class="hsu__n">' + esc(hubEngineShort(engine)) + "</span>" + bars + flag + usd + said
}

/** The engine's full name in its drop-down. */
export function hubEngineFull(engine: string): string {
  const n: Record<string, string> = { "claude-code": "Claude Code", "codex-cli": "Codex", sdk: "Anthropic API", orchestrator: "Orchestrator", opencode: "OpenCode" }
  return n[engine] || engine
}

/** A list of usage rows with their bars and resets, and when they were read. */
export function hubRowsHtml(rows: HubUseView[], source: string, now: number, esc: (s: unknown) => string): string {
  const newest = rows.length ? Math.max(...rows.map((r) => r.at)) : 0
  const read = !newest ? ""
    : source === "session" ? "As of the last Codex run on this machine, " + hubAgo(now - newest)
    : source === "runs" ? "As the last run reported it, " + hubAgo(now - newest)
    : "Read " + hubAgo(now - newest)
  const list = rows.map((r) => {
    const reset = r.resetsAt ? '<span class="hsu__reset" title="Resets ' + esc(new Date(r.resetsAt).toLocaleString()) + '">resets ' + esc(hubClock(r.resetsAt, now)) + " · " + hubIn(r.resetsAt - now) + "</span>" : ""
    return '<li class="hsu__row" data-tone="' + r.tone + '"><span class="hsu__l">' + esc(r.label) + "</span>" +
      (r.pct !== undefined
        ? '<span class="hsu__bar" role="progressbar" aria-label="' + esc(r.label) + ' used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + r.pct + '"><i style="width:' + r.pct + '%"></i></span><b class="hsu__pct">' + r.pct + "%</b>"
        : '<span class="hsu__st">' + esc(hubStatusWord(r.status)) + "</span>") +
      reset + "</li>"
  }).join("")
  return (list ? '<ul class="hsu__rows">' + list + "</ul>" : "") + (read ? '<p class="hsu__read">' + esc(read) + "</p>" : "")
}

/** The engine's hover drop-down (R28b, c, d, e, g, h). `spend` is for an API engine. */
export function hubEnginePopHtml(engine: string, use: HubEngineUse | null, rows: HubUseView[], agents: HubUseAgent[], now: number,
  esc: (s: unknown) => string, icon: (tier: string) => string, canAdd: boolean, spend?: HubSpendView | null): string {
  const api = hubApiEngines().indexOf(engine) >= 0
  const plan = api ? "No plan limit" : use && use.plan ? use.plan.charAt(0).toUpperCase() + use.plan.slice(1) : ""
  let body = ""
  if (api) {
    // R28e: what its runs cost today, here; nothing summed that is not known.
    const n = spend ? spend.unpriced : 0, away = spend ? spend.elsewhere : 0
    body = (spend && spend.usd !== undefined ? '<p class="hsu__spend" title="Since 00:00 UTC, from each run\'s recorded cost">Spent today <b>' + hubUsd(spend.usd) + "</b></p>" : "") +
      (n ? '<p class="hsu__read">' + n + (n === 1 ? " run" : " runs") + " on a model with no price, such as a local model</p>" : "") +
      (away ? '<p class="hsu__read">' + (away === 1 ? "1 agent runs on another machine; its" : away + " agents run on other machines; their") + " spend is kept there</p>" : "")
  } else if (use && use.accounts && use.accounts.length > 1) {
    // R28d: a section per account, the one new runs use first.
    const accts = use.accounts.filter((a) => a.active).concat(use.accounts.filter((a) => !a.active))
    body = accts.map((a) => '<p class="hsu__acct"><b>' + esc(a.name) + "</b>" + (a.active ? '<span class="hsu__in">In use</span>' : "") + "</p>" +
      (a.signedOut ? '<p class="hsu__read">Signed out</p>' : hubRowsHtml(a.active ? rows : hubUsageRows(a.rows, now), a.source, now, esc))).join("")
  } else {
    body = hubRowsHtml(rows, use ? use.source : "plan", now, esc)
  }
  const who = agents.length
    ? '<p class="hsu__h">Used by ' + agents.length + (agents.length === 1 ? " agent" : " agents") + '</p><ul class="hsu__who">' +
      agents.map((a) => {
        const usd = spend && spend.byAgent[a.id] ? " · " + hubUsd(spend.byAgent[a.id]) : ""
        return '<li><a href="#page=chat&amp;agent=' + esc(encodeURIComponent(a.id)) + '" title="Open ' + esc(a.name) + '\'s chat">' + esc(a.name) + usd + "</a></li>"
      }).join("") + "</ul>"
    : ""
  const foot = api
    ? '<div class="hsu__foot"><a class="ax-btn ax-btn--ghost hsu__add" href="#status=open&amp;view=cost" title="Spend and caps for every agent">Cost</a></div>'
    : canAdd ? '<div class="hsu__foot"><button type="button" class="ax-btn ax-btn--ghost hsu__add" data-hsu-add="' + (engine === "codex-cli" ? "codex" : "claude") + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add account</button></div>' : ""
  return '<header class="hsu__hd">' + icon(engine) + "<b>" + esc(hubEngineFull(engine)) + "</b>" + (plan ? '<span class="hsu__plan">' + esc(plan) + "</span>" : "") + "</header>" +
    body + who + foot
}

/** One agent in the agents drop-down (R28f), as the bar's script builds it. */
export interface HubPopAgent {
  id: string; name: string; face: string; color: string | null
  /** working | needs | done | idle (hub-agents.ts HaState). */
  state: string
  /** The Agents page hold is on: it starts no new run. */
  paused: boolean
  tier: string
  line: string
  /** Its running task's Task page, when it has one. */
  runHref: string
  /** The Stop run control (wall-live lvBtn), when it has a running task. */
  stopHtml: string
}

/** The agents drop-down (R28f): each agent, its state and engine, and its quick actions. */
export function hubAgentsPopHtml(list: HubPopAgent[], owner: boolean, note: string, esc: (s: unknown) => string, icon: (tier: string) => string): string {
  const word: Record<string, string> = { working: "Working", needs: "Needs you", done: "Done today", idle: "Idle" }
  const rows = list.map((a) => {
    const state = a.paused ? (a.state === "working" ? "Working · paused" : "Paused") : word[a.state] || a.state
    const hold = owner ? '<button type="button" class="hsg__a" data-hsu-hold="' + (a.paused ? "resume" : "pause") + '" data-id="' + esc(a.id) + '" title="' + (a.paused ? "Let it start new runs again" : "Start no new run until you resume it; a run going now goes on") + '">' + (a.paused ? "Resume" : "Pause") + "</button>" : ""
    return '<li class="hsg__r is-' + esc(a.paused && a.state !== "working" ? "paused" : a.state) + '">' +
      '<span class="hsg__face" style="--ha-c:' + esc(a.color || "var(--ax-accent)") + '">' + esc(a.face) + '<i class="hsg__dot"></i></span>' +
      '<span class="hsg__t"><span class="hsg__top"><b>' + esc(a.name) + '</b><span class="hsg__eng" title="' + esc(a.tier) + '">' + icon(a.tier) + '</span><span class="hsg__st">' + esc(state) + "</span></span>" +
      (a.line ? '<span class="hsg__line">' + esc(a.line) + "</span>" : "") + "</span>" +
      '<span class="hsg__acts"><a class="hsg__a" href="#page=chat&amp;agent=' + esc(encodeURIComponent(a.id)) + '">Chat</a>' +
      (a.runHref ? '<a class="hsg__a" href="' + esc(a.runHref) + '">Open run</a>' : "") + hold + (a.stopHtml || "") + "</span></li>"
  }).join("")
  return '<header class="hsu__hd"><b>Agents</b><span class="hsu__plan">' + list.filter((a) => a.state === "working").length + " working · " + list.length + " in all</span></header>" +
    (rows ? '<ul class="hsg">' + rows + "</ul>" : '<p class="hsu__read">No agents yet.</p>') +
    (note ? '<p class="hsu__read" role="status">' + esc(note) + "</p>" : "")
}

/** The one drop-down the bar's items share; placed by the script over the item hovered. */
export const HUB_USAGE_POP_HTML = `<section class="hsu-pop" id="hsu-pop" aria-live="polite" hidden></section>`

export const HUB_USAGE_CSS = `
.hsu { display: inline-flex; align-items: center; gap: 6px; }
.hsu__eng, .hsu__trig { gap: 6px; }
.hsu__eng .ax-eng, .hsu-pop .ax-eng { width: 14px; height: 14px; flex: none; }
.hsu__w { display: inline-flex; align-items: center; gap: 4px; --hsu-c: var(--ax-accent); }
.hsu__k { color: var(--ax-muted); font-size: 10.5px; }
.hsu__w b { font-weight: 600; color: var(--ax-text-2); }
.hsu__m { position: relative; width: 26px; height: 4px; border-radius: 2px; background: var(--ax-border); overflow: hidden; }
.hsu__m i, .hsu__bar i { display: block; height: 100%; border-radius: inherit; background: var(--hsu-c); transition: width .5s cubic-bezier(.2, .8, .2, 1); }
[data-tone="warn"] { --hsu-c: var(--ax-amber, #f59e0b); }
[data-tone="high"] { --hsu-c: var(--ax-red, #e40014); }
.hsu__flag { width: 7px; height: 7px; border-radius: 50%; background: var(--hsu-c); }
/* R28i: an engine at or near its limit: the item takes the state colour. */
.hsu__eng[data-tone="warn"], .hsu__eng[data-tone="high"] { border-color: color-mix(in oklch, var(--hsu-c) 45%, transparent); background: color-mix(in oklch, var(--hsu-c) 10%, transparent); }
.hsu__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.hsu__usd { font-weight: 600; color: var(--ax-text-2); font-variant-numeric: tabular-nums; }
.hsu__spend { margin: 0 0 4px; color: var(--ax-text-2); }
.hsu__spend b { color: var(--ax-text); font-variant-numeric: tabular-nums; }
.hsu__acct { display: flex; align-items: center; gap: 6px; margin: 0 0 2px; font-size: 12px; }
.hsu__acct ~ .hsu__acct { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--ax-border); }
.hsu__in { color: var(--ax-muted); font-size: 11px; padding: 0 6px; border: 1px solid var(--ax-border); border-radius: 999px; }
.hsu-pop { position: fixed; z-index: 11; bottom: 36px; left: 8px; width: 300px; max-width: calc(100vw - 16px); max-height: min(70vh, 520px); overflow: auto; padding: 10px 12px; border: 1px solid var(--ax-border); border-radius: var(--ax-radius); background: var(--ax-bg); color: var(--ax-text); box-shadow: 0 12px 32px rgba(0,0,0,.18); font-size: 12.5px; transform-origin: bottom left; animation: hsu-in .14s cubic-bezier(.2, .8, .2, 1); }
.hsu-pop.is-agents { width: 440px; }
@keyframes hsu-in { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .hsu-pop { animation: none; } .hsu__m i, .hsu__bar i { transition: none; } }
.hsu__hd { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.hsu__hd b { font-size: 13px; }
.hsu__plan { margin-left: auto; color: var(--ax-muted); font-size: 11.5px; }
.hsu__rows, .hsu__who, .hsg { list-style: none; margin: 0; padding: 0; }
.hsu__row { display: grid; grid-template-columns: 86px 1fr 38px; align-items: center; gap: 4px 8px; padding: 5px 0; --hsu-c: var(--ax-accent); }
.hsu__row[data-tone="warn"] { --hsu-c: var(--ax-amber, #f59e0b); }
.hsu__row[data-tone="high"] { --hsu-c: var(--ax-red, #e40014); }
.hsu__l { color: var(--ax-text-2); }
.hsu__bar { height: 6px; border-radius: 3px; background: var(--ax-border); overflow: hidden; }
.hsu__pct { text-align: right; font-variant-numeric: tabular-nums; }
.hsu__st { grid-column: 2 / 4; color: var(--hsu-c); font-weight: 600; }
.hsu__reset { grid-column: 2 / 4; color: var(--ax-muted); font-size: 11.5px; }
.hsu__read { margin: 6px 0 0; color: var(--ax-muted); font-size: 11.5px; }
.hsu__h { margin: 10px 0 4px; color: var(--ax-muted); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.hsu__who { display: flex; flex-wrap: wrap; gap: 4px; }
.hsu__who a { display: inline-block; padding: 1px 8px; border: 1px solid var(--ax-border); border-radius: 999px; color: var(--ax-text-2); text-decoration: none; }
.hsu__who a:hover { border-color: var(--ax-accent); color: var(--ax-text); }
.hsu__foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--ax-border); }
.hsu__add { display: inline-flex; align-items: center; gap: 6px; }
.hsu__add svg { width: 13px; height: 13px; }
.hsg__r { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-radius: var(--ax-radius-sm); --ha-s: var(--ax-muted); }
.hsg__r:hover { background: var(--ax-surface-2); }
.hsg__r.is-working { --ha-s: var(--ax-accent); }
.hsg__r.is-needs { --ha-s: var(--ax-amber, #f5a524); }
.hsg__r.is-done { --ha-s: var(--ax-green, #2fbf71); }
.hsg__face { position: relative; flex: none; width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; background: var(--ha-c); color: #fff; font: 600 11.5px/1 var(--ax-font-head, inherit); }
.hsg__dot { position: absolute; right: -3px; bottom: -3px; width: 9px; height: 9px; border-radius: 50%; background: var(--ha-s); border: 2px solid var(--ax-bg); }
.hsg__r.is-working .hsg__dot::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--ha-s); opacity: 0; animation: ha-ping 2s cubic-bezier(0, 0, .2, 1) infinite; }
@media (prefers-reduced-motion: reduce) { .hsg__r.is-working .hsg__dot::after { animation: none; } }
.hsg__t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hsg__top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.hsg__top b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hsg__eng { display: inline-flex; }
.hsg__st { color: var(--ax-muted); font-size: 11px; white-space: nowrap; }
.hsg__line { color: var(--ax-text-2); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hsg__acts { flex: none; display: inline-flex; gap: 2px; opacity: .55; transition: opacity .12s; }
.hsg__r:hover .hsg__acts, .hsg__r:focus-within .hsg__acts { opacity: 1; }
.hsg__a { font: inherit; font-size: 11.5px; color: var(--ax-text-2); background: none; border: 1px solid transparent; border-radius: var(--ax-radius-sm); padding: 2px 6px; cursor: pointer; text-decoration: none; white-space: nowrap; }
.hsg__a:hover { background: var(--ax-surface-3); color: var(--ax-text); }
.hsg__acts .wlv__b { font-size: 11.5px; padding: 2px 6px; min-height: 0; }
/* Up to 1180 px the engine items keep their logo and bars, not their names;
   the agents item says "3 running" (#2101 "fits 900 px"). */
@media (max-width: 1180px) {
  .hsu__n, .hs__long { display: none; }
  .hsu__k { display: none; }
}
`
