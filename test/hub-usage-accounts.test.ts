import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import { PlanUsageReader, PlanUsageRequestError } from "../src/agents/claude-plan-usage"
import { clearAccountsPlanUsage, readAccountsPlanUsage } from "../src/agents/plan-usage-accounts"
import { readCodexPlanUsage } from "../src/agents/codex-plan-usage"
import { HUB_SPEND_TTL_MS, hubSpendToday, hubUsageFromPlan, resetHubSpendCache } from "../src/daemon/hub-usage-api"
import { handlePlanUsageApi } from "../src/daemon/plan-usage-api"
import {
  hubEngineChipHtml, hubEnginePopHtml, hubEngineShort, hubEnginesInUse, hubEngineTone, hubSpendView, hubUsageRows, HUB_USAGE_CSS,
} from "../src/daemon/ui/pages/hub-status-usage"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { HUB_USAGE_SCRIPT } from "../src/daemon/ui/pages/hub-status-usage.client"

// #2101 PR D2: R28d (a bar for each added account), R28e (API engines show
// today's spend), R28h for API and local engines, R28i (an engine at or near
// its limit is marked), and the DevOps notes left on #2314.
const now = Date.UTC(2026, 10, 26, 10)
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
const icon = (k: string) => '<i data-e="' + k + '"></i>'

describe("readAccountsPlanUsage (R28d, daemon side)", () => {
  beforeEach(() => clearAccountsPlanUsage())

  const state = {
    claude: { profiles: [{ name: "work", dir: "/w/claude" }, { name: "gone", dir: "/g/claude" }], active: "work" },
    codex: { profiles: [{ name: "team", dir: "/t/codex" }], active: "default" },
  }

  it("lists every account of a provider that has added ones; the one in use carries no reading of its own", async () => {
    const envs: Array<string | undefined> = []
    const reader = (env: NodeJS.ProcessEnv) => new PlanUsageReader({
      now: () => now,
      readLogin: async () => { envs.push(env.CLAUDE_CONFIG_DIR); return { token: env.CLAUDE_CONFIG_DIR === "/g/claude" ? null : "t", source: "keychain", renewable: true } },
      fetchUsage: async () => [{ window: "five_hour", utilization: 0.3, resetsAt: now + 3600_000 }],
    })
    const codexDirs: string[] = []
    const codex = async (dir: string) => { codexDirs.push(dir); return dir === "/t/codex" ? { windows: [{ window: "five_hour", utilization: 0.5 }], readAt: now - 60_000, plan: "pro" } : null }
    const out = await readAccountsPlanUsage({ state, env: {}, home: "/home/you", now, claudeReader: reader, codex })
    expect(out.claude).toEqual([
      { name: "default", active: false, windows: [{ window: "five_hour", utilization: 0.3, resetsAt: now + 3600_000 }], readAt: now },
      { name: "work", active: true },
      { name: "gone", active: false, error: "no-login" },
    ])
    // The default account reads the CLI's own login: no CLAUDE_CONFIG_DIR set.
    expect(envs).toEqual([undefined, "/g/claude"])
    expect(out.codex).toEqual([
      { name: "default", active: true },
      { name: "team", active: false, windows: [{ window: "five_hour", utilization: 0.5 }], readAt: now - 60_000, plan: "pro" },
    ])
    expect(codexDirs).toEqual(["/t/codex"])
    // No folder leaves the daemon.
    expect(JSON.stringify(out)).not.toContain("/w/claude")
  })

  it("has nothing for a provider with no added account", async () => {
    const out = await readAccountsPlanUsage({ state: { claude: { profiles: [], active: "default" } }, env: {}, home: "/h", now, codex: async () => null })
    expect(out).toEqual({})
  })

  it("reads an added Claude account at most every 5 minutes, and waits 15 after a rate limit", async () => {
    let calls = 0
    let mode: "ok" | "limited" = "limited"
    let t = now
    const reader = () => new PlanUsageReader({
      now: () => t,
      readLogin: async () => ({ token: "t", source: "keychain", renewable: true }),
      fetchUsage: async () => { calls++; if (mode === "limited") throw new PlanUsageRequestError("rate-limited", "usage endpoint rate limited"); return [{ window: "five_hour", utilization: 0.1 }] },
    })
    const st = { claude: { profiles: [{ name: "work", dir: "/w" }], active: "work" } }
    const read = () => readAccountsPlanUsage({ state: st, env: {}, home: "/h", now: t, claudeReader: reader, codex: async () => null })
    expect((await read()).claude?.[0]).toEqual({ name: "default", active: false, error: "rate-limited" })
    t = now + 10 * 60_000
    mode = "ok"
    await read()
    expect(calls).toBe(1)
    t = now + 15 * 60_000
    expect((await read()).claude?.[0]).toEqual({ name: "default", active: false, windows: [{ window: "five_hour", utilization: 0.1 }], readAt: t })
    t += 4 * 60_000
    await read()
    expect(calls).toBe(2)
    t += 60_000
    await read()
    expect(calls).toBe(3)
  })

  it("the daemon's /usage/plan carries the accounts only when it read them", () => {
    const accounts = { claude: [{ name: "default", active: true }] }
    expect((handlePlanUsageApi("GET", "/usage/plan", now, { accounts }).body as any).accounts).toEqual(accounts)
    expect("accounts" in (handlePlanUsageApi("GET", "/usage/plan", now).body as any)).toBe(false)
  })
})

