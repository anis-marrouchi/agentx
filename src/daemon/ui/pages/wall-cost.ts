// --- The Cost page in the Wall space (#1423, epic #1449) ---
//
// Global spend and each agent's spend, in the Wall's look, and everything
// the classic /admin/cost page did, which now sends here: the token mix,
// cache efficiency, the daily detail table, the CSV export and the monthly
// budgets (caps), which the owner can set from the page.
//
// No new cost logic: it reads GET /api/admin/observability/cost (the
// usage_daily sums) and /api/admin/observability/budgets (the month's spend,
// caps and unpriced runs) from every machine the Wall reads, and adds them
// up (mergeCost, mergeBudgets). One machine's figures are its API's own.
//
// The page fetches the cost for twice the range picked (at least 30 days),
// so the same reply gives the range, the period before it for the change,
// and the 30-day sparkline. The range keeps the API's own cut-off, the
// days on or after today - N (UTC), so its total matches the API's
// spendRange for that range. "All" reads every day kept.
//
// Shipped to the browser through injectFns, so each function is
// self-contained. The only write, a budget, goes through POST
// /api/admin/budgets behind the dashboard token (wall-cost.client.ts).

/** Where the Cost page lives; /admin/cost and /cost send here. */
export const WALL_COST_HREF = "/wall#status=open&view=cost"

/** The range tabs, in days; 0 is every day kept ("All"), as /admin/cost had. */
export const COST_RANGES = [7, 14, 30, 90, 0] as const

interface CostAgentDay { tasks?: number; cost?: number; input?: number; output?: number; cacheRead?: number; cacheCreate?: number; unpriced?: number }
interface CostDay { date: string; cost?: number; tasks?: number; input?: number; output?: number; cacheRead?: number; cacheCreate?: number; unpriced?: number; agents?: Record<string, CostAgentDay> }
interface CostReply {
  generatedAt?: string
  kpis?: { spendToday?: number; spend7d?: number; spendDeltaWoW?: number; tasksDeltaWoW?: number }
  days?: CostDay[]
}
interface BudgetRowLike { agentId?: string; name?: string; spentUsd?: number; capUsd?: number; state?: string; unpricedRuns?: number }
interface BudgetsReply { month?: string; agents?: BudgetRowLike[]; projects?: BudgetRowLike[]; fleet?: BudgetRowLike; agentIds?: string[] }

/** The ?range= a range reads: twice it, at least 30 days; "all" for All. */
export function costFetchRange(range: number): string {
  return range > 0 ? String(Math.max(2 * range, 30)) : "all"
}

/**
 * Every machine's cost reply as one. Days and agents are summed by date;
 * today, 7 days and the week's change are worked out again from the days,
 * as the API does. A single reply is returned as it is.
 */
export function mergeCost(replies: CostReply[]): CostReply {
  if (replies.length === 1) return replies[0]
  const byDate: Record<string, CostDay> = {}
  let at = ""
  const KEYS = ["cost", "tasks", "input", "output", "cacheRead", "cacheCreate", "unpriced"] as const
  for (const r of replies) {
    if ((r.generatedAt || "") > at) at = r.generatedAt || ""
    for (const d of r.days || []) {
      const t = byDate[d.date] || (byDate[d.date] = { date: d.date, agents: {} })
      for (const k of KEYS) if (d[k] != null) t[k] = (t[k] || 0) + (d[k] as number)
      for (const [id, a] of Object.entries(d.agents || {})) {
        const x = t.agents![id] || (t.agents![id] = {})
        for (const k of KEYS) if (a[k] != null) x[k] = (x[k] || 0) + (a[k] as number)
      }
    }
  }
  const days = Object.keys(byDate).sort().map((k) => byDate[k])
  const now = at ? Date.parse(at) : Date.now()
  const dayOf = (back: number): string => new Date(now - back * 86400000).toISOString().slice(0, 10)
  const today = dayOf(0), wk = dayOf(7), wk2 = dayOf(14)
  let spendToday = 0, s7 = 0, p7 = 0, t7 = 0, tp7 = 0
  for (const d of days) {
    if (d.date === today) spendToday += d.cost || 0
    if (d.date >= wk) { s7 += d.cost || 0; t7 += d.tasks || 0 } else if (d.date >= wk2) { p7 += d.cost || 0; tp7 += d.tasks || 0 }
  }
  return {
    generatedAt: at || undefined, days,
    kpis: { spendToday, spend7d: s7, spendDeltaWoW: p7 > 0 ? (s7 - p7) / p7 : 0, tasksDeltaWoW: tp7 > 0 ? (t7 - tp7) / tp7 : 0 },
  }
}

