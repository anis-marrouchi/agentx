import { beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { buildCost, toCostCsv } from "../src/daemon/observability-panel"
import { costBudgetsHtml, costCsv, costFetchRange, costPageHtml, costPageModel, mergeBudgets, mergeCost } from "../src/daemon/ui/pages/wall-cost"
import { renderWallPage, WALL_CLASSIC_LINKS } from "../src/daemon/ui/pages/wall"
import { WALL_COST_CSS } from "../src/daemon/ui/pages/wall-cost.client"

// The Cost page in the Wall space (#1423): its numbers come from the same
// /api/admin/observability/cost reply the classic page draws.

const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

let db: ReturnType<typeof openDb>
beforeEach(() => {
  closeDb()
  db = openDb({ path: path.join(mkdtempSync(path.join(tmpdir(), "agentx-wall-cost-")), "db.sqlite") })!
  const ins = db!.prepare(
    `INSERT INTO usage_daily (agent_id, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tier2_input_tokens, tier2_output_tokens, tier2_cache_read_tokens, tier2_cache_create_tokens, tasks)
     VALUES (?, 'claude-sonnet-4-5', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
  )
  // Spend on both sides of each range edge, by three agents.
  for (const n of [0, 3, 6, 7, 8, 12, 20, 29, 30, 31, 45, 70, 95]) {
    ins.run("coder", day(n), 200_000, 40_000, 800_000, 3)
    if (n % 2 === 0) ins.run("cx", day(n), 50_000, 10_000, 0, 1)
    if (n < 10) ins.run("pm", day(n), 900_000, 90_000, 0, 2)
  }
})

const BUDGETS = {
  month: "2026-10",
  agents: [
    { agentId: "coder", spentUsd: 12.5, capUsd: 100, state: "ok" },
    { agentId: "pm", spentUsd: 85, capUsd: 100, state: "warn", unpricedRuns: 2 },
    { agentId: "local", spentUsd: 0, state: "uncapped", unpricedRuns: 4 },
  ],
  fleet: { spentUsd: 97.5, capUsd: 500, state: "ok", unpricedRuns: 6 },
}

describe("Wall Cost page numbers (#1423)", () => {
  it("matches /admin/cost for the same range, from the doubled read", () => {
    for (const range of [7, 30, 90]) {
      const api = buildCost(db!, range)
      const m = costPageModel(buildCost(db!, Math.max(2 * range, 30)), BUDGETS, range)
      expect(m.total).toBeCloseTo(api.kpis.spendRange, 10)
      expect(m.runs).toBe(api.kpis.tasksRange)
      expect(m.cacheHit).toBeCloseTo(api.kpis.cacheHitRange, 10)
      for (const a of api.perAgent) {
        const row = m.agents.find((r) => r.id === a.agent_id)!
        expect(row.spend).toBeCloseTo(a.cost, 10)
        expect(row.runs).toBe(a.tasks)
      }
      // The chart draws every day of the range and stacks to the same total.
      expect(m.dates.length).toBe(range + 1)
      expect(m.stacks.flat().reduce((s, v) => s + v, 0)).toBeCloseTo(api.kpis.spendRange, 8)
    }
  })

  it("switching range changes the totals and the change against the period before", () => {
    const reply = buildCost(db!, 180)
    const week = costPageModel(reply, BUDGETS, 7), month = costPageModel(reply, BUDGETS, 30)
    expect(month.total).toBeGreaterThan(week.total)
    const coder7 = week.agents.find((r) => r.id === "coder")!
    // coder: days 0,3,6,7 in the range, 8,12 before it.
    expect(coder7.runs).toBe(12)
    expect(coder7.change).toBeCloseTo((coder7.spend - coder7.prev) / coder7.prev, 10)
    expect(coder7.prev).toBeCloseTo(coder7.spend / 2, 10)
  })

  it("sorts agents by spend, highest first", () => {
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    const spends = m.agents.map((r) => r.spend)
    expect(spends).toEqual([...spends].sort((a, b) => b - a))
    // Priced agents in the same order as /admin/cost's leaderboard.
    expect(m.agents.filter((r) => r.spend > 0).map((r) => r.id)).toEqual(buildCost(db!, 30).perAgent.map((a) => a.agent_id))
  })

  it("counts unpriced runs and lists an agent that has only those", () => {
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    expect(m.unpriced).toBe(6)
    const local = m.agents.find((r) => r.id === "local")!
    expect(local).toMatchObject({ spend: 0, unpriced: 0, unpricedMonth: 4 })
    const html = costPageHtml(m, { coder: "Coder" })
    expect(html).toContain("6 runs this month had no price")
    expect(html).toContain("4 not priced this month")
    expect(html).toContain("2 not priced this month")
  })

  it("draws the header, tabs, chart, rows that open the profile, and the rail", () => {
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    const html = costPageHtml(m, { coder: "Coder", pm: "Planner" })
    expect(html).toContain("<b>$97.50</b> this month of $500.00")
    expect(html).toMatch(/data-crange="30" class="is-on" aria-selected="true">30 days/)
    expect(html).toContain('data-crange="7"')
    expect(html).toContain('data-crange="90"')
    expect(html).toContain('<button type="button" class="wc__who" data-cagent="coder"')
    expect(html).toContain("$85.00 of $100.00 this month")
    expect(html).toContain('class="wc__bar is-warn"')
    // Each row links to the budgets form for that agent; none when the budgets were not read.
    expect(html).toContain('data-ccap="pm" title="Set the monthly cap of Planner">Change cap</button>')
    expect(html).toContain('data-ccap="local" title="Set the monthly cap of local">Set a cap</button>')
    expect(costPageHtml(costPageModel(buildCost(db!, 60), null, 30), {})).not.toContain("data-ccap")
    expect(html).toContain("Biggest movers this week")
    // Everything the classic page did is here (#1449): CSV, budgets, details.
    expect(html).not.toContain("/admin/cost")
    expect(html).toContain("data-ccsv>Export CSV</button>")
    expect(html).toContain('href="#wall-cost-budgets"')
    expect(html).toContain("Show details: tokens, cache and every day")
    // The budgets form comes only from costBudgetsHtml.
    expect(html).not.toMatch(/<form|<input|method=/)
  })

  it("says so when the budgets read failed, and still draws the range", () => {
    const m = costPageModel(buildCost(db!, 60), null, 30)
    const html = costPageHtml(m, {})
    expect(html).toContain("This month's total is not available")
    expect(html).toContain("over 30 days")
  })

  it("on a phone the stacked chart folds to a sparkline and the rail goes under the list", () => {
    const html = costPageHtml(costPageModel(buildCost(db!, 60), BUDGETS, 30), {})
    expect(html).toContain('class="wc__phone"')
    const phone = WALL_COST_CSS.slice(WALL_COST_CSS.indexOf("@media (max-width: 640px)"))
    expect(phone).toContain(".wc__chart { display: none; } .wc__phone { display: block; }")
    expect(phone).toContain(".wc__grid { grid-template-columns: 1fr; }")
  })
})

describe("Cost in the Wall space (#1423)", () => {
  it("is in the Wall's nav, and no Wall link leads to the classic page", () => {
    const page = renderWallPage()
    expect(page).toContain('data-nav="cost" href="#status=open&amp;view=cost"')
    expect(page).toContain('id="wall-cost-n"')
    expect(page).toContain('<section id="wall-cost"')
    expect(WALL_CLASSIC_LINKS.map(([label]) => label)).not.toContain("Cost")
    expect(page).not.toContain("/admin/cost")
  })
})

describe("Everything /admin/cost did, on the Wall (#1423, #1449)", () => {
  const external = () => {
    const ins = db!.prepare(`INSERT INTO usage_daily (agent_id, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tasks) VALUES (?, 'llama-3-8b', ?, 5000, 500, 0, 0, ?)`)
    for (const n of [0, 2, 40]) ins.run("local", day(n), 4)
  }

  it("matches the API for 14 days and for every day kept", () => {
    for (const range of [14, 0]) {
      const api = buildCost(db!, range)
      const m = costPageModel(buildCost(db!, range ? 30 : 0), BUDGETS, range)
      expect(m.total, String(range)).toBeCloseTo(api.kpis.spendRange, 10)
      expect(m.runs).toBe(api.kpis.tasksRange)
      expect(m.avgDaily).toBeCloseTo(api.kpis.avgDailyRange, 10)
    }
    expect(costFetchRange(0)).toBe("all")
    expect(costFetchRange(14)).toBe("30")
    expect(costFetchRange(90)).toBe("180")
  })

  it("counts runs on a model with no price in the range, per agent, from the API", () => {
    external()
    const api = buildCost(db!, 7)
    expect(api.kpis.unpricedRange).toBe(8)
    const m = costPageModel(buildCost(db!, 30), BUDGETS, 7)
    expect(m.unpricedRange).toBe(8)
    expect(m.agents.find((r) => r.id === "local")).toMatchObject({ spend: 0, runs: 8, unpriced: 8, perRun: null })
    const html = costPageHtml(m, {})
    expect(html).toContain("8 runs in the last 7 days had no price")
    expect(html).toContain("8 not priced</b>")
  })

  it("has the classic page's details: KPIs, token mix, cache efficiency and every day", () => {
    const api = buildCost(db!, 30)
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    const t = m.tokens
    expect(t.input + t.output + t.cacheRead + t.cacheCreate).toBe(api.kpis.tokensRange)
    expect(m.daily.map((d) => d.date)).toEqual(api.days.map((d) => d.date).reverse())
    const shut = costPageHtml(m, {})
    expect(shut).toContain('aria-expanded="false" aria-controls="wc-details"')
    expect(shut).toContain('<div id="wc-details" hidden>')
    const open = costPageHtml(m, {}, undefined, { details: true, filter: "over10" })
    expect(open).toContain('<div id="wc-details">')
    for (const label of ["Daily average", "Token mix", "Cache efficiency", "Hit rate", "Cache reads", "Cache writes", "Every day"]) expect(open).toContain(label)
    // Over $10: no day here costs that much.
    expect(open).toContain("No days match this filter.")
    expect(costPageHtml(m, {}, undefined, { details: true })).toContain("<td>" + day(0) + "</td>")
  })

  it("exports the same CSV the classic page did", () => {
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    expect(costCsv(m.daily)).toBe(toCostCsv(buildCost(db!, 30).days))
  })

  it("adds every machine up, and keeps one machine's figures as its API's", () => {
    const one = buildCost(db!, 60)
    expect(mergeCost([one])).toBe(one)
    const both = costPageModel(mergeCost([one, one]), BUDGETS, 30)
    expect(both.total).toBeCloseTo(2 * buildCost(db!, 30).kpis.spendRange, 10)
    expect(both.agents.find((r) => r.id === "coder")!.runs).toBe(2 * buildCost(db!, 30).perAgent.find((a) => a.agent_id === "coder")!.tasks)
    // Today and the week's change, worked out again from the days.
    const merged = mergeCost([one, one])
    expect(merged.kpis!.spendToday).toBeCloseTo(2 * one.kpis.spendToday, 10)
    expect(merged.kpis!.spendDeltaWoW).toBeCloseTo(one.kpis.spendDeltaWoW, 10)
  })

  it("adds the month up across machines, with each agent's cap from where it runs", () => {
    const a = { ...BUDGETS, agentIds: ["coder", "pm"] }
    const b = { month: "2026-10", fleet: { spentUsd: 2.5, capUsd: 100, state: "ok" }, agents: [{ agentId: "builder", spentUsd: 2.5, capUsd: 20, state: "ok" }], agentIds: ["builder"] }
    const m = mergeBudgets([a, b])!
    expect(m.fleet).toMatchObject({ spentUsd: 100, capUsd: 600, state: "ok", unpricedRuns: 6 })
    expect(m.agents!.find((x) => x.agentId === "builder")).toMatchObject({ spentUsd: 2.5, capUsd: 20 })
    expect(mergeBudgets([a, { ...b, fleet: { spentUsd: 2.5, state: "uncapped" } }])!.fleet!.capUsd).toBeUndefined()
    expect(mergeBudgets([null, undefined])).toBeNull()
    expect(mergeBudgets([a])).toBe(a)
  })

  it("lists each cap and offers the fleet, every project and every agent to set", () => {
    const budgets = { ...BUDGETS, projects: [{ name: "shop", spentUsd: 4, capUsd: 50, state: "ok" }], agentIds: ["coder", "pm", "writer"] }
    const html = costBudgetsHtml([{ name: "node-a", peer: null, budgets }], { scope: "agent:pm" })
    expect(html).toContain("Monthly budgets")
    expect(html).toContain("<li><span>All agents</span><b>$97.50 of $500.00</b>")
    expect(html).toContain("<li><span>Project shop</span><b>$4.00 of $50.00</b>")
    expect(html).toContain('<span class="chip chip--warn">Near cap</span>')
    expect(html).toContain('<b>$4.00 of $50.00</b><small><span class="chip chip--done">On track</span>')
    expect(html).toContain('<option value="agent:pm" selected>Agent @pm</option>')
    expect(html).toContain('<option value="agent:writer">Agent @writer</option>')
    expect(html).toContain('value="100"')
    expect(html).not.toContain('id="cb-machine"')
    // Two machines: pick one; its own choices.
    const two = costBudgetsHtml([{ name: "node-a", peer: null, budgets }, { name: "node-b", peer: "http://node-b", budgets: { fleet: { spentUsd: 1, state: "uncapped" }, agents: [], agentIds: ["builder"] } }], { machine: "node-b" })
    expect(two).toContain('<option value="node-b" selected>node-b</option>')
    expect(two).toContain('<option value="agent:builder">Agent @builder</option>')
    expect(two).not.toContain('value="agent:pm"')
    expect(costBudgetsHtml([{ name: "node-a", peer: null, budgets: null }], {})).toContain("The budgets could not be read.")
  })
})