describe("hubUsageFromPlan: accounts (R28d) and the #2314 review notes", () => {
  const reading = { readAt: now - 60_000, windows: [{ window: "five_hour", utilization: 0.4, resetsAt: now + 3600_000 }] }

  it("gives each engine its accounts: the one in use with the engine's rows, the others with their own", () => {
    const u = hubUsageFromPlan({
      reader: { reading },
      codex: { readAt: now - 120_000, windows: [{ window: "five_hour", utilization: 0.2 }] },
      accounts: {
        claude: [
          { name: "default", active: true },
          { name: "work", active: false, readAt: now - 2 * 60_000, windows: [{ window: "five_hour", utilization: 0.8 }, { window: "seven_day" }] },
          { name: "old", active: false, readAt: now - 40 * 60_000, windows: [{ window: "five_hour", utilization: 0.1 }] },
          { name: "out", active: false, error: "signed-out" },
        ],
        codex: [{ name: "default", active: false, readAt: now - 3600_000, plan: "plus", windows: [{ window: "seven_day", utilization: 0.6 }] }, { name: "team", active: true }],
      },
    }, now)
    const claude = u.engines.find((e) => e.engine === "claude-code")!
    expect(claude.accounts).toEqual([
      { name: "default", active: true, rows: claude.rows, readAt: now - 60_000, source: "plan" },
      { name: "work", active: false, rows: [{ window: "five_hour", utilization: 0.8, at: now - 2 * 60_000 }], readAt: now - 2 * 60_000, source: "plan" },
      // A Claude reading older than 30 minutes counts for nothing, as for the account in use.
      { name: "old", active: false, rows: [], readAt: null, source: "plan" },
      { name: "out", active: false, rows: [], readAt: null, source: "plan", signedOut: true },
    ])
    const codex = u.engines.find((e) => e.engine === "codex-cli")!
    expect(codex.accounts).toEqual([
      { name: "default", active: false, rows: [{ window: "seven_day", utilization: 0.6, at: now - 3600_000 }], readAt: now - 3600_000, source: "session", plan: "plus" },
      { name: "team", active: true, rows: codex.rows, readAt: now - 120_000, source: "session" },
    ])
  })

  it("keeps an engine with added accounts even when the account in use has no reading", () => {
    const u = hubUsageFromPlan({ accounts: { codex: [{ name: "default", active: true }, { name: "team", active: false, readAt: now, windows: [{ window: "five_hour", utilization: 0.5 }] }] } }, now)
    expect(u.engines).toEqual([{
      engine: "codex-cli", rows: [], readAt: null, source: "session",
      accounts: [
        { name: "default", active: true, rows: [], readAt: null, source: "session" },
        { name: "team", active: false, rows: [{ window: "five_hour", utilization: 0.5, at: now }], readAt: now, source: "session" },
      ],
    }])
  })

  it("a newer 'limit reached' from a run replaces an older percentage (#2314 note 1)", () => {
    const u = hubUsageFromPlan({ reader: { reading }, provider: [{ window: "five_hour", status: "rejected", resetsAt: now + 3600_000, seenAt: now - 10_000 }] }, now)
    expect(u.engines[0].rows).toEqual([{ window: "five_hour", status: "rejected", resetsAt: now + 3600_000, at: now - 10_000 }])
    // An older "rejected" does not.
    const v = hubUsageFromPlan({ reader: { reading }, provider: [{ window: "five_hour", status: "rejected", seenAt: now - 120_000 }] }, now)
    expect(v.engines[0].rows[0].utilization).toBe(0.4)
  })

  it("a run's status with no reset time counts for 15 minutes, as the dispatch gate trusts it (#2314 note 2)", () => {
    const fresh = hubUsageFromPlan({ provider: [{ window: "five_hour", status: "rejected", seenAt: now - 14 * 60_000 }] }, now)
    expect(fresh.engines[0].rows[0].status).toBe("rejected")
    const old = hubUsageFromPlan({ provider: [{ window: "five_hour", status: "rejected", seenAt: now - 16 * 60_000 }] }, now)
    expect(old.engines).toEqual([])
    const withReset = hubUsageFromPlan({ provider: [{ window: "five_hour", status: "rejected", resetsAt: now + 60_000, seenAt: now - 60 * 60_000 }] }, now)
    expect(withReset.engines[0].rows[0].status).toBe("rejected")
  })
})

