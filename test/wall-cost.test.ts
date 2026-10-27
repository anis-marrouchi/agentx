import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { buildCost } from "../src/daemon/observability-panel"
import { handleBoardRequest, WALL_COST_HREF, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { costPageHtml, costPageModel } from "../src/daemon/ui/pages/wall-cost"
import { renderWallPage, WALL_CLASSIC_LINKS } from "../src/daemon/ui/pages/wall"
import { WALL_COST_CSS } from "../src/daemon/ui/pages/wall-cost.client"

// The Cost page in the Wall space (#1423): its numbers come from the
// /api/admin/observability/cost reply. Since #1449 it is the only Cost page:
// caps and the CSV export are on it, and /admin/cost redirects to it.

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
  agentIds: ["coder", "cx", "pm"],
  projects: [{ name: "Shop", spentUsd: 40, capUsd: 50, state: "warn" }, { name: "Idle", spentUsd: 0, state: "uncapped" }],
  agents: [
    { agentId: "coder", spentUsd: 12.5, capUsd: 100, state: "ok" },
    { agentId: "pm", spentUsd: 85, capUsd: 100, state: "warn", unpricedRuns: 2 },
    { agentId: "local", spentUsd: 0, state: "uncapped", unpricedRuns: 4 },
  ],
  fleet: { spentUsd: 97.5, capUsd: 500, state: "ok", unpricedRuns: 6 },
}

