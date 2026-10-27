// --- The Cost page in the Wall space (#1423, #1449) ---
//
// Global spend and each agent's spend, in the Wall's look. No new cost
// logic: it reads GET /api/admin/observability/cost (the usage_daily sums)
// and /api/admin/observability/budgets (the month's spend, caps and unpriced
// runs the profile line already shows). It is the only Cost page: the
// classic /admin/cost redirects here (#1449).
//
// The page fetches the cost for twice the range picked (at least 30 days),
// so the same reply gives the range, the period before it for the change,
// and the 30-day sparkline. The range keeps the API's own cut-off, the
// days on or after today - N (UTC), so its total matches the API's
// spendRange for ?range=N. "All" (range 0) reads everything, with no
// period before it.
//
// Owner-only writes: the caps form posts to /api/admin/budgets, which sits
// behind the dashboard token gate like every /api/admin/* route. The CSV
// export reads /api/admin/observability/cost.csv for the range picked.
//
// Shipped to the browser through injectFns, so each function is
// self-contained.

/** The range tabs, in days; 0 is "All". */
export const COST_RANGES = [7, 14, 30, 90, 0] as const

interface CostAgentDay { tasks?: number; cost?: number; input?: number; cacheRead?: number }
interface CostReply {
  generatedAt?: string
  kpis?: { spendToday?: number; spend7d?: number; spendDeltaWoW?: number }
  days?: Array<{ date: string; cost?: number; tasks?: number; input?: number; output?: number; cacheRead?: number; cacheCreate?: number; agents?: Record<string, CostAgentDay> }>
}
interface BudgetRowLike { agentId?: string; name?: string; spentUsd?: number; capUsd?: number; state?: string; unpricedRuns?: number }
interface BudgetsReply { month?: string; agents?: BudgetRowLike[]; projects?: BudgetRowLike[]; fleet?: BudgetRowLike; agentIds?: string[] }

export interface CostAgentRow {
  id: string
  spend: number
  runs: number
  perRun: number | null
  prev: number
  /** Change against the period before, as a fraction; null when that period spent nothing. */
  change: number | null
  monthSpent?: number
  cap?: number
  state?: string
  unpriced: number
}

export interface CostCapRow { key: string; label: string; spent: number; cap?: number; state?: string; unpriced: number }

export interface CostDayRow { date: string; tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; cost: number; top: string[] }

export interface CostPageModel {
  /** Days in the range; 0 is "All". */
  range: number
  today: string
  total: number
  runs: number
  cacheHit: number | null
  dates: string[]
  /** Up to five agents with their own band in the chart; the rest are "others". */
  top: string[]
  /** Per date: spend of each top agent, then others. */
  stacks: number[][]
  spark30: number[]
  agents: CostAgentRow[]
  movers: Array<{ id: string; week: number; before: number }>
  month?: { spent: number; cap?: number; state?: string; label?: string }
  spendToday?: number
  spend7d?: number
  wow?: number
  unpriced: number
  /** Token mix over the range. */
  mix: { input: number; output: number; cacheRead: number; cacheCreate: number }
  /** Days in the range, newest first. */
  daily: CostDayRow[]
  /** What a cap can be set on: the fleet, each project, each agent. Empty when the budgets read failed. */
  caps: CostCapRow[]
}