describe("readCodexPlanUsage takes the newest reading, not the first file with one (#2314 note 3)", () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "codex-d2-")) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))
  const put = (rel: string, ts: string, p: number, mtimeSec: number) => {
    const f = join(home, "sessions", rel)
    mkdirSync(join(f, ".."), { recursive: true })
    writeFileSync(f, JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: p, window_minutes: 300 } } } }) + "\n")
    utimesSync(f, mtimeSec, mtimeSec)
  }

  it("a long session filed under yesterday wins over a short one from today that ended earlier", async () => {
    put("2026/11/25/rollout-long.jsonl", "2026-11-26T09:50:00.000Z", 60, 1_000_000)
    put("2026/11/26/rollout-short.jsonl", "2026-11-26T08:00:00.000Z", 10, 900_000)
    const r = await readCodexPlanUsage(home)
    expect(r?.windows[0].utilization).toBe(0.6)
    expect(r?.readAt).toBe(Date.parse("2026-11-26T09:50:00.000Z"))
  })
})

describe("today's spend for API engines (R28e, dashboard side)", () => {
  let dir: string
  let db: Database.Database
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-d2-spend-"))
    db = openDb({ path: join(dir, "db.sqlite"), quiet: true })!
    resetHubSpendCache()
  })
  afterEach(() => {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  })
  const insert = (agent: string, startedAt: number, cost: number | null) =>
    db.prepare(`INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, cost_usd, input_tokens, output_tokens)
      VALUES (?, ?, 'a2a', 'c', 'done', ?, ?, 100, 100)`).run(`t${Math.random()}`, agent, startedAt, cost)

  it("sums each agent's recorded run cost since 00:00 UTC, counts unpriced runs, and lists this machine's agents", () => {
    const midnight = Date.UTC(2026, 10, 26)
    insert("ops", midnight + 1000, 0.25)
    insert("ops", midnight + 2000, 0.5)
    insert("ops", midnight - 1000, 9)
    insert("local", midnight + 3000, null)
    expect(hubSpendToday(db, ["ops", "local", "idle"], now)).toEqual({
      since: midnight, byAgent: { ops: 0.75 }, unpriced: { local: 1 }, agentIds: ["idle", "local", "ops"],
    })
  })

  it("keeps the sums a minute", () => {
    insert("ops", now - 1000, 1)
    expect(hubSpendToday(db, ["ops"], now).byAgent.ops).toBe(1)
    insert("ops", now - 500, 1)
    expect(hubSpendToday(db, ["ops"], now + HUB_SPEND_TTL_MS - 1).byAgent.ops).toBe(1)
    expect(hubSpendToday(db, ["ops"], now + HUB_SPEND_TTL_MS).byAgent.ops).toBe(2)
  })
})