/**
 * Every machine's budgets reply as one: the month's spend added up, the
 * fleet cap only when every machine sets one, each agent's cap from the
 * machine it runs on (the one that lists it in agentIds).
 */
export function mergeBudgets(replies: Array<BudgetsReply | null | undefined>): BudgetsReply | null {
  const ok = replies.filter((r): r is BudgetsReply => !!r && !!r.fleet && typeof r.fleet.spentUsd === "number")
  if (!ok.length) return null
  if (ok.length === 1) return ok[0]
  const RANK: Record<string, number> = { uncapped: 0, ok: 1, warn: 2, paused: 3 }
  const worse = (a?: string, b?: string): string | undefined => ((RANK[b || ""] || 0) > (RANK[a || ""] || 0) ? b : a)
  const agents: Record<string, BudgetRowLike> = {}
  const fleet: BudgetRowLike = { spentUsd: 0, state: "uncapped" }
  let cap = 0, capped = true, unpriced = 0
  for (const r of ok) {
    fleet.spentUsd! += r.fleet!.spentUsd || 0
    if (r.fleet!.capUsd) cap += r.fleet!.capUsd; else capped = false
    unpriced += r.fleet!.unpricedRuns || 0
    fleet.state = worse(fleet.state, r.fleet!.state)
    for (const a of r.agents || []) {
      if (!a.agentId) continue
      const x = agents[a.agentId] || (agents[a.agentId] = { agentId: a.agentId, spentUsd: 0, state: "uncapped" })
      x.spentUsd! += a.spentUsd || 0
      if (a.unpricedRuns) x.unpricedRuns = (x.unpricedRuns || 0) + a.unpricedRuns
      if (a.capUsd && (!r.agentIds || r.agentIds.indexOf(a.agentId) >= 0)) { x.capUsd = a.capUsd; x.state = a.state }
    }
  }
  if (capped && cap > 0) fleet.capUsd = cap
  if (unpriced) fleet.unpricedRuns = unpriced
  return { month: ok[0].month, fleet, agents: Object.keys(agents).map((k) => agents[k]) }
}

export interface CostAgentRow {
  id: string
  spend: number
  runs: number
  perRun: number | null
  prev: number
  /** Change against the period before, as a fraction; null when that period spent nothing (or for All). */
  change: number | null
  monthSpent?: number
  cap?: number
  state?: string
  /** Runs in the range on a model with no price. */
  unpriced: number
  /** The same this month, from the budgets, for a reply that does not count them. */
  unpricedMonth: number
}

export interface CostDailyRow { date: string; tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; cost: number; top: string[] }

export interface CostPageModel {
  range: number
  today: string
  total: number
  runs: number
  avgDaily: number
  tasksChange?: number
  cacheHit: number | null
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number }
  /** Cache reads priced as /admin/cost's "Estimated savings from cache". */
  cacheSaved: number
  dates: string[]
  /** Up to five agents with their own band in the chart; the rest are "others". */
  top: string[]
  /** Per date: spend of each top agent, then others. */
  stacks: number[][]
  spark30: number[]
  agents: CostAgentRow[]
  movers: Array<{ id: string; week: number; before: number }>
  daily: CostDailyRow[]
  month?: { spent: number; cap?: number; state?: string; label?: string }
  spendToday?: number
  spend7d?: number
  wow?: number
  /** Runs in the range with no price, when the cost reply counts them; else null. */
  unpricedRange: number | null
  /** Runs this month with no price, from the budgets. */
  unpriced: number
}

