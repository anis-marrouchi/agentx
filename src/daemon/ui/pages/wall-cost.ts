// --- The Cost page in the Wall space (#1423) ---
//
// Global spend and each agent's spend, in the Wall's look. No new cost
// logic: it reads GET /api/admin/observability/cost (the usage_daily sums the
// classic /admin/cost page draws) and /api/admin/observability/budgets (the
// month's spend, caps and unpriced runs the profile line already shows).
//
// The page fetches the cost for twice the range picked (at least 30 days),
// so the same reply gives the range, the period before it for the change,
// and the 30-day sparkline. The range keeps the API's own cut-off, the
// days on or after today - N (UTC), so its total matches /admin/cost?range=N.
//
// Shipped to the browser through injectFns, so each function is
// self-contained. Read-only (#1180 rule 4): caps and CSV stay on /admin/cost.

export const COST_RANGES = [7, 30, 90] as const

interface CostAgentDay { tasks?: number; cost?: number; input?: number; cacheRead?: number }
interface CostReply {
  generatedAt?: string
  kpis?: { spendToday?: number; spend7d?: number; spendDeltaWoW?: number }
  days?: Array<{ date: string; cost?: number; tasks?: number; input?: number; cacheRead?: number; agents?: Record<string, CostAgentDay> }>
}
interface BudgetRowLike { agentId?: string; spentUsd?: number; capUsd?: number; state?: string; unpricedRuns?: number }
interface BudgetsReply { month?: string; agents?: BudgetRowLike[]; fleet?: BudgetRowLike }

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

export interface CostPageModel {
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
}