/** The page's numbers from the two replies. `budgets` may be null (read failed). */
export function costPageModel(cost: CostReply, budgets: BudgetsReply | null, range: number, todayIso?: string): CostPageModel {
  const today = (todayIso || cost.generatedAt || new Date().toISOString()).slice(0, 10)
  const back = (n: number): string => new Date(Date.parse(today + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10)
  const all = !(range > 0)
  const cut = all ? "" : back(range), prevCut = all ? "" : back(2 * range), weekCut = back(7), week2Cut = back(14)
  const days = (cost.days || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const byDate: Record<string, NonNullable<CostReply["days"]>[number]> = {}
  for (const d of days) byDate[d.date] = d

  const acc: Record<string, { spend: number; runs: number; prev: number; week: number; before: number }> = {}
  const at = (id: string) => acc[id] || (acc[id] = { spend: 0, runs: 0, prev: 0, week: 0, before: 0 })
  let total = 0, runs = 0
  const mix = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  const daily: CostDayRow[] = []
  for (const d of days) {
    const cur = d.date >= cut, prev = !all && !cur && d.date >= prevCut
    if (cur) {
      total += d.cost || 0; runs += d.tasks || 0
      mix.input += d.input || 0; mix.output += d.output || 0; mix.cacheRead += d.cacheRead || 0; mix.cacheCreate += d.cacheCreate || 0
      const ag = d.agents || {}
      daily.push({
        date: d.date, tasks: d.tasks || 0, input: d.input || 0, output: d.output || 0, cacheRead: d.cacheRead || 0, cacheCreate: d.cacheCreate || 0, cost: d.cost || 0,
        top: Object.keys(ag).filter((id) => (ag[id].cost || 0) > 0).sort((a, b) => (ag[b].cost || 0) - (ag[a].cost || 0)).slice(0, 3),
      })
    }
    for (const [id, a] of Object.entries(d.agents || {})) {
      const r = at(id)
      if (cur) { r.spend += a.cost || 0; r.runs += a.tasks || 0 }
      if (prev) r.prev += a.cost || 0
      if (d.date >= weekCut) r.week += a.cost || 0
      else if (d.date >= week2Cut) r.before += a.cost || 0
    }
  }
  daily.reverse()

  const rows: Record<string, BudgetRowLike> = {}
  for (const b of budgets?.agents || []) if (b.agentId) rows[b.agentId] = b
  // An agent with unpriced runs this month is listed even with no priced spend.
  for (const id of Object.keys(rows)) if (rows[id].unpricedRuns) at(id)

  const agents: CostAgentRow[] = Object.keys(acc).map((id) => {
    const r = acc[id], b = rows[id]
    return {
      id, spend: r.spend, runs: r.runs, perRun: r.runs ? r.spend / r.runs : null, prev: r.prev,
      change: r.prev > 0 ? (r.spend - r.prev) / r.prev : null,
      ...(b ? { monthSpent: b.spentUsd || 0, ...(b.capUsd ? { cap: b.capUsd } : {}), state: b.state } : {}),
      unpriced: (b && b.unpricedRuns) || 0,
    }
  }).filter((r) => r.spend > 0 || r.runs > 0 || r.prev > 0 || r.unpriced > 0)
    .sort((a, b) => b.spend - a.spend || b.runs - a.runs || (a.id < b.id ? -1 : 1))

  const dates: string[] = []
  if (all) {
    const first = days.length ? days[0].date : today
    for (let n = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(first + "T00:00:00Z")) / 86400000); n >= 0; n--) dates.push(back(n))
  } else for (let n = range; n >= 0; n--) dates.push(back(n))
  const top = agents.filter((a) => a.spend > 0).slice(0, 5).map((a) => a.id)
  const stacks = dates.map((date) => {
    const ag = (byDate[date] && byDate[date].agents) || {}
    const band = top.map((id) => (ag[id] && ag[id].cost) || 0)
    const dayCost = (byDate[date] && byDate[date].cost) || 0
    band.push(Math.max(0, dayCost - band.reduce((s, v) => s + v, 0)))
    return band
  })
  const spark30: number[] = []
  for (let n = 29; n >= 0; n--) { const d = byDate[back(n)]; spark30.push((d && d.cost) || 0) }

  const movers = Object.keys(acc).map((id) => ({ id, week: acc[id].week, before: acc[id].before }))
    .filter((m) => m.week !== m.before)
    .sort((a, b) => Math.abs(b.week - b.before) - Math.abs(a.week - a.before)).slice(0, 3)

  // The caps form's choices, as the budgets read lists them: the fleet,
  // every project, then every agent this machine runs (with or without spend).
  const capRow = (key: string, label: string, b?: BudgetRowLike): CostCapRow =>
    ({ key, label, spent: (b && b.spentUsd) || 0, ...(b && b.capUsd ? { cap: b.capUsd } : {}), state: (b && b.state) || "uncapped", unpriced: (b && b.unpricedRuns) || 0 })
  const caps: CostCapRow[] = []
  if (budgets) {
    caps.push(capRow("fleet", "All agents (fleet)", budgets.fleet))
    for (const p of budgets.projects || []) if (p.name) caps.push(capRow("project:" + p.name, "Project " + p.name, p))
    const ids = (budgets.agentIds || []).slice()
    for (const id of Object.keys(rows)) if (ids.indexOf(id) < 0) ids.push(id)
    for (const id of ids) caps.push(capRow("agent:" + id, id, rows[id]))
  }

  const f = budgets?.fleet
  return {
    range: all ? 0 : range, today, total, runs, cacheHit: mix.input + mix.cacheRead > 0 ? mix.cacheRead / (mix.input + mix.cacheRead) : null,
    dates, top, stacks, spark30, agents, movers,
    ...(f ? { month: { spent: f.spentUsd || 0, ...(f.capUsd ? { cap: f.capUsd } : {}), state: f.state, label: budgets?.month } } : {}),
    ...(cost.kpis ? { spendToday: cost.kpis.spendToday || 0, spend7d: cost.kpis.spend7d || 0, wow: cost.kpis.spendDeltaWoW || 0 } : {}),
    unpriced: (f && f.unpricedRuns) || 0,
    mix, daily, caps,
  }
}