/** The page's numbers from the two replies. `budgets` may be null (read failed). Range 0 is All. */
export function costPageModel(cost: CostReply, budgets: BudgetsReply | null, range: number, todayIso?: string): CostPageModel {
  const today = (todayIso || cost.generatedAt || new Date().toISOString()).slice(0, 10)
  const back = (n: number): string => new Date(Date.parse(today + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10)
  const days = (cost.days || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const all = range <= 0
  const cut = all ? (days.length ? days[0].date : today) : back(range)
  const prevCut = all ? cut : back(2 * range), weekCut = back(7), week2Cut = back(14)
  const byDate: Record<string, CostDay> = {}
  for (const d of days) byDate[d.date] = d
  // A reply from before the unpriced count (#1423) has no field to read.
  const counts = days.some((d) => d.unpriced != null)

  const acc: Record<string, { spend: number; runs: number; prev: number; week: number; before: number; unpriced: number }> = {}
  const at = (id: string) => acc[id] || (acc[id] = { spend: 0, runs: 0, prev: 0, week: 0, before: 0, unpriced: 0 })
  let total = 0, runs = 0, rangeDays = 0, unpricedRange = 0
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  const daily: CostDailyRow[] = []
  for (const d of days) {
    const cur = d.date >= cut, prev = !all && !cur && d.date >= prevCut
    if (cur) {
      total += d.cost || 0; runs += d.tasks || 0; rangeDays++; unpricedRange += d.unpriced || 0
      tokens.input += d.input || 0; tokens.output += d.output || 0; tokens.cacheRead += d.cacheRead || 0; tokens.cacheCreate += d.cacheCreate || 0
      const ag = d.agents || {}
      const top = Object.keys(ag).sort((a, b) => (ag[b].cost || 0) - (ag[a].cost || 0)).slice(0, 3)
      daily.push({ date: d.date, tasks: d.tasks || 0, input: d.input || 0, output: d.output || 0, cacheRead: d.cacheRead || 0, cacheCreate: d.cacheCreate || 0, cost: d.cost || 0, top })
    }
    for (const [id, a] of Object.entries(d.agents || {})) {
      const r = at(id)
      if (cur) { r.spend += a.cost || 0; r.runs += a.tasks || 0; r.unpriced += a.unpriced || 0 }
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
      // Per priced run: runs with no price would pull it toward $0.
      id, spend: r.spend, runs: r.runs, perRun: r.runs - r.unpriced > 0 ? r.spend / (r.runs - r.unpriced) : null, prev: r.prev,
      change: r.prev > 0 ? (r.spend - r.prev) / r.prev : null,
      ...(b ? { monthSpent: b.spentUsd || 0, ...(b.capUsd ? { cap: b.capUsd } : {}), state: b.state } : {}),
      unpriced: r.unpriced,
      unpricedMonth: (b && b.unpricedRuns) || 0,
    }
  }).filter((r) => r.spend > 0 || r.runs > 0 || r.prev > 0 || r.unpriced > 0 || r.unpricedMonth > 0)
    .sort((a, b) => b.spend - a.spend || b.runs - a.runs || (a.id < b.id ? -1 : 1))

  const dates: string[] = []
  if (all) { for (let t = Date.parse(cut + "T00:00:00Z"); t <= Date.parse(today + "T00:00:00Z") && dates.length < 800; t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10)) }
  else for (let n = range; n >= 0; n--) dates.push(back(n))
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
    range, today, total, runs, avgDaily: rangeDays ? total / rangeDays : 0,
    cacheHit: tokens.input + tokens.cacheRead > 0 ? tokens.cacheRead / (tokens.input + tokens.cacheRead) : null,
    tokens, cacheSaved: (tokens.cacheRead * 0.9) / 1e6 * 3,
    dates, top, stacks, spark30, agents, movers, daily,
    ...(f ? { month: { spent: f.spentUsd || 0, ...(f.capUsd ? { cap: f.capUsd } : {}), state: f.state, label: budgets?.month } } : {}),
    ...(cost.kpis ? { spendToday: cost.kpis.spendToday || 0, spend7d: cost.kpis.spend7d || 0, wow: cost.kpis.spendDeltaWoW || 0, tasksChange: cost.kpis.tasksDeltaWoW || 0 } : {}),
    unpricedRange: counts ? unpricedRange : null,
    unpriced: (f && f.unpricedRuns) || 0,
  }
}

