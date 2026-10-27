import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { buildCost } from "../src/daemon/observability-panel"
import { wallCostModel, wallMonthSpend, costUsd, costShort, costFetchRange } from "../src/daemon/ui/pages/wall-cost"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"
import { injectFns } from "../src/daemon/ui/inject"

// The Wall's Cost page (#1423): global spend and each agent's, from the
// same /api/admin/observability/cost and /budgets replies /admin/cost reads.

const DAY = 864e5
const day = (back: number) => new Date(Date.now() - back * DAY).toISOString().slice(0, 10)

/** A usage_daily table, as src/storage/sqlite.ts makes it, with some days of spend. */
function seed(rows: Array<[agent: string, model: string, back: number, input: number, output: number, tasks: number, cacheRead?: number]>) {
  const db = new Database(":memory:")
  db.exec(`CREATE TABLE usage_daily (
    agent_id TEXT NOT NULL, model TEXT NOT NULL, day TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_create_tokens INTEGER DEFAULT 0,
    tasks INTEGER DEFAULT 0,
    tier2_input_tokens INTEGER DEFAULT 0, tier2_output_tokens INTEGER DEFAULT 0, tier2_cache_read_tokens INTEGER DEFAULT 0, tier2_cache_create_tokens INTEGER DEFAULT 0,
    PRIMARY KEY (agent_id, model, day))`)
  const put = db.prepare("INSERT INTO usage_daily (agent_id, model, day, input_tokens, output_tokens, cache_read_tokens, tasks) VALUES (?, ?, ?, ?, ?, ?, ?)")
  for (const [a, m, back, i, o, t, cr] of rows) put.run(a, m, day(back), i, o, cr ?? 0, t)
  return db
}

// Spend on most days of the last 120, so every range and its previous period have some.
const ROWS: Parameters<typeof seed>[0] = []
for (let back = 0; back < 120; back++) {
  ROWS.push(["coder", "claude-opus-4", back, 200_000 + back * 1000, 20_000, 3, 500_000])
  if (back % 2 === 0) ROWS.push(["writer", "claude-sonnet-4", back, 400_000, 50_000, 2])
  if (back % 5 === 0) ROWS.push(["local-bot", "llama-3-8b", back, 90_000, 9_000, 4])
  if (back < 4) ROWS.push(["reviewer", "claude-haiku-4", back, 1_000_000, 100_000, 1])
}

describe("the cost API counts runs with no price (#1423)", () => {
  it("adds unpriced runs per day, per agent and over the range; priced runs add none", () => {
    const data = buildCost(seed(ROWS), 7)
    // local-bot ran on days 0 and 5 of the last 7, 4 runs each, on a model with no price.
    expect(data.kpis.unpricedRange).toBe(8)
    const bot = data.perAgent.find((a) => a.agent_id === "local-bot")!
    expect(bot.unpriced).toBe(8)
    expect(bot.cost).toBe(0)
    expect(data.perAgent.find((a) => a.agent_id === "coder")!.unpriced).toBe(0)
    expect(data.days.find((d) => d.date === day(0))!.unpriced).toBe(4)
  })
})