/** What the page remembers between draws: the caps form and the breakdown. */
export interface CostPageUi {
  /** The caps form's choice, such as "fleet", "project:Shop" or "agent:helper". */
  scope?: string
  /** The caps form's last answer. */
  capMsg?: string
  /** The CSV export's last answer, when it failed. */
  csvMsg?: string
  /** The token mix and daily detail are open. */
  more?: boolean
  /** The daily detail's filter: "all", "weekdays" or "over10". */
  filter?: string
}

/**
 * The page's markup. `names` maps agent ids to display names; `avatarOf`
 * draws an agent's avatar (the Wall passes its own). Rows carry
 * data-cagent, which opens the agent's Wall profile; data-ccap picks that
 * agent in the caps form.
 */
export function costPageHtml(m: CostPageModel, names: Record<string, string>, avatarOf?: (id: string) => string, ui?: CostPageUi): string {
  const u: CostPageUi = ui || {}
  const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  // The same money format as the profile's spend line (wall-spend.ts).
  const usd = (v: number): string => {
    let n = Number(v)
    if (!isFinite(n)) n = 0
    if (Math.abs(n) >= 10000) return "$" + (n / 1000).toFixed(1) + "K"
    if (n === 0) return "$0"
    if (Math.abs(n) < 0.01) return "$" + n.toFixed(4)
    return "$" + n.toFixed(2)
  }
  const tok = (v: number): string => (v >= 1e9 ? (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(Math.round(v || 0)))
  const pct = (x: number): string => (x > 0 ? "▲ " : x < 0 ? "▼ " : "") + Math.abs(Math.round(x * 100)) + "%"
  const name = (id: string): string => names[id] || id
  const all = m.range === 0
  const over = all ? "since the first record" : "over " + m.range + " days"
  const spark = (vals: number[], cls: string, label: string): string => {
    const max = Math.max(0, ...vals)
    const pts = vals.map((v, i) => (vals.length > 1 ? (i / (vals.length - 1)) * 100 : 50).toFixed(1) + "," + (max ? 28 - (v / max) * 26 : 28).toFixed(1)).join(" ")
    return '<svg class="' + cls + '" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '"><polyline points="' + pts + '"/></svg>'
  }
  const STATE: Record<string, string> = { ok: "On track", warn: "Near cap", paused: "Paused", uncapped: "No cap" }

  const head = '<header class="wc__head"><div class="wc__big">' +
    (m.month ? "<b>" + usd(m.month.spent) + "</b> this month" + (m.month.cap ? " of " + usd(m.month.cap) : "") +
      (m.month.state === "paused" ? ' <span class="chip chip--err">fleet cap reached</span>' : m.month.state === "warn" ? ' <span class="chip chip--warn">near cap</span>' : "")
      : '<span class="k">This month\'s total is not available: the budgets read failed.</span>') + "</div>" +
    '<div class="wc__kpis">' +
      (m.spendToday != null ? "<span>Today <b>" + usd(m.spendToday) + "</b></span>" : "") +
      (m.spend7d != null ? "<span>7 days <b>" + usd(m.spend7d) + "</b>" + (m.wow ? ' <i class="' + (m.wow > 0 ? "up" : "down") + '">' + pct(m.wow) + " vs the week before</i>" : "") + "</span>" : "") +
    "</div>" + spark(m.spark30, "wc__spark30", "Spend per day, last 30 days") + "</header>"

  const tabs = '<div class="wc__bar-row"><div class="ax-wall__views wc__tabs" role="tablist" aria-label="Range">' + [7, 14, 30, 90, 0].map((n) =>
    '<button type="button" role="tab" data-crange="' + n + '" class="' + (m.range === n ? "is-on" : "") + '" aria-selected="' + (m.range === n ? "true" : "false") + '">' + (n ? n + " days" : "All") + "</button>").join("") + "</div>" +
    '<button type="button" class="ax-btn ax-btn--ghost wc__csv" data-ccsv title="Download the days of this range as a spreadsheet file (CSV)">Export CSV</button></div>' +
    (u.csvMsg ? '<p class="wc__warn" role="alert">' + esc(u.csvMsg) + "</p>" : "")

  const unpricedNote = m.unpriced
    ? '<p class="wc__warn" role="note">' + m.unpriced + " run" + (m.unpriced === 1 ? "" : "s") + " this month had no price (a model with no rate, such as a local one). They are not in these totals, and a cap does not stop them.</p>"
    : ""
  const sum = '<p class="ax-wall__count">' + usd(m.total) + " " + over + " · " + m.runs + " run" + (m.runs === 1 ? "" : "s") +
    (m.runs ? " · " + usd(m.total / m.runs) + " per run" : "") + "</p>" + unpricedNote

  const max = Math.max(0, ...m.stacks.map((s) => s.reduce((a, b) => a + b, 0)))
  const w = 100 / Math.max(1, m.dates.length)
  const bars = m.stacks.map((s, i) => {
    let y = 100
    return s.map((v, k) => {
      if (!v || !max) return ""
      const h = (v / max) * 100
      y -= h
      return '<rect class="wc-s' + (k < m.top.length ? k : 5) + '" x="' + (i * w + w * 0.1).toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + (w * 0.8).toFixed(2) + '" height="' + h.toFixed(2) + '"><title>' + esc(m.dates[i] + " · " + (k < m.top.length ? name(m.top[k]) : "others") + " · " + usd(v)) + "</title></rect>"
    }).join("")
  }).join("")
  const legend = m.top.map((id, k) => '<span><i class="wc-s' + k + '"></i>' + esc(name(id)) + "</span>").join("") +
    (m.stacks.some((s) => s[s.length - 1] > 0) ? '<span><i class="wc-s5"></i>others</span>' : "")
  const span = all ? "since the first record" : "last " + m.range + " days"
  const chart = '<figure class="wc__chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Spend per day by agent, ' + span + '">' + bars + "</svg>" +
    '<figcaption><span class="k">' + esc(m.dates[0]) + " – " + esc(m.today) + " · peak " + usd(max) + "</span>" + legend + "</figcaption></figure>" +
    spark(m.stacks.map((s) => s.reduce((a, b) => a + b, 0)), "wc__phone", "Spend per day, " + span)

  const rows = m.agents.length ? '<ol class="wc__rows">' + m.agents.map((a) => {
    const capBtn = m.caps.length ? ' <button type="button" class="wc__link" data-ccap="agent:' + esc(a.id) + '" title="' + esc("Set the monthly cap of " + name(a.id)) + '">' + (a.cap ? "Change cap" : "Set a cap") + "</button>" : ""
    const bar = a.cap
      ? '<span class="wc__bar' + (a.state === "paused" ? " is-err" : a.state === "warn" ? " is-warn" : "") + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(Math.min(100, ((a.monthSpent || 0) / a.cap) * 100)) + '" aria-label="' + esc(name(a.id) + ": month spend against its cap") + '"><i style="width:' + Math.min(100, ((a.monthSpent || 0) / a.cap) * 100).toFixed(1) + '%"></i></span><small>' + usd(a.monthSpent || 0) + " of " + usd(a.cap) + " this month</small>"
      : "<small>no cap</small>"
    const change = all ? "" : a.change == null ? (a.spend ? '<i class="new">new</i>' : "") : '<i class="' + (a.change > 0 ? "up" : a.change < 0 ? "down" : "") + '">' + pct(a.change) + "</i>"
    return '<li class="wc__row"><button type="button" class="wc__who" data-cagent="' + esc(a.id) + '" title="' + esc(name(a.id)) + ': profile and posts">' +
        (avatarOf ? avatarOf(a.id) : "") + "<span><b>" + esc(name(a.id)) + "</b><small>@" + esc(a.id) + "</small></span></button>" +
      '<span class="wc__amt"><b>' + usd(a.spend) + "</b>" + change + "</span>" +
      '<span class="wc__cap">' + bar + capBtn + "</span>" +
      '<span class="wc__runs">' + a.runs + " run" + (a.runs === 1 ? "" : "s") + (a.perRun != null ? " · " + usd(a.perRun) + " per run" : "") +
        (a.unpriced ? ' · <b class="wc__np">' + a.unpriced + " not priced this month</b>" : "") + "</span></li>"
  }).join("") + "</ol>" : '<p class="ax-wall__empty">No spend ' + (all ? "recorded yet" : "in the last " + m.range + " days") + ".</p>"

  const rail = '<aside class="wc__rail" aria-label="Cost notes">' +
    "<h3>Biggest movers this week</h3>" + (m.movers.length ? "<ul>" + m.movers.map((x) =>
      "<li><span>" + esc(name(x.id)) + "</span><b>" + usd(x.week) + "</b><small>" + (x.before ? pct((x.week - x.before) / x.before) : "new") + " vs " + usd(x.before) + "</small></li>").join("") + "</ul>"
      : '<p class="k">No change against the week before.</p>') +
    "<h3>Cache</h3><p>" + (m.cacheHit == null ? '<span class="k">No input tokens in this range.</span>' : "<b>" + Math.round(m.cacheHit * 100) + "%</b> of input read from the cache " + over) + "</p>" +
    "<h3>Runs without a cost</h3><p>" + (m.unpriced ? '<b class="wc__np">' + m.unpriced + "</b> this month, not in the totals" : "None this month") + "</p></aside>"

  // Monthly caps: the fleet and the projects with a cap or spend, then the
  // form that sets any cap. The agents' own caps are on their rows above.
  const scope = m.caps.some((c) => c.key === u.scope) ? (u.scope as string) : m.caps.length ? m.caps[0].key : ""
  const chosen = m.caps.find((c) => c.key === scope)
  const capLine = (c: CostCapRow): string => {
    const ratio = c.cap ? Math.min(100, (c.spent / c.cap) * 100) : 0
    return '<li class="wc__caprow is-' + esc(c.state || "uncapped") + '"><span class="wc__capname">' + esc(c.label) + "</span>" +
      "<b>" + esc(STATE[c.state || "uncapped"] || c.state) + "</b>" +
      '<button type="button" class="wc__link" data-ccap="' + esc(c.key) + '">' + (c.cap ? "Change" : "Set") + "</button>" +
      '<span class="wc__capline">' + (c.cap ? '<span class="wc__bar' + (c.state === "paused" ? " is-err" : c.state === "warn" ? " is-warn" : "") + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(ratio) + '" aria-label="' + esc(c.label + ": month spend against its cap") + '"><i style="width:' + ratio.toFixed(1) + '%"></i></span>' : "") +
      "<small>" + usd(c.spent) + (c.cap ? " of " + usd(c.cap) : "") + " this month" + (c.unpriced ? " · " + c.unpriced + " not priced" : "") + "</small></span></li>"
  }
  const capList = m.caps.filter((c) => c.key === "fleet" || (c.key.indexOf("project:") === 0 && (c.cap || c.spent)))
  const caps = '<section class="wc__caps" aria-labelledby="wcost-caps-h"><h3 id="wcost-caps-h">Monthly caps' + (m.month && m.month.label ? ' <small class="k">' + esc(m.month.label) + " (UTC)</small>" : "") + "</h3>" +
    (m.caps.length
      ? '<ul class="wc__caplist">' + capList.map(capLine).join("") + "</ul>" +
        '<div class="wc__capform"><label for="wcost-cap-scope">Cap for</label><select id="wcost-cap-scope">' +
          m.caps.map((c) => '<option value="' + esc(c.key) + '"' + (c.key === scope ? " selected" : "") + ">" + esc(c.key.indexOf("agent:") === 0 ? "Agent " + name(c.label) : c.label) + "</option>").join("") + "</select>" +
          '<label for="wcost-cap-usd">Dollars a month</label><input id="wcost-cap-usd" type="number" min="0" max="1000000" step="1" inputmode="decimal" placeholder="No cap" value="' + (chosen && chosen.cap ? esc(chosen.cap) : "") + '">' +
          '<button type="button" class="ax-btn" data-ccapsave>Save</button>' +
          '<p class="wc__capmsg" id="wcost-cap-msg" role="status">' + esc(u.capMsg || "") + "</p>" +
          '<p class="k wc__caphint">Empty the box to remove the cap. A cap applies at once: an agent or project paused by its cap works again when the new cap is above its spend.</p></div>'
      : '<p class="k">Caps are not available: the budgets read failed.</p>') + "</section>"

  // The full breakdown, closed by default: token mix, cache and each day.
  const grand = m.mix.input + m.mix.output + m.mix.cacheRead + m.mix.cacheCreate
  const mixMax = Math.max(1, m.mix.input, m.mix.output, m.mix.cacheRead, m.mix.cacheCreate)
  const mixRows = ([["Input", m.mix.input, 0], ["Output", m.mix.output, 1], ["Cache read", m.mix.cacheRead, 2], ["Cache write", m.mix.cacheCreate, 3]] as Array<[string, number, number]>).map(([l, v, k]) =>
    '<li><span>' + l + '</span><span class="wc__bar"><i class="wc-s' + k + '" style="width:' + ((v / mixMax) * 100).toFixed(1) + '%"></i></span><small>' + tok(v) + " · " + (grand ? Math.round((v / grand) * 100) : 0) + "%</small></li>").join("")
  // Rough cache savings: cache-read tokens priced at ~10% of the input rate (Sonnet).
  const saved = (m.mix.cacheRead * 0.9) / 1e6 * 3
  const isWeekday = (d: string): boolean => { const n = new Date(d + "T00:00:00Z").getUTCDay(); return n > 0 && n < 6 }
  const filter = u.filter === "weekdays" || u.filter === "over10" ? u.filter : "all"
  const shown = m.daily.filter((d) => filter === "weekdays" ? isWeekday(d.date) : filter === "over10" ? d.cost > 10 : true)
  const chips = '<div class="wc__chips" role="group" aria-label="Which days">' + ([["all", "All days"], ["weekdays", "Weekdays"], ["over10", "Over $10"]] as Array<[string, string]>).map(([k, l]) =>
    '<button type="button" data-cfilter="' + k + '" aria-pressed="' + (filter === k ? "true" : "false") + '" class="' + (filter === k ? "is-on" : "") + '">' + l + "</button>").join("") + "</div>"
  const table = shown.length
    ? '<div class="wc__scroll"><table class="wc__table"><thead><tr><th scope="col">Day</th><th scope="col" class="num">Runs</th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num">Cache read</th><th scope="col" class="num">Cache write</th><th scope="col" class="num">Cost</th><th scope="col">Top agents</th></tr></thead><tbody>' +
      shown.map((d) => "<tr><td>" + esc(d.date) + '</td><td class="num">' + d.tasks + '</td><td class="num">' + tok(d.input) + '</td><td class="num">' + tok(d.output) + '</td><td class="num">' + tok(d.cacheRead) + '</td><td class="num">' + tok(d.cacheCreate) + '</td><td class="num"><b>' + usd(d.cost) + "</b></td><td>" + esc(d.top.map(name).join(", ")) + "</td></tr>").join("") +
      "</tbody></table></div>"
    : '<p class="k">No days match this filter.</p>'
  const more = '<section class="wc__more"><button type="button" class="wc__toggle" data-cmore aria-expanded="' + (u.more ? "true" : "false") + '" aria-controls="wcost-more">' + (u.more ? "▾" : "▸") + " Token mix and daily detail</button>" +
    (u.more
      ? '<div id="wcost-more"><div class="wc__mixgrid"><div><h3>Token mix ' + over + '</h3><ul class="wc__mix">' + mixRows + "</ul></div>" +
          "<div><h3>Cache</h3><p>" + (m.cacheHit == null ? '<span class="k">No input tokens in this range.</span>' : "<b>" + Math.round(m.cacheHit * 100) + "%</b> hit rate") + "</p>" +
          "<p>" + tok(m.mix.cacheRead) + " read · " + tok(m.mix.cacheCreate) + " written" + (m.mix.cacheCreate ? " · each written token read " + (m.mix.cacheRead / m.mix.cacheCreate).toFixed(1) + "×" : "") + "</p>" +
          '<p>About <b>' + usd(saved) + '</b> saved by the cache <span class="k">(an estimate at Sonnet input prices)</span></p></div></div>' +
          '<h3>Each day</h3>' + chips + table + "</div>"
      : '<div id="wcost-more" hidden></div>') + "</section>"

  return '<div class="wc">' + head + tabs + sum + chart + '<div class="wc__grid"><div>' + rows + caps + more + "</div>" + rail + "</div></div>"
}