/** The page's numbers from the two replies. `budgets` may be null (read failed). */
export function costPageModel(cost: CostReply, budgets: BudgetsReply | null, range: number, todayIso?: string): CostPageModel {
  const today = (todayIso || cost.generatedAt || new Date().toISOString()).slice(0, 10)
  const back = (n: number): string => new Date(Date.parse(today + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10)
  const cut = back(range), prevCut = back(2 * range), weekCut = back(7), week2Cut = back(14)
  const days = (cost.days || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const byDate: Record<string, NonNullable<CostReply["days"]>[number]> = {}
  for (const d of days) byDate[d.date] = d

  const acc: Record<string, { spend: number; runs: number; prev: number; week: number; before: number }> = {}
  const at = (id: string) => acc[id] || (acc[id] = { spend: 0, runs: 0, prev: 0, week: 0, before: 0 })
  let total = 0, runs = 0, input = 0, cacheRead = 0
  for (const d of days) {
    const cur = d.date >= cut, prev = !cur && d.date >= prevCut
    if (cur) { total += d.cost || 0; runs += d.tasks || 0; input += d.input || 0; cacheRead += d.cacheRead || 0 }
    for (const [id, a] of Object.entries(d.agents || {})) {
      const r = at(id)
      if (cur) { r.spend += a.cost || 0; r.runs += a.tasks || 0 }
      if (prev) r.prev += a.cost || 0
      if (d.date >= weekCut) r.week += a.cost || 0
      else if (d.date >= week2Cut) r.before += a.cost || 0
    }
  }

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
  for (let n = range; n >= 0; n--) dates.push(back(n))
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

  const f = budgets?.fleet
  return {
    range, today, total, runs, cacheHit: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
    dates, top, stacks, spark30, agents, movers,
    ...(f ? { month: { spent: f.spentUsd || 0, ...(f.capUsd ? { cap: f.capUsd } : {}), state: f.state, label: budgets?.month } } : {}),
    ...(cost.kpis ? { spendToday: cost.kpis.spendToday || 0, spend7d: cost.kpis.spend7d || 0, wow: cost.kpis.spendDeltaWoW || 0 } : {}),
    unpriced: (f && f.unpricedRuns) || 0,
  }
}

/**
 * The page's markup. `names` maps agent ids to display names; `avatarOf`
 * draws an agent's avatar (the Wall passes its own). Rows carry
 * data-cagent, which opens the agent's Wall profile.
 */
export function costPageHtml(m: CostPageModel, names: Record<string, string>, avatarOf?: (id: string) => string): string {
  const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  // fmtCost on /cost (src/daemon/ui/pages/cost.ts), kept the same so figures match.
  const usd = (v: number): string => {
    let n = Number(v)
    if (!isFinite(n)) n = 0
    if (Math.abs(n) >= 10000) return "$" + (n / 1000).toFixed(1) + "K"
    if (n === 0) return "$0"
    if (Math.abs(n) < 0.01) return "$" + n.toFixed(4)
    return "$" + n.toFixed(2)
  }
  const pct = (x: number): string => (x > 0 ? "▲ " : x < 0 ? "▼ " : "") + Math.abs(Math.round(x * 100)) + "%"
  const name = (id: string): string => names[id] || id
  const spark = (vals: number[], cls: string, label: string): string => {
    const max = Math.max(0, ...vals)
    const pts = vals.map((v, i) => (vals.length > 1 ? (i / (vals.length - 1)) * 100 : 50).toFixed(1) + "," + (max ? 28 - (v / max) * 26 : 28).toFixed(1)).join(" ")
    return '<svg class="' + cls + '" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '"><polyline points="' + pts + '"/></svg>'
  }

  const head = '<header class="wc__head"><div class="wc__big">' +
    (m.month ? "<b>" + usd(m.month.spent) + "</b> this month" + (m.month.cap ? " of " + usd(m.month.cap) : "") +
      (m.month.state === "paused" ? ' <span class="chip chip--err">fleet cap reached</span>' : m.month.state === "warn" ? ' <span class="chip chip--warn">near cap</span>' : "")
      : '<span class="k">This month\'s total is not available: the budgets read failed.</span>') + "</div>" +
    '<div class="wc__kpis">' +
      (m.spendToday != null ? "<span>Today <b>" + usd(m.spendToday) + "</b></span>" : "") +
      (m.spend7d != null ? "<span>7 days <b>" + usd(m.spend7d) + "</b>" + (m.wow ? ' <i class="' + (m.wow > 0 ? "up" : "down") + '">' + pct(m.wow) + " vs the week before</i>" : "") + "</span>" : "") +
    "</div>" + spark(m.spark30, "wc__spark30", "Spend per day, last 30 days") + "</header>"

  const tabs = '<div class="ax-wall__views wc__tabs" role="tablist" aria-label="Range">' + [7, 30, 90].map((n) =>
    '<button type="button" role="tab" data-crange="' + n + '" class="' + (m.range === n ? "is-on" : "") + '" aria-selected="' + (m.range === n ? "true" : "false") + '">' + n + " days</button>").join("") + "</div>"

  const unpricedNote = m.unpriced
    ? '<p class="wc__warn" role="note">' + m.unpriced + " run" + (m.unpriced === 1 ? "" : "s") + " this month had no price (a model with no rate, such as a local one). They are not in these totals.</p>"
    : ""
  const sum = '<p class="ax-wall__count">' + usd(m.total) + " over " + m.range + " days · " + m.runs + " run" + (m.runs === 1 ? "" : "s") +
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
  const chart = '<figure class="wc__chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Spend per day by agent, last ' + m.range + ' days">' + bars + "</svg>" +
    '<figcaption><span class="k">' + esc(m.dates[0]) + " – " + esc(m.today) + " · peak " + usd(max) + "</span>" + legend + "</figcaption></figure>" +
    spark(m.stacks.map((s) => s.reduce((a, b) => a + b, 0)), "wc__phone", "Spend per day, last " + m.range + " days")

  const rows = m.agents.length ? '<ol class="wc__rows">' + m.agents.map((a) => {
    const bar = a.cap
      ? '<span class="wc__bar' + (a.state === "paused" ? " is-err" : a.state === "warn" ? " is-warn" : "") + '" title="' + esc("Month: " + usd(a.monthSpent || 0) + " of " + usd(a.cap)) + '"><i style="width:' + Math.min(100, ((a.monthSpent || 0) / a.cap) * 100).toFixed(1) + '%"></i></span><small>' + usd(a.monthSpent || 0) + " of " + usd(a.cap) + " this month</small>"
      : "<small>no cap</small>"
    return '<li class="wc__row"><button type="button" class="wc__who" data-cagent="' + esc(a.id) + '" title="' + esc(name(a.id)) + ': profile and posts">' +
        (avatarOf ? avatarOf(a.id) : "") + "<span><b>" + esc(name(a.id)) + "</b><small>@" + esc(a.id) + "</small></span></button>" +
      '<span class="wc__amt"><b>' + usd(a.spend) + "</b>" +
        (a.change == null ? (a.spend ? '<i class="new">new</i>' : "") : '<i class="' + (a.change > 0 ? "up" : a.change < 0 ? "down" : "") + '">' + pct(a.change) + "</i>") + "</span>" +
      '<span class="wc__cap">' + bar + "</span>" +
      '<span class="wc__runs">' + a.runs + " run" + (a.runs === 1 ? "" : "s") + (a.perRun != null ? " · " + usd(a.perRun) + " per run" : "") +
        (a.unpriced ? ' · <b class="wc__np">' + a.unpriced + " not priced this month</b>" : "") + "</span></li>"
  }).join("") + "</ol>" : '<p class="ax-wall__empty">No spend in the last ' + m.range + " days.</p>"

  const rail = '<aside class="wc__rail" aria-label="Cost notes">' +
    "<h3>Biggest movers this week</h3>" + (m.movers.length ? "<ul>" + m.movers.map((x) =>
      "<li><span>" + esc(name(x.id)) + "</span><b>" + usd(x.week) + "</b><small>" + (x.before ? pct((x.week - x.before) / x.before) : "new") + " vs " + usd(x.before) + "</small></li>").join("") + "</ul>"
      : '<p class="k">No change against the week before.</p>') +
    "<h3>Cache</h3><p>" + (m.cacheHit == null ? '<span class="k">No input tokens in this range.</span>' : "<b>" + Math.round(m.cacheHit * 100) + "%</b> of input read from the cache over " + m.range + " days") + "</p>" +
    "<h3>Runs without a cost</h3><p>" + (m.unpriced ? '<b class="wc__np">' + m.unpriced + "</b> this month, not in the totals" : "None this month") + "</p>" +
    '<p class="k">Caps, CSV export and the full breakdown: <a href="/admin/cost">classic Cost page</a>.</p></aside>'

  return '<div class="wc">' + head + tabs + sum + chart + '<div class="wc__grid">' + rows + rail + "</div></div>"
}
