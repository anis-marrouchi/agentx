// --- The Wall's Cost page, its numbers (#1423) ---
//
// Global spend and each agent's spend, from the replies the classic Cost
// page already reads: GET /api/admin/observability/cost (daily spend per
// agent) and GET /api/admin/observability/budgets (this month against the
// caps). One reply per machine, added up; no cost is worked out here, only
// summed, so a range shows the same dollars as /admin/cost for that range.
//
// Shipped to the browser through injectFns, so each function is
// self-contained. The page itself is drawn in wall-cost.client.ts.

/** The range tabs: days, as /admin/cost's ?range= takes them. */
export const WALL_COST_RANGES = [7, 30, 90]

/** The days the page asks for to fill a range, its previous period and a 30-day sparkline. */
export function costFetchRange(range: number): number {
  return Math.max(2 * range + 1, 30)
}

/** A cost reply's day, per agent (CostDay in src/daemon/observability-panel.ts). */
interface CostAgentDay { cost: number; tasks: number; unpriced?: number; cacheRead?: number }
interface CostDay { date: string; cost: number; tasks: number; unpriced?: number; cacheRead?: number; agents?: Record<string, CostAgentDay> }
export interface CostReply { generatedAt?: string; days?: CostDay[] }

export interface CostAgentRow {
  id: string
  cost: number
  /** Spend in the period before, of the same length. */
  prev: number
  runs: number
  unpriced: number
  /** Dollars per run that has a price; null when none has one. */
  perRun: number | null
  /** Change against the period before; null when there was no spend then. */
  change: number | null
}

export interface CostModel {
  range: number
  /** UTC day the replies were made, YYYY-MM-DD. */
  today: string
  /** Every day of the range, oldest first, with each top agent's part and the rest. */
  days: Array<{ date: string; total: number; parts: Record<string, number>; others: number }>
  /** The five agents that spent most in the range, most first. */
  top: string[]
  total: number
  prevTotal: number
  spentToday: number
  /** The last 30 days, oldest first, for the header's sparkline. */
  spark: number[]
  /** Last 7 days against the 7 before, as /admin/cost's week-over-week; null with no spend before. */
  weekChange: number | null
  runs: number
  unpriced: number
  /** Cache reads priced as /admin/cost's "Estimated savings from cache". */
  cacheSaved: number
  agents: CostAgentRow[]
  /** Biggest changes, last 7 days against the 7 before, in dollars. */
  movers: Array<{ id: string; from: number; to: number }>
  /** Machines whose cost reply was read, and the ones that failed. */
  answered: string[]
  failed: Array<{ name: string; error: string }>
}

/**
 * Add up every machine's cost reply for one range. Each reply must cover
 * costFetchRange(range) days. The range holds the days on or after
 * today − range (UTC), as the API's `day >= date('now', '-N day')` does,
 * so its total is the API's spendRange for that range.
 */