describe("wallCostModel", () => {
  const db = seed(ROWS)
  const reply = (range: number) => [{ name: "node-a", cost: buildCost(db, costFetchRange(range)) }]

  it.each([7, 30, 90])("matches /admin/cost's total, runs and agents for %i days", (range) => {
    const api = buildCost(db, range)
    const m = wallCostModel(reply(range), range)
    expect(m.total).toBeCloseTo(api.kpis.spendRange, 9)
    expect(m.runs).toBe(api.kpis.tasksRange)
    expect(m.unpriced).toBe(api.kpis.unpricedRange)
    expect(m.days).toHaveLength(range + 1)
    expect(m.days.reduce((s, d) => s + d.total, 0)).toBeCloseTo(api.kpis.spendRange, 9)
    for (const a of api.perAgent) {
      const row = m.agents.find((r) => r.id === a.agent_id)!
      expect(row.cost).toBeCloseTo(a.cost, 9)
      expect(row.runs).toBe(a.tasks)
    }
    // Today and the week's change are the API's own KPIs. Its week reads
    // two weeks of rows, so take it from a range that holds them.
    expect(m.spentToday).toBeCloseTo(api.kpis.spendToday, 9)
    expect(m.weekChange).toBeCloseTo(buildCost(db, 30).kpis.spendDeltaWoW, 9)
  })

  it("sorts agents by spend, most first, and stacks the top five", () => {
    const m = wallCostModel(reply(30), 30)
    const costs = m.agents.map((a) => a.cost)
    expect(costs).toEqual([...costs].sort((a, b) => b - a))
    expect(m.agents[0].id).toBe("coder")
    expect(m.top).not.toContain("local-bot") // spent nothing: not a slice of the chart
    for (const d of m.days) {
      const parts = Object.values(d.parts).reduce((s, v) => s + v, 0) + d.others
      expect(parts).toBeCloseTo(d.total, 9)
    }
  })

  it("compares each agent with the period before, of the same length", () => {
    const m = wallCostModel(reply(7), 7)
    const api = buildCost(db, 15)
    // The 8 days before the range: day 8 back through day 15 back.
    const prev = api.days.filter((d) => d.date < day(7) && d.date >= day(15)).reduce((s, d) => s + (d.agents.coder?.cost ?? 0), 0)
    const coder = m.agents.find((a) => a.id === "coder")!
    expect(coder.prev).toBeCloseTo(prev, 9)
    expect(coder.change).toBeCloseTo((coder.cost - prev) / prev, 9)
    // New this period: reviewer only ran in the last four days.
    const reviewer = m.agents.find((a) => a.id === "reviewer")!
    expect(reviewer.prev).toBe(0)
    expect(reviewer.change).toBeNull()
  })

  it("counts runs with no price and leaves them out of cost per run", () => {
    const m = wallCostModel(reply(7), 7)
    const bot = m.agents.find((a) => a.id === "local-bot")!
    expect(bot).toMatchObject({ cost: 0, runs: 8, unpriced: 8, perRun: null })
    const coder = m.agents.find((a) => a.id === "coder")!
    expect(coder.perRun).toBeCloseTo(coder.cost / coder.runs, 9)
  })

  it("adds every machine up and names the one that did not answer", () => {
    const one = buildCost(db, 15)
    const m = wallCostModel([{ name: "node-a", cost: one }, { name: "node-b", cost: one }, { name: "node-c", error: "HTTP 502" }], 7)
    expect(m.total).toBeCloseTo(2 * buildCost(db, 7).kpis.spendRange, 9)
    expect(m.answered).toEqual(["node-a", "node-b"])
    expect(m.failed).toEqual([{ name: "node-c", error: "HTTP 502" }])
  })

  it("prices cache reads as /admin/cost's savings estimate", () => {
    const api = buildCost(db, 30)
    const reads = api.days.reduce((s, d) => s + d.cacheRead, 0)
    expect(wallCostModel(reply(30), 30).cacheSaved).toBeCloseTo((reads * 0.9) / 1e6 * 3, 9)
  })

  it("runs on its own once shipped to the browser", () => {
    const run = new Function(injectFns({ wallCostModel }) + "return wallCostModel(arguments[0], 7)")
    expect(run(reply(7))).toEqual(wallCostModel(reply(7), 7))
  })
})

describe("wallMonthSpend", () => {
  const fleet = (spent: number, cap?: number, unpriced?: number) => ({ spentUsd: spent, state: "ok", ...(cap ? { capUsd: cap } : {}), ...(unpriced ? { unpricedRuns: unpriced } : {}) })
  it("adds the month up and shows the budget only when every machine sets one", () => {
    const a = { fleet: fleet(40, 100, 2), agents: [{ agentId: "coder", spentUsd: 40, capUsd: 50, state: "warn" }], agentIds: ["coder"] }
    const b = { fleet: fleet(10, 50), agents: [{ agentId: "writer", spentUsd: 10, state: "uncapped" }], agentIds: ["writer"] }
    expect(wallMonthSpend([a, b])).toMatchObject({ spent: 50, cap: 150, unpriced: 2, answered: 2 })
    expect(wallMonthSpend([a, { ...b, fleet: fleet(10) }])!.cap).toBeNull()
    expect(wallMonthSpend([a, null])!.agents.coder).toEqual({ spent: 40, cap: 50, state: "warn" })
    expect(wallMonthSpend([null, { runs: [] } as never])).toBeNull()
  })
  it("formats money as /admin/cost does, and short for the nav", () => {
    expect([costUsd(0), costUsd(0.004), costUsd(12.5), costUsd(12345)]).toEqual(["$0", "$0.0040", "$12.50", "$12.3K"])
    expect([costShort(0.42), costShort(37.4), costShort(1234)]).toEqual(["$0.42", "$37", "$1.2K"])
  })
})