describe("Wall Cost page numbers (#1423)", () => {
  it("matches the API's totals for the same range, from the doubled read", () => {
    for (const range of [7, 14, 30, 90]) {
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
    // Priced agents in the same order as the API's own per-agent list.
    expect(m.agents.filter((r) => r.spend > 0).map((r) => r.id)).toEqual(buildCost(db!, 30).perAgent.map((a) => a.agent_id))
  })

  it("counts unpriced runs and lists an agent that has only those", () => {
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    expect(m.unpriced).toBe(6)
    const local = m.agents.find((r) => r.id === "local")!
    // The fixture's cost rows are all priced, so the month's count comes from the budgets.
    expect(local).toMatchObject({ spend: 0, unpriced: 0, unpricedMonth: 4 })
    const html = costPageHtml(m, { coder: "Coder" })
    expect(html).toContain("6 runs this month had no price")
    expect(html).toContain("4 not priced this month")
    expect(html).toContain("2 not priced this month")
  })

  it("counts runs on a model with no price in the range, per agent, from the API", () => {
    const ins = db!.prepare(`INSERT INTO usage_daily (agent_id, model, day, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tasks) VALUES (?, 'llama-3-8b', ?, 5000, 500, 0, 0, ?)`)
    for (const n of [0, 2, 40]) ins.run("local", day(n), 4)
    const api = buildCost(db!, 7)
    expect(api.kpis.unpricedRange).toBe(8)
    const m = costPageModel(buildCost(db!, 14), BUDGETS, 7)
    expect(m.unpricedRange).toBe(8)
    expect(m.agents.find((r) => r.id === "local")).toMatchObject({ spend: 0, runs: 8, unpriced: 8, perRun: null })
    const html = costPageHtml(m, {})
    expect(html).toContain("8 runs in the last 7 days had no price")
    expect(html).toContain("8 not priced</b>")
    // Cost per run counts priced runs only.
    expect(html).toContain("$" + (m.total / (m.runs - 8)).toFixed(2) + " per run</p>")
    // A reply from before the count (no `unpriced` field) falls back to the month's.
    const old = { ...buildCost(db!, 14), days: buildCost(db!, 14).days.map(({ unpriced: _u, ...d }) => d) }
    expect(costPageModel(old, BUDGETS, 7).unpricedRange).toBeNull()
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
    expect(html).toContain("Biggest movers this week")
    // No classic page left to send anyone to (#1449).
    expect(html).not.toContain("/admin/cost")
    expect(html).not.toContain("classic")
  })

  it("All reads every day, with no period before it and no change chips", () => {
    const api = buildCost(db!, 0)
    const m = costPageModel(api, BUDGETS, 0)
    expect(m.range).toBe(0)
    expect(m.total).toBeCloseTo(api.kpis.spendRange, 10)
    expect(m.runs).toBe(api.kpis.tasksRange)
    // From the first recorded day (95 days ago) to today.
    expect(m.dates[0]).toBe(day(95))
    expect(m.dates.length).toBe(96)
    expect(m.agents.every((a) => a.prev === 0)).toBe(true)
    const html = costPageHtml(m, {})
    expect(html).toMatch(/data-crange="0" class="is-on" aria-selected="true">All/)
    expect(html).toContain("since the first record")
    const list = html.slice(html.indexOf('<ol class="wc__rows">'), html.indexOf("</ol>"))
    expect(list).toContain('data-cagent="coder"')
    expect(list).not.toMatch(/class="(up|down|new)"/)
  })

  it("lists every cap: the fleet, each project, each agent, with the form to set one", () => {
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    expect(m.caps.map((c) => c.key)).toEqual(["fleet", "project:Shop", "project:Idle", "agent:coder", "agent:cx", "agent:pm", "agent:local"])
    const html = costPageHtml(m, { coder: "Coder" }, undefined, { scope: "project:Shop", capMsg: "Saved: no cap." })
    // Fleet and the project with a cap or spend; the idle project only in the form.
    expect(html).toMatch(/<li class="wc__caprow is-ok"><span class="wc__capname">All agents \(fleet\)<\/span><b>On track<\/b>[\s\S]*?\$97\.50 of \$500\.00 this month · 6 not priced/)
    expect(html).toMatch(/<li class="wc__caprow is-warn"><span class="wc__capname">Project Shop<\/span><b>Near cap<\/b>[\s\S]*?\$40\.00 of \$50\.00 this month/)
    expect(html).not.toContain('<span class="wc__capname">Project Idle</span>')
    expect(html).toContain('<option value="project:Shop" selected>Project Shop</option>')
    expect(html).toContain('<option value="agent:coder">Agent Coder</option>')
    expect(html).toContain('<option value="project:Idle">Project Idle</option>')
    // The chosen scope's cap fills the box; Save posts it.
    expect(html).toContain('id="wcost-cap-usd" type="number" min="0" max="1000000" step="1" inputmode="decimal" placeholder="No cap" value="50"')
    expect(html).toContain("data-ccapsave")
    expect(html).toContain('<p class="wc__capmsg" id="wcost-cap-msg" role="status">Saved: no cap.</p>')
    // Each agent row picks that agent in the form.
    expect(html).toContain('data-ccap="agent:coder" title="Set the monthly cap of Coder">Change cap</button>')
    expect(html).toContain('data-ccap="agent:cx" title="Set the monthly cap of cx">Set a cap</button>')
  })

  it("has the CSV export and the full breakdown behind one toggle", () => {
    const m = costPageModel(buildCost(db!, 60), BUDGETS, 30)
    const closed = costPageHtml(m, {})
    expect(closed).toContain("data-ccsv")
    expect(closed).toContain('data-cmore aria-expanded="false"')
    expect(closed).not.toContain("<table")
    const open = costPageHtml(m, { coder: "Coder" }, undefined, { more: true })
    expect(open).toContain('data-cmore aria-expanded="true"')
    expect(open).toContain("Token mix over 30 days")
    expect(open).toMatch(/<li><span>Cache read<\/span>/)
    // One row per day of the range, newest first, with its top agents.
    const rows = [...open.matchAll(/<tr><td>(\d{4}-\d\d-\d\d)<\/td>/g)].map((r) => r[1])
    expect(rows).toEqual(m.daily.map((d) => d.date))
    expect(rows).toEqual([...rows].sort().reverse())
    expect(open).toContain("<td>pm, Coder, cx</td>")
    const over = costPageHtml(m, {}, undefined, { more: true, filter: "over10" })
    expect([...over.matchAll(/<tr><td>/g)].length).toBe(m.daily.filter((d) => d.cost > 10).length)
    expect(over).toContain('data-cfilter="over10" aria-pressed="true"')
  })

  it("says so when the budgets read failed, and still draws the range", () => {
    const m = costPageModel(buildCost(db!, 60), null, 30)
    const html = costPageHtml(m, {})
    expect(html).toContain("This month's total is not available")
    expect(html).toContain("over 30 days")
    expect(html).toContain("Caps are not available: the budgets read failed.")
    expect(html).not.toContain("data-ccap")
  })

  it("on a phone the stacked chart folds to a sparkline and the rail goes under the list", () => {
    const html = costPageHtml(costPageModel(buildCost(db!, 60), BUDGETS, 30), {})
    expect(html).toContain('class="wc__phone"')
    const phone = WALL_COST_CSS.slice(WALL_COST_CSS.indexOf("@media (max-width: 640px)"))
    expect(phone).toContain(".wc__chart { display: none; } .wc__phone { display: block; }")
    expect(phone).toContain(".wc__grid { grid-template-columns: minmax(0, 1fr); }")
  })
})

describe("Cost in the Wall space (#1423, #1449)", () => {
  it("is in the Wall's nav, and no longer among the classic pages", () => {
    const page = renderWallPage()
    expect(page).toContain('data-nav="cost" href="#status=open&amp;view=cost"')
    expect(page).toContain('id="wall-cost-n"')
    expect(page).toContain('<section id="wall-cost"')
    expect(WALL_CLASSIC_LINKS.map(([, href]) => href)).not.toContain("/admin/cost")
    expect(page).not.toContain("/admin/cost")
  })
})

describe("/admin/cost and /cost (#1449)", () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  })

  it("redirect to the Wall's Cost page, with or without a token", async () => {
    for (const token of [undefined, "tok-1"]) {
      const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800", ...(token ? { token } : {}) } })
      const ctx = { boards: [], sources: new Map(), token, config } as unknown as Ctx
      server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      for (const p of ["/admin/cost", "/cost"]) {
        const r = await fetch(base + p, { redirect: "manual" })
        expect(r.status, p).toBe(302)
        expect(r.headers.get("location"), p).toBe(WALL_COST_HREF)
      }
      expect(WALL_COST_HREF).toBe("/wall#status=open&view=cost")
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
  })

  it("leave the caps write behind the token gate: no token, no save", async () => {
    const config = daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" }, dashboard: { daemonUrl: "http://daemon.invalid:18800", token: "tok-1" } })
    const ctx = { boards: [], sources: new Map(), token: "tok-1", config } as unknown as Ctx
    server = createServer((req, res) => { void handleBoardRequest(req, res, ctx) })
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (headers: Record<string, string>) => fetch(base + "/api/admin/budgets", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ scope: "fleet", monthlyUsd: 5 }) })
    expect((await post({})).status).toBe(401)
    expect((await post({ Authorization: "Bearer wrong" })).status).toBe(401)
  })
})