/** The daily rows as the classic CSV export wrote them (toCostCsv in observability-panel.ts). */
export function costCsv(daily: Array<{ date: string; tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; cost: number; top: string[] }>): string {
  const rows = daily.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => [d.date, d.tasks, d.input, d.output, d.cacheRead, d.cacheCreate, d.cost.toFixed(6), d.top[0] || ""].join(","))
  return "date,tasks,input,output,cache_read,cache_create,cost_usd,top_agent\n" + rows.join("\n") + "\n"
}

/** What the page shows besides the model: the machines, and the open parts. */
export interface CostPageView {
  /** Machines read, and the ones that were not, with why in plain words. */
  machines?: { read: string[]; missed: Array<{ name: string; why: string }> }
  /** The daily table's filter: all, weekdays, over10. */
  filter?: string
  /** The details (token mix, cache, daily table) are open. */
  details?: boolean
  /** The budgets section, from costBudgetsHtml. */
  budgetsHtml?: string
}

/**
 * The page's markup. `names` maps agent ids to display names; `avatarOf`
 * draws an agent's avatar (the Wall passes its own). Rows carry
 * data-cagent, which opens the agent's Wall profile. The budgets section
 * (costBudgetsHtml) comes in through `view`.
 */
export function costPageHtml(m: CostPageModel, names: Record<string, string>, avatarOf?: (id: string) => string, view?: CostPageView): string {
  const v = view || {}
  const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  // fmtCost on the classic page, kept the same so figures match.
  const usd = (x: number, dp?: number): string => {
    let n = Number(x)
    if (!isFinite(n)) n = 0
    if (Math.abs(n) >= 10000) return "$" + (n / 1000).toFixed(1) + "K"
    if (n === 0) return "$0"
    if (Math.abs(n) < 0.01) return "$" + n.toFixed(4)
    return "$" + n.toFixed(dp == null ? 2 : dp)
  }
  const tok = (n: number): string => !n ? "0" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n))
  const pct = (x: number): string => (x > 0 ? "▲ " : x < 0 ? "▼ " : "") + Math.abs(Math.round(x * 100)) + "%"
  const name = (id: string): string => names[id] || id
  const span = m.range > 0 ? "the last " + m.range + " days" : "every day kept"
  const spark = (vals: number[], cls: string, label: string): string => {
    const max = Math.max(0, ...vals)
    const pts = vals.map((x, i) => (vals.length > 1 ? (i / (vals.length - 1)) * 100 : 50).toFixed(1) + "," + (max ? 28 - (x / max) * 26 : 28).toFixed(1)).join(" ")
    return '<svg class="' + cls + '" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '"><polyline points="' + pts + '"/></svg>'
  }

  const head = '<header class="wc__head"><div class="wc__big">' +
    (m.month ? "<b>" + usd(m.month.spent) + "</b> this month" + (m.month.cap ? " of " + usd(m.month.cap) : "") +
      (m.month.state === "paused" ? ' <span class="chip chip--err">fleet cap reached</span>' : m.month.state === "warn" ? ' <span class="chip chip--warn">near cap</span>' : "")
      : '<span class="k">This month\'s total is not available: the budgets could not be read.</span>') + "</div>" +
    '<div class="wc__kpis">' +
      (m.spendToday != null ? "<span>Today <b>" + usd(m.spendToday) + "</b></span>" : "") +
      (m.spend7d != null ? "<span>7 days <b>" + usd(m.spend7d) + "</b>" + (m.wow ? ' <i class="' + (m.wow > 0 ? "up" : "down") + '">' + pct(m.wow) + " vs the week before</i>" : "") + "</span>" : "") +
    "</div>" + spark(m.spark30, "wc__spark30", "Spend per day, last 30 days") + "</header>"

  const tabs = '<div class="ax-wall__views wc__tabs" role="tablist" aria-label="Range">' + [7, 14, 30, 90, 0].map((n) =>
    '<button type="button" role="tab" data-crange="' + n + '" class="' + (m.range === n ? "is-on" : "") + '" aria-selected="' + (m.range === n ? "true" : "false") + '">' + (n ? n + " days" : "All") + "</button>").join("") + "</div>"

  // One reason once: "a, b (this dashboard has no address for it)".
  const whys: Record<string, string[]> = {}
  for (const x of (v.machines && v.machines.missed) || []) (whys[x.why] || (whys[x.why] = [])).push(x.name)
  const missed = v.machines && v.machines.missed.length
    ? '<p class="wc__warn" role="note">Not read: ' + esc(Object.keys(whys).map((w) => whys[w].join(", ") + " (" + w + ")").join("; ")) + ". " + (v.machines.missed.length === 1 ? "Its" : "Their") + " spend is not in these numbers.</p>"
    : ""
  const unpricedNote = m.unpricedRange
    ? '<p class="wc__warn" id="wc-unpriced" role="note">' + m.unpricedRange + " run" + (m.unpricedRange === 1 ? "" : "s") + " in " + span + " had no price (a model with no rate, such as a local one). " + (m.unpricedRange === 1 ? "It is" : "They are") + " counted in runs, not in the dollars.</p>"
    : m.unpriced
      ? '<p class="wc__warn" id="wc-unpriced" role="note">' + m.unpriced + " run" + (m.unpriced === 1 ? "" : "s") + " this month had no price (a model with no rate, such as a local one). They are not in these totals.</p>"
      : ""
  const machines = v.machines && v.machines.read.length > 1 ? " · " + v.machines.read.length + " machines" : ""
  const sum = '<p class="ax-wall__count">' + usd(m.total) + " over " + (m.range > 0 ? m.range + " days" : "every day kept") + " · " + m.runs + " run" + (m.runs === 1 ? "" : "s") +
    (m.runs ? " · " + usd(m.total / m.runs) + " per run" : "") + machines + "</p>" + missed + unpricedNote

  const max = Math.max(0, ...m.stacks.map((s) => s.reduce((a, b) => a + b, 0)))
  const w = 100 / Math.max(1, m.dates.length)
  const bars = m.stacks.map((s, i) => {
    let y = 100
    return s.map((x, k) => {
      if (!x || !max) return ""
      const h = (x / max) * 100
      y -= h
      return '<rect class="wc-s' + (k < m.top.length ? k : 5) + '" x="' + (i * w + w * 0.1).toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + (w * 0.8).toFixed(2) + '" height="' + h.toFixed(2) + '"><title>' + esc(m.dates[i] + " · " + (k < m.top.length ? name(m.top[k]) : "others") + " · " + usd(x)) + "</title></rect>"
    }).join("")
  }).join("")
  const legend = m.top.map((id, k) => '<span><i class="wc-s' + k + '"></i>' + esc(name(id)) + "</span>").join("") +
    (m.stacks.some((s) => s[s.length - 1] > 0) ? '<span><i class="wc-s5"></i>others</span>' : "")
  const chart = !max ? '<p class="ax-wall__empty">No spend in ' + span + ".</p>"
    : '<figure class="wc__chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Spend per day by agent, ' + esc(span) + '">' + bars + "</svg>" +
      '<figcaption><span class="k">' + esc(m.dates[0]) + " – " + esc(m.today) + " · peak " + usd(max) + "</span>" + legend + "</figcaption></figure>" +
      spark(m.stacks.map((s) => s.reduce((a, b) => a + b, 0)), "wc__phone", "Spend per day, " + span)

  const rows = m.agents.length ? '<ol class="wc__rows">' + m.agents.map((a) => {
    const bar = a.cap
      ? '<span class="wc__bar' + (a.state === "paused" ? " is-err" : a.state === "warn" ? " is-warn" : "") + '" title="' + esc("Month: " + usd(a.monthSpent || 0) + " of " + usd(a.cap)) + '"><i style="width:' + Math.min(100, ((a.monthSpent || 0) / a.cap) * 100).toFixed(1) + '%"></i></span><small>' + usd(a.monthSpent || 0) + " of " + usd(a.cap) + " this month</small>"
      : "<small>no cap</small>"
    const np = a.unpriced ? a.unpriced + " not priced" : a.unpricedMonth ? a.unpricedMonth + " not priced this month" : ""
    // Picks this agent in the budgets form, on the machine it runs on. Only when the budgets were read.
    const capBtn = m.month ? ' <button type="button" class="wc__link" data-ccap="' + esc(a.id) + '" title="' + esc("Set the monthly cap of " + name(a.id)) + '">' + (a.cap ? "Change cap" : "Set a cap") + "</button>" : ""
    return '<li class="wc__row"><button type="button" class="wc__who" data-cagent="' + esc(a.id) + '" title="' + esc(name(a.id)) + ': profile and posts">' +
        (avatarOf ? avatarOf(a.id) : "") + "<span><b>" + esc(name(a.id)) + "</b><small>@" + esc(a.id) + "</small></span></button>" +
      '<span class="wc__amt"><b>' + usd(a.spend) + "</b>" +
        (a.change == null ? (a.spend && m.range > 0 ? '<i class="new">new</i>' : "") : '<i class="' + (a.change > 0 ? "up" : a.change < 0 ? "down" : "") + '">' + pct(a.change) + "</i>") + "</span>" +
      '<span class="wc__cap">' + bar + capBtn + "</span>" +
      '<span class="wc__runs">' + a.runs + " run" + (a.runs === 1 ? "" : "s") + (a.perRun != null ? " · " + usd(a.perRun) + " per run" : "") +
        (np ? ' · <b class="wc__np">' + np + "</b>" : "") + "</span></li>"
  }).join("") + "</ol>" : '<p class="ax-wall__empty">No spend in ' + span + ".</p>"

  const unpricedRail = m.unpricedRange
    ? '<b class="wc__np">' + m.unpricedRange + "</b> in " + esc(span) + ", counted in runs, not in the dollars"
    : (m.unpriced ? '<b class="wc__np">' + m.unpriced + "</b> this month, not in the totals" : m.unpricedRange === 0 ? "None in " + esc(span) : "None this month")
  const rail = '<aside class="wc__rail" aria-label="Cost notes">' +
    "<h3>Biggest movers this week</h3>" + (m.movers.length ? "<ul>" + m.movers.map((x) =>
      "<li><span>" + esc(name(x.id)) + "</span><b>" + usd(x.week) + "</b><small>" + (x.before ? pct((x.week - x.before) / x.before) : "new") + " vs " + usd(x.before) + "</small></li>").join("") + "</ul>"
      : '<p class="k">No change against the week before.</p>') +
    "<h3>Cache</h3><p>" + (m.cacheHit == null ? '<span class="k">No input tokens in this range.</span>' : "<b>" + Math.round(m.cacheHit * 100) + "%</b> of input read from the cache, about <b>" + usd(m.cacheSaved) + "</b> saved") + "</p>" +
    "<h3>Runs without a cost</h3><p>" + unpricedRail + "</p>" +
    '<p class="wc__acts"><button type="button" class="ax-btn ax-btn--ghost" data-ccsv>Export CSV</button> <a href="#wall-cost-budgets" data-cbudgets>Budgets</a></p></aside>'

  // The rest of the classic page, folded: KPIs, token mix, cache, daily table.
  const t = m.tokens, tt = t.input + t.output + t.cacheRead + t.cacheCreate
  const kpi = (label: string, value: string, sub?: string): string => "<div><dt>" + label + "</dt><dd>" + value + (sub ? " <small>" + sub + "</small>" : "") + "</dd></div>"
  const mixRow = (label: string, n: number, cls: string): string =>
    '<li><span><i class="wc-m ' + cls + '"></i>' + label + "</span><b>" + tok(n) + "</b><small>" + (tt ? Math.round((n / tt) * 100) : 0) + "%</small></li>"
  const hitPct = m.cacheHit == null ? 0 : Math.round(m.cacheHit * 100)
  const health = hitPct >= 60 ? "Healthy" : hitPct >= 30 ? "Warming up" : "Cold"
  const f = v.filter || "all"
  const shown = m.daily.filter((d) => f === "weekdays" ? [0, 6].indexOf(new Date(d.date + "T00:00:00Z").getUTCDay()) < 0 : f === "over10" ? d.cost > 10 : true)
  const table = '<div class="wc__chips" role="group" aria-label="Show days">' + [["all", "All days"], ["weekdays", "Weekdays"], ["over10", "Over $10"]].map((c) =>
      '<button type="button" data-cfilter="' + c[0] + '" aria-pressed="' + (f === c[0] ? "true" : "false") + '">' + c[1] + "</button>").join("") + "</div>" +
    '<div class="wc__scroll"><table class="wl wc__daily"><thead><tr><th>Date</th><th class="num">Runs</th><th>Mix</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Cost</th><th>Top agents</th></tr></thead><tbody>' +
    (shown.length ? shown.map((d) => {
      const s = d.input + d.output + d.cacheRead + d.cacheCreate || 1
      return "<tr><td>" + esc(d.date) + '</td><td class="num">' + d.tasks + '</td><td><span class="wc__mini" aria-hidden="true">' +
        [[d.input, "in"], [d.output, "out"], [d.cacheRead, "cr"], [d.cacheCreate, "cw"]].map((x) => '<i class="wc-m ' + x[1] + '" style="flex:' + ((x[0] as number) / s).toFixed(3) + '"></i>').join("") +
        '</span></td><td class="num">' + tok(d.input) + '</td><td class="num">' + tok(d.output) + '</td><td class="num">' + tok(d.cacheRead) + '</td><td class="num">' + tok(d.cacheCreate) +
        '</td><td class="num">' + usd(d.cost) + "</td><td>" + esc(d.top.map(name).join(", ")) + "</td></tr>"
    }).join("") : '<tr><td colspan="9" class="ax-wall__empty">No days match this filter.</td></tr>') + "</tbody></table></div>"
  const details = '<section class="wc__more" aria-label="Details">' +
    '<button type="button" class="wc__toggle" data-cdetails aria-expanded="' + (v.details ? "true" : "false") + '" aria-controls="wc-details">' + (v.details ? "Hide" : "Show") + " details: tokens, cache and every day</button>" +
    '<div id="wc-details"' + (v.details ? "" : " hidden") + ">" +
      '<dl class="wc__grid4">' +
        kpi("Daily average", usd(m.avgDaily), "a day") +
        kpi("Runs", String(m.runs), m.tasksChange ? pct(m.tasksChange) + " vs the week before" : "") +
        kpi("Tokens", tok(tt)) +
        kpi("Cost per run", m.runs ? usd(m.total / m.runs, 3) : "—") +
      "</dl>" +
      '<div class="wc__pair"><div><h3>Token mix</h3><ul class="wc__mix">' +
        mixRow("Input", t.input, "in") + mixRow("Output", t.output, "out") + mixRow("Cache read", t.cacheRead, "cr") + mixRow("Cache write", t.cacheCreate, "cw") +
      '</ul></div><div><h3>Cache efficiency <span class="chip ' + (hitPct >= 60 ? "chip--done" : hitPct >= 30 ? "chip--warn" : "chip--ghost") + '">' + health + "</span></h3>" +
        '<dl class="wc__cache">' + kpi("Hit rate", hitPct + "%") + kpi("Cache reads", tok(t.cacheRead)) + kpi("Cache writes", tok(t.cacheCreate)) +
          kpi("Each write read", (t.cacheCreate ? (t.cacheRead / t.cacheCreate).toFixed(1) : "0") + "×") + kpi("Saved, about", usd(m.cacheSaved)) + "</dl></div></div>" +
      "<h3>Every day</h3>" + table +
    "</div></section>"

  return '<div class="wc">' + head + tabs + sum + chart + '<div class="wc__grid">' + rows + rail + "</div>" + details +
    '<section id="wall-cost-budgets" class="wc__budgets" aria-label="Monthly budgets">' + (v.budgetsHtml || "") + "</section></div>"
}