// --- The page itself: the Wall's real script on a stubbed DOM and fetch ---

const NOW = Date.now()
const LIVE = { nodes: [
  { name: "node-a", url: "http://node-a", reachable: true, agents: [{ id: "coder", name: "Code Helper", runningTasks: [] }, { id: "writer", name: "Writer", runningTasks: [] }] },
  { name: "node-b", url: "http://node-b", reachable: true, agents: [{ id: "local-bot", name: "Local Bot", runningTasks: [] }] },
] }
const POST = { id: "r1", owner: "coder", state: "in_progress", headline: "Post r1", group: { channel: "telegram", chatId: "demo" }, project: null,
  node: { name: "node-a", peer: null, daemonUrl: null }, createdAt: NOW - 7200e3, lastMoveAt: NOW - 600e3, closedAt: null, runs: 1, failedRuns: 0, runMs: 1, blocked: null }
const WALL = { node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [], posts: [POST] }

function openWall(opts: { hash: string; cost?: (range: string, peer: string | null) => unknown; budgets?: (peer: string | null) => unknown }) {
  const page = renderWallPage()
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c), add: (c: string) => s.add(c), remove: (c: string) => s.delete(c) } }
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(page)
      if (!tag) throw new Error(`no element #${id} on the page`)
      let html = ""
      const attrs: Record<string, string> = {}
      els.set(id, {
        id, hidden: /\shidden[\s>]/.test(tag[0]), textContent: "", value: id === "f-status" ? "open" : "", checked: false, disabled: false,
        type: /type="checkbox"/.test(tag[0]) ? "checkbox" : "select", classList: classes(), parentNode: { classList: classes() },
        get innerHTML() { return html }, set innerHTML(v: string) { html = v },
        addEventListener() {}, setAttribute: (k: string, v: string) => { attrs[k] = v }, getAttribute: (k: string) => attrs[k] ?? null,
      })
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const doc = {
    getElementById: el, hidden: false,
    querySelector: (sel: string) => (sel === ".ax-wall" ? { classList: classes() } : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
  }
  const loc = { hash: opts.hash, search: "" }
  const calls: Array<{ url: string; peer: string | null; method: string }> = []
  const fetchStub = (url: string, init: any) => {
    const peer = (init && init.headers && init.headers["X-Agentx-Peer"]) || null
    calls.push({ url, peer, method: (init && init.method) || "GET" })
    let body: unknown = { runs: [] }
    if (url.startsWith("/api/admin/wall?")) body = WALL
    else if (url === "/api/live") body = LIVE
    else if (url.startsWith("/api/admin/observability/cost?")) body = opts.cost ? opts.cost(new URLSearchParams(url.split("?")[1]).get("range")!, peer) : { days: [] }
    else if (url === "/api/admin/observability/budgets") body = opts.budgets ? opts.budgets(peer) : { runs: [] }
    if (body instanceof Error) {
      const status = (body as Error & { status?: number }).status ?? 500
      return Promise.resolve({ ok: false, status, json: async () => ({ error: body.message }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT)(
    doc, { addEventListener() {} }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0,
  )
  const click = (attrs: Record<string, string>) => {
    const t = { hasAttribute: (k: string) => k in attrs, getAttribute: (k: string) => attrs[k] }
    const ev = { preventDefault: () => {}, target: { closest: (sel: string) => Object.keys(attrs).some((k) => sel.includes(`[${k}]`)) ? t : null } }
    for (const f of onDoc.click ?? []) f(ev)
  }
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  return { el, calls, click, settle, loc }
}

describe("the Wall's Cost page (#1423)", () => {
  const db = seed(ROWS)
  // node-a keeps coder and writer; node-b, local-bot.
  const only = (ids: string[]) => (range: string) => {
    const d = buildCost(db, +range)
    return { ...d, days: d.days.map((x) => {
      const agents = Object.fromEntries(Object.entries(x.agents).filter(([id]) => ids.includes(id)))
      const vals = Object.values(agents)
      return { ...x, agents, cost: vals.reduce((s, a) => s + a.cost, 0), tasks: vals.reduce((s, a) => s + a.tasks, 0), unpriced: vals.reduce((s, a) => s + a.unpriced, 0) }
    }) }
  }
  const cost = (range: string, peer: string | null) => only(peer ? ["local-bot"] : ["coder", "writer", "reviewer"])(range)
  const budgets = (peer: string | null) => peer
    ? { fleet: { spentUsd: 0, capUsd: 500, state: "ok", unpricedRuns: 12 }, agents: [], agentIds: ["local-bot"] }
    : { fleet: { spentUsd: 812.5, capUsd: 1000, state: "warn" }, agents: [{ agentId: "coder", spentUsd: 700, capUsd: 800, state: "warn" }], agentIds: ["coder", "writer"] }

  it("is in the nav with this month's spend on every machine as its count", async () => {
    expect(renderWallPage()).toContain('data-nav="cost" href="#page=cost"')
    const w = openWall({ hash: "", budgets })
    await w.settle()
    expect(w.el("nav-n-cost").textContent).toBe("$813")
    expect(w.el("nav-n-cost").getAttribute("title")).toBe("$812.50 spent this month")
    // The classic page stays one tap away, with its CSV export.
    expect(renderWallPage()).toContain('<a href="/admin/cost">Cost</a>')
  })

  it("shows the global total, the stacked chart and one row per agent, with the API's numbers", async () => {
    const w = openWall({ hash: "#page=cost", cost, budgets })
    await w.settle()
    const html = w.el("wall-cost").innerHTML
    expect(w.el("wall-cost").hidden).toBe(false)
    expect(w.el("wall-title").textContent).toBe("Cost")
    const total = buildCost(db, 30).kpis.spendRange
    expect(html).toContain("<b>" + costUsd(total) + "</b> in the last 30 days")
    expect(html).toContain("2 machines")
    expect(html).toContain('<b class="wco__big">$812.50</b>')
    expect(html).toContain("of $1500.00 fleet budget (54%)")
    expect(html).toContain('class="wco__chart"')
    expect(html).toContain("stacked by agent")
    // Rows in spend order, each opening its agent's profile.
    const order = [...html.matchAll(/class="wco__row" data-agent="([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(["coder", "writer", "reviewer", "local-bot"])
    const coder = buildCost(db, 30).perAgent.find((a) => a.agent_id === "coder")!
    expect(html).toContain("<b>" + costUsd(coder.cost) + "</b>")
    expect(html).toContain("$700.00 of $800.00 this month · near cap")
    // Every machine is read: node-b through the peer proxy.
    expect(w.calls.filter((c) => c.url.startsWith("/api/admin/observability/cost?")).map((c) => c.peer)).toEqual([null, "http://node-b"])
    // The side rail: moves this week and the cache savings.
    expect(w.el("wall-cost-side").hidden).toBe(false)
    expect(w.el("wall-cost-rail").innerHTML).toContain("Biggest moves")
    expect(w.el("wall-cost-rail").innerHTML).toContain("Cache savings")
  })

  it("switches range with the tabs, and keeps it in the link", async () => {
    const w = openWall({ hash: "#page=cost", cost, budgets })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain('data-cost-range="30" aria-selected="true" class="is-on"')
    w.click({ "data-cost-range": "7" })
    await w.settle()
    expect(w.loc.hash).toContain("page=cost")
    expect(w.loc.hash).toContain("range=7")
    const html = w.el("wall-cost").innerHTML
    expect(html).toContain('data-cost-range="7" aria-selected="true" class="is-on"')
    expect(html).toContain("<b>" + costUsd(buildCost(db, 7).kpis.spendRange) + "</b> in the last 7 days")
    // Each range asks for itself, its period before and 30 days of sparkline.
    expect(w.calls.some((c) => c.url === "/api/admin/observability/cost?range=" + costFetchRange(7))).toBe(true)
    const deep = openWall({ hash: "#page=cost&range=90", cost, budgets })
    await deep.settle()
    expect(deep.el("wall-cost").innerHTML).toContain("in the last 90 days")
  })

  it("counts runs with no price and says so, never as a silent $0", async () => {
    const w = openWall({ hash: "#page=cost&range=7", cost, budgets })
    await w.settle()
    const html = w.el("wall-cost").innerHTML
    expect(html).toContain('id="cost-unpriced"')
    expect(html).toContain("8 runs in this range used a model with no price here")
    expect(html).toMatch(/data-agent="local-bot"[\s\S]*?8 runs[\s\S]*?8 not priced/)
    expect(html).toContain("· 12 not priced")
  })

  it("opens the agent's Wall profile from its row", async () => {
    const w = openWall({ hash: "#page=cost", cost, budgets })
    await w.settle()
    w.click({ "data-agent": "coder" })
    await w.settle()
    expect(w.el("wall-cost").hidden).toBe(true)
    expect(w.el("wall-profile").hidden).toBe(false)
    expect(w.el("wall-profile").innerHTML).toContain("@coder")
    expect(w.loc.hash).toContain("owner=coder")
  })

  it("only reads", async () => {
    const w = openWall({ hash: "#page=cost", cost, budgets })
    await w.settle()
    w.click({ "data-cost-range": "90" })
    await w.settle()
    expect(w.calls.every((c) => c.method === "GET")).toBe(true)
    expect(w.el("wall-cost").innerHTML).not.toMatch(/<form|<input|data-act=/)
  })

  it("says so when the cost cannot be read, and the rest of the Wall works", async () => {
    const w = openWall({ hash: "#page=cost", cost: () => new Error("boom"), budgets })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain("Could not read the cost: node-a: HTTP 500; node-b: HTTP 500")
    expect(w.el("wall-cost").innerHTML).toContain('href="/admin/cost"')
    // The nav still counts, and the feed still draws.
    expect(w.el("nav-n-cost").textContent).toBe("$813")
    const feed = openWall({ hash: "", cost: () => new Error("boom") })
    await feed.settle()
    expect(feed.el("wall-feed").innerHTML).toContain('data-post="r1"')
  })

  it("names a machine that does not answer and adds up the rest", async () => {
    const w = openWall({ hash: "#page=cost", cost: (r, peer) => (peer ? new Error("down") : cost(r, null)), budgets })
    await w.settle()
    const html = w.el("wall-cost").innerHTML
    expect(html).toContain("Not read: node-b (HTTP 500). Its spend is not in these numbers.")
    expect(html).toContain("1 machine</p>")
  })

  it("says when a machine is not one this dashboard can read", async () => {
    const w = openWall({ hash: "#page=cost", cost: (r, peer) => (peer ? Object.assign(new Error("unknown"), { status: 404 }) : cost(r, null)), budgets })
    await w.settle()
    expect(w.el("wall-cost").innerHTML).toContain("Not read: node-b (not in dashboard.daemons)")
  })

  it("on a phone: header, tabs, then the list; the chart folds into a sparkline", () => {
    const page = renderWallPage()
    const phone = page.slice(page.lastIndexOf("@media (max-width: 640px) {\n  .wco__head"))
    expect(phone).toContain(".wco__chart { display: none; }")
    expect(phone).toContain(".wco__spark--range { display: block;")
    // Cost waits under More in the phone's bottom bar, as Agents does.
    expect(page).toContain('.ax-wall__nav.is-more > [data-nav="cost"] { bottom: 114px; }')
    // Under 1180 px the side rail follows the list instead.
    expect(page).toContain(".ax-wall__aside > .ax-wall__costside { display: none; }")
  })
})