describe("status bar: API and local engines (R28e, R28h)", () => {
  const nodes = [
    { name: "Mac", agents: [{ id: "a", name: "Alpha", tier: "claude-code" }, { id: "o", name: "Ops", tier: "orchestrator" }, { id: "l", name: "Llama", tier: "orchestrator" }, { id: "s", name: "Sdk", tier: "sdk" }] },
    { name: "box", agents: [{ id: "r", name: "Remote", tier: "sdk" }, { id: "p", name: "Pen", tier: "opencode" }] },
  ]
  const spend = { since: Date.UTC(2026, 10, 26), byAgent: { o: 1.5, a: 4 }, unpriced: { l: 3 }, agentIds: ["a", "l", "o", "s"] }

  it("lists the API engines an agent uses, after the plan engines", () => {
    const e = hubEnginesInUse(nodes)
    expect(e.map((x) => x.engine)).toEqual(["claude-code", "sdk", "orchestrator", "opencode"])
    expect(e.find((x) => x.engine === "orchestrator")?.agents.map((a) => a.id)).toEqual(["l", "o"])
    expect(hubEngineShort("sdk")).toBe("API")
    expect(hubEngineShort("orchestrator")).toBe("Orchestrator")
    expect(hubEngineShort("opencode")).toBe("OpenCode")
  })

  it("sums the spend of an engine's agents that run here; an engine with none here has no sum", () => {
    const agents = (eng: string) => hubEnginesInUse(nodes).find((x) => x.engine === eng)!.agents
    expect(hubSpendView(agents("orchestrator"), spend)).toEqual({ usd: 1.5, unpriced: 3, byAgent: { o: 1.5, l: 0 }, elsewhere: 0 })
    expect(hubSpendView(agents("sdk"), spend)).toEqual({ usd: 0, unpriced: 0, byAgent: { s: 0 }, elsewhere: 1 })
    expect(hubSpendView(agents("opencode"), spend)).toEqual({ unpriced: 0, byAgent: {}, elsewhere: 1 })
    expect(hubSpendView(agents("orchestrator"), null)).toBeNull()
  })

  it("the item shows today's spend in place of a bar; a local-only engine shows its name only", () => {
    const html = hubEngineChipHtml("orchestrator", [], esc, icon, { usd: 1.5, unpriced: 0, byAgent: {}, elsewhere: 0 })
    expect(html).toContain('<span class="hsu__n">Orchestrator</span>')
    expect(html).toContain('<b class="hsu__usd">$1.50</b><span class="hs__long"> today</span>')
    expect(html).not.toContain("progressbar")
    expect(hubEngineChipHtml("orchestrator", [], esc, icon, { usd: 0, unpriced: 2, byAgent: {}, elsewhere: 0 })).not.toContain("hsu__usd")
    expect(hubEngineChipHtml("sdk", [], esc, icon, { unpriced: 0, byAgent: {}, elsewhere: 1 })).not.toContain("hsu__usd")
    expect(hubEngineChipHtml("sdk", [], esc, icon, null)).not.toContain("hsu__usd")
  })

  it("the API drop-down says there is no plan limit, gives today's spend and each agent's, and has no Add account", () => {
    const agents = [{ id: "l", name: "Llama" }, { id: "o", name: "Ops" }, { id: "r", name: "Remote" }]
    const html = hubEnginePopHtml("orchestrator", null, [], agents, now, esc, icon, true, { usd: 1.5, unpriced: 3, byAgent: { o: 1.5, l: 0 }, elsewhere: 1 })
    expect(html).toContain("<b>Orchestrator</b>")
    expect(html).toContain('<span class="hsu__plan">No plan limit</span>')
    expect(html).toContain("Spent today <b>$1.50</b>")
    expect(html).toContain("3 runs on a model with no price, such as a local model")
    expect(html).toContain("1 agent runs on another machine; its spend is kept there")
    expect(html).toContain("Ops · $1.50</a>")
    expect(html).toContain(">Remote</a>")
    expect(html).toContain('href="#status=open&amp;view=cost"')
    expect(html).not.toContain("data-hsu-add")
    expect(html).not.toContain("progressbar")
    expect(html).not.toContain("not known")
    // Nothing read: only what is known, no sum.
    const none = hubEnginePopHtml("sdk", null, [], [{ id: "r", name: "Remote" }], now, esc, icon, true, null)
    expect(none).toContain("No plan limit")
    expect(none).not.toContain("Spent today")
    expect(none).not.toContain("$")
  })
})