/** One machine's budgets, for the budgets section: its name, where to send a change, and its reply. */
export interface CostBudgetMachine { name: string; peer: string | null; budgets: BudgetsReply | null }

/**
 * The budgets section: each cap with this month's spend, and a form to set
 * or remove one (fleet, project or agent, on one machine). `form` is what
 * the owner picked and typed; `note` the last save's answer.
 */
export function costBudgetsHtml(machines: CostBudgetMachine[], form: { machine?: string; scope?: string; usd?: string; note?: string; saving?: boolean }): string {
  const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  const usd = (x: number): string => { const n = Number(x) || 0; return n === 0 ? "$0" : Math.abs(n) >= 10000 ? "$" + (n / 1000).toFixed(1) + "K" : "$" + n.toFixed(2) }
  const ok = machines.filter((x) => x.budgets && x.budgets.fleet)
  const head = '<h2 class="wc__h">Monthly budgets</h2><p class="ax-wall__count">Spend this month (UTC) against each cap. A cap pauses the agent, the project or every agent once it is reached, until the month ends or you raise it.</p>'
  if (!ok.length) return head + '<p class="ax-wall__empty">The budgets could not be read. Select Refresh to try again.</p>'
  const multi = ok.length > 1
  const line = (label: string, b: BudgetRowLike): string => {
    // One status per cap: On track, Near cap, Paused or No cap.
    const st = !b.capUsd ? '<span class="chip chip--ghost">No cap</span>'
      : b.state === "paused" ? '<span class="chip chip--err">Paused</span>'
      : b.state === "warn" ? '<span class="chip chip--warn">Near cap</span>'
      : '<span class="chip chip--done">On track</span>'
    return "<li><span>" + label + "</span><b>" + usd(b.spentUsd || 0) + (b.capUsd ? " of " + usd(b.capUsd) : "") + "</b><small>" + st + "</small></li>"
  }
  const lists = ok.map((x) => {
    const b = x.budgets!
    const items = [line("All agents", b.fleet!)]
      .concat((b.projects || []).filter((p) => p.capUsd || p.spentUsd).map((p) => line("Project " + esc(p.name), p)))
      .concat((b.agents || []).filter((a) => a.capUsd).map((a) => line("@" + esc(a.agentId), a)))
    return (multi ? "<h3>" + esc(x.name) + "</h3>" : "") + '<ul class="wc__caps">' + items.join("") + "</ul>"
  }).join("")
  // The form's choices on the machine picked: the fleet, every project, every agent.
  const m = ok.find((x) => x.name === form.machine) || ok[0]
  const b = m.budgets!
  const caps: Record<string, number | undefined> = { fleet: b.fleet!.capUsd }
  const opts = ['<option value="fleet">All agents</option>']
  for (const p of b.projects || []) { if (!p.name) continue; caps["project:" + p.name] = p.capUsd; opts.push('<option value="project:' + esc(p.name) + '">Project ' + esc(p.name) + "</option>") }
  const ids = (b.agentIds || []).slice()
  for (const a of b.agents || []) { if (!a.agentId) continue; caps["agent:" + a.agentId] = a.capUsd; if (ids.indexOf(a.agentId) < 0) ids.push(a.agentId) }
  for (const id of ids) { if (!("agent:" + id in caps)) caps["agent:" + id] = undefined; opts.push('<option value="agent:' + esc(id) + '">Agent @' + esc(id) + "</option>") }
  const scope = form.scope && Object.prototype.hasOwnProperty.call(caps, form.scope) ? form.scope : "fleet"
  const usdVal = form.usd != null ? form.usd : caps[scope] ? String(caps[scope]) : ""
  const sel = (html: string[], value: string): string => html.map((o) => o.replace('value="' + esc(value) + '"', 'value="' + esc(value) + '" selected')).join("")
  return head + lists +
    '<form class="wc__form" data-cform aria-label="Set a monthly budget">' +
      (multi ? '<label>Machine <select id="cb-machine">' + sel(ok.map((x) => '<option value="' + esc(x.name) + '">' + esc(x.name) + "</option>"), m.name) + "</select></label>" : "") +
      '<label>Budget for <select id="cb-scope">' + sel(opts, scope) + "</select></label>" +
      '<label>Dollars a month <input id="cb-usd" type="number" min="0" max="1000000" step="1" inputmode="decimal" placeholder="No cap" value="' + esc(usdVal) + '"></label>' +
      '<button type="submit" class="ax-btn"' + (form.saving ? " disabled" : "") + ">" + (form.saving ? "Saving…" : "Save") + "</button>" +
      '<span class="wdo__n" id="cb-note" role="status">' + esc(form.note || "") + "</span>" +
    '</form><p class="ax-wall__count">Leave the dollars empty to remove the cap. Only the owner can save: the dashboard checks its token.</p>'
}