export function wallCostModel(replies: Array<{ name: string; cost?: CostReply | null; error?: string }>, range: number): CostModel {
  const DAY = 864e5
  const ok = replies.filter((r) => r.cost && !r.error)
  const at = ok.map((r) => Date.parse(r.cost!.generatedAt || "")).filter((n) => isFinite(n))
  const now = at.length ? Math.max(...at) : Date.now()
  const dayOf = (back: number): string => new Date(now - back * DAY).toISOString().slice(0, 10)
  const today = dayOf(0)
  const from = dayOf(range), prevFrom = dayOf(2 * range + 1)
  const wk = dayOf(7), wkPrev = dayOf(14)

  // One map of day → agent → figures, every machine added in.
  const byDay: Record<string, { cost: number; cacheRead: number; agents: Record<string, CostAgentDay> }> = {}
  for (const r of ok) {
    for (const d of r.cost!.days || []) {
      const t = byDay[d.date] || (byDay[d.date] = { cost: 0, cacheRead: 0, agents: {} })
      t.cost += d.cost || 0
      t.cacheRead += d.cacheRead || 0
      for (const id of Object.keys(d.agents || {})) {
        const a = d.agents![id]
        const x = t.agents[id] || (t.agents[id] = { cost: 0, tasks: 0, unpriced: 0 })
        x.cost += a.cost || 0
        x.tasks += a.tasks || 0
        x.unpriced = (x.unpriced || 0) + (a.unpriced || 0)
      }
    }
  }

  const rows: Record<string, CostAgentRow> = {}
  const week: Record<string, { from: number; to: number }> = {}
  let total = 0, prevTotal = 0, spentToday = 0, runs = 0, unpriced = 0, cacheRead = 0, wkNow = 0, wkBefore = 0
  for (const date of Object.keys(byDay)) {
    const d = byDay[date]
    const inRange = date >= from && date <= today
    const inPrev = date >= prevFrom && date < from
    if (inRange) { total += d.cost; cacheRead += d.cacheRead }
    if (inPrev) prevTotal += d.cost
    if (date === today) spentToday += d.cost
    if (date >= wk) wkNow += d.cost
    else if (date >= wkPrev) wkBefore += d.cost
    for (const id of Object.keys(d.agents)) {
      const a = d.agents[id]
      if (date >= wkPrev) {
        const w = week[id] || (week[id] = { from: 0, to: 0 })
        if (date >= wk) w.to += a.cost; else w.from += a.cost
      }
      if (!inRange && !inPrev) continue
      const row = rows[id] || (rows[id] = { id, cost: 0, prev: 0, runs: 0, unpriced: 0, perRun: null, change: null })
      if (inPrev) { row.prev += a.cost; continue }
      row.cost += a.cost
      row.runs += a.tasks
      row.unpriced += a.unpriced || 0
      runs += a.tasks
      unpriced += a.unpriced || 0
    }
  }
  const agents = Object.keys(rows).map((id) => rows[id])
    // An agent with nothing in the range is not listed, only counted before.
    .filter((r) => r.cost > 0 || r.runs > 0)
    .map((r) => {
      const priced = r.runs - r.unpriced
      return { ...r, perRun: priced > 0 ? r.cost / priced : null, change: r.prev > 0 ? (r.cost - r.prev) / r.prev : null }
    })
    .sort((a, b) => b.cost - a.cost || b.runs - a.runs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const top = agents.filter((r) => r.cost > 0).slice(0, 5).map((r) => r.id)

  const days: CostModel["days"] = []
  for (let back = range; back >= 0; back--) {
    const date = dayOf(back), d = byDay[date]
    const parts: Record<string, number> = {}
    let others = 0
    if (d) for (const id of Object.keys(d.agents)) {
      if (top.indexOf(id) >= 0) parts[id] = d.agents[id].cost
      else others += d.agents[id].cost
    }
    days.push({ date, total: d ? d.cost : 0, parts, others })
  }
  const spark: number[] = []
  for (let back = 29; back >= 0; back--) { const d = byDay[dayOf(back)]; spark.push(d ? d.cost : 0) }

  const movers = Object.keys(week).map((id) => ({ id, from: week[id].from, to: week[id].to }))
    .filter((m) => Math.abs(m.to - m.from) >= 0.005)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
    .slice(0, 3)

  return {
    range, today, days, top, total, prevTotal, spentToday, spark,
    weekChange: wkBefore > 0 ? (wkNow - wkBefore) / wkBefore : null,
    runs, unpriced,
    // As /admin/cost: cache reads priced at the 90% of Sonnet's input rate they save.
    cacheSaved: (cacheRead * 0.9) / 1e6 * 3,
    agents, movers,
    answered: ok.map((r) => r.name),
    failed: replies.filter((r) => !r.cost || r.error).map((r) => ({ name: r.name, error: r.error || "no reply" })),
  }
}

/** A budgets reply (BudgetView in src/agents/agent-budget.ts, plus agentIds). */
interface BudgetRowIn { agentId?: string; spentUsd: number; capUsd?: number; state?: string; unpricedRuns?: number }
interface BudgetsReply { fleet?: BudgetRowIn; agents?: BudgetRowIn[]; agentIds?: string[] }

export interface MonthSpend {
  spent: number
  /** The fleet budget, when every machine that answered sets one. */
  cap: number | null
  unpriced: number
  /** Each agent's month against its cap, from the machine it runs on. */
  agents: Record<string, { spent: number; cap: number | null; state: string }>
  answered: number
}

/** This month (UTC) on every machine that answered, from its budgets reply. */
export function wallMonthSpend(replies: Array<BudgetsReply | null | undefined>): MonthSpend | null {
  const ok = replies.filter((r): r is BudgetsReply => !!r && !!r.fleet && typeof r.fleet.spentUsd === "number")
  if (!ok.length) return null
  const agents: MonthSpend["agents"] = {}
  let spent = 0, cap = 0, capped = true, unpriced = 0
  for (const r of ok) {
    spent += r.fleet!.spentUsd
    if (r.fleet!.capUsd) cap += r.fleet!.capUsd; else capped = false
    unpriced += r.fleet!.unpricedRuns || 0
    for (const a of r.agents || []) {
      if (!a.agentId) continue
      const x = agents[a.agentId] || (agents[a.agentId] = { spent: 0, cap: null, state: "uncapped" })
      x.spent += a.spentUsd || 0
      // The cap is the one set where the agent runs.
      if (a.capUsd && (!r.agentIds || r.agentIds.indexOf(a.agentId) >= 0)) { x.cap = a.capUsd; x.state = a.state || "ok" }
    }
  }
  return { spent, cap: capped && cap > 0 ? cap : null, unpriced, agents, answered: ok.length }
}

/** Money as /admin/cost prints it (fmtCost in src/daemon/ui/pages/cost.ts). */
export function costUsd(v: number): string {
  let n = Number(v)
  if (!isFinite(n)) n = 0
  if (Math.abs(n) >= 10000) return "$" + (n / 1000).toFixed(1) + "K"
  if (n === 0) return "$0"
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4)
  return "$" + n.toFixed(2)
}

/** Money short enough for the nav's count: $0.42, $37, $1.2K. */
export function costShort(v: number): string {
  const n = Number(v) || 0
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K"
  if (n >= 10) return "$" + Math.round(n)
  return "$" + n.toFixed(2)
}