describe("status bar: a section per account (R28d)", () => {
  const active = hubUsageRows([{ window: "five_hour", utilization: 0.42, at: now - 60_000 }], now)
  const use = {
    engine: "claude-code", rows: [], readAt: now - 60_000, source: "plan",
    accounts: [
      { name: "default", active: true, rows: [], readAt: now - 60_000, source: "plan" },
      { name: "work", active: false, rows: [{ window: "five_hour", utilization: 0.8, at: now - 3 * 60_000 }, { window: "seven_day", utilization: 0.5, at: now - 3 * 60_000 }], readAt: now - 3 * 60_000, source: "plan" },
      { name: "out", active: false, rows: [], readAt: null, source: "plan", signedOut: true },
    ],
  }

  it("shows each account's bars under its name, the one in use first and marked", () => {
    const html = hubEnginePopHtml("claude-code", use, active, [], now, esc, icon, true)
    const at = (s: string) => html.indexOf(s)
    expect(html).toContain('<p class="hsu__acct"><b>default</b><span class="hsu__in">In use</span></p>')
    expect(html).toContain('<p class="hsu__acct"><b>work</b></p>')
    expect(at("<b>default</b>")).toBeLessThan(at("<b>work</b>"))
    expect(html.match(/role="progressbar"/g)?.length).toBe(3)
    expect(html).toContain('aria-valuenow="80"')
    expect(html).toContain("Read 3 min ago")
    expect(html).toContain('<p class="hsu__acct"><b>out</b></p><p class="hsu__read">Signed out</p>')
    expect(html).not.toContain("not known")
  })

  it("with one account, no account headings", () => {
    const html = hubEnginePopHtml("claude-code", { ...use, accounts: undefined }, active, [], now, esc, icon, true)
    expect(html).not.toContain("hsu__acct")
  })
})

describe("status bar: an engine at or near its limit is marked (R28i)", () => {
  it("tones the item by its worst window", () => {
    expect(hubEngineTone(hubUsageRows([{ window: "five_hour", utilization: 0.2, at: now }], now))).toBe("")
    expect(hubEngineTone(hubUsageRows([{ window: "five_hour", utilization: 0.2, at: now }, { window: "seven_day", utilization: 0.75, at: now }], now))).toBe("warn")
    expect(hubEngineTone(hubUsageRows([{ window: "seven_day", utilization: 0.75, at: now }, { window: "five_hour", status: "rejected", at: now }], now))).toBe("high")
    expect(hubEngineTone([])).toBe("")
  })

  it("the item says so to a screen reader too, and the CSS marks it", () => {
    const html = hubEngineChipHtml("claude-code", hubUsageRows([{ window: "five_hour", utilization: 0.95, at: now }], now), esc, icon)
    expect(html).toContain('<span class="hsu__sr">Limit reached</span>')
    const warn = hubEngineChipHtml("claude-code", hubUsageRows([{ window: "five_hour", utilization: 0.75, at: now }], now), esc, icon)
    expect(warn).toContain('<span class="hsu__sr">Near the limit</span>')
    expect(hubEngineChipHtml("claude-code", hubUsageRows([{ window: "five_hour", utilization: 0.1, at: now }], now), esc, icon)).not.toContain("hsu__sr")
    expect(HUB_USAGE_CSS).toContain('.hsu__eng[data-tone="warn"]')
    expect(HUB_USAGE_CSS).toContain('.hsu__eng[data-tone="high"]')
  })

  it("the bar's script sets the tone on the item, skips reads while the tab is hidden (#2314 note 4) and ships the new helpers", () => {
    const page = renderWallPage({ owner: true })
    expect(page).toContain("function hubEngineTone")
    expect(page).toContain("function hubSpendView")
    expect(page).toContain("function hubRowsHtml")
    expect(HUB_USAGE_SCRIPT).toContain("' data-tone=\"' + tone")
    expect(HUB_USAGE_SCRIPT).toContain("if (document.hidden) return;")
    expect(HUB_USAGE_SCRIPT).toContain("addEventListener('visibilitychange'")
    expect(HUB_USAGE_SCRIPT).toContain("hsuSpend(e)")
  })
})
