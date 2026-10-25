import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { daemonConfigSchema } from "../src/daemon/config"
import { CronScheduler } from "../src/crons/scheduler"
import { CRON_VALUE_MAX, cronValueOf } from "../src/crons/value-line"
import { fetchDaemonAgents } from "../src/daemon/board-dashboard"
import { handleAdminApi } from "../src/daemon/admin-panel"
import { CRON_JOBS_SCRIPT, CRON_VALUE_SCRIPT, NO_VALUE_LINE } from "../src/daemon/ui/cron-value"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { renderAdminPage } from "../src/daemon/ui/pages/admin"

// Value line on a recurring job (#1183): `crons.<id>.value` says why the
// job runs and the number that proves it. Optional; a job without one says
// "no value line" on the Wall and on Settings › Schedules. Read-only.

const value = { why: "Keeps the support queue answered overnight", metric: "Tickets older than 12 h each morning: 0" }
const job = (extra: Record<string, unknown> = {}) => ({ schedule: "0 9 * * 1", agent: "ops", prompt: "Check the queue", ...extra })
const node = { id: "node-a", name: "node-a" }
const parse = (crons: Record<string, unknown>) => daemonConfigSchema.safeParse({ node, agents: {}, crons })

describe("config", () => {
  it("accepts a job with a value line and keeps it", () => {
    const r = parse({ queue: job({ value }) })
    expect(r.success).toBe(true)
    expect(r.success && r.data.crons.queue.value).toEqual(value)
  })

  it("keeps a job without one valid, as before", () => {
    const r = parse({ queue: job() })
    expect(r.success).toBe(true)
    expect(r.success && r.data.crons.queue.value).toBeUndefined()
  })

  it("rejects a value line missing its why or its number", () => {
    expect(parse({ queue: job({ value: { why: "Keeps the queue answered" } }) }).success).toBe(false)
    expect(parse({ queue: job({ value: { why: " ", metric: "0 old tickets" } }) }).success).toBe(false)
    expect(parse({ queue: job({ value: { why: "x".repeat(CRON_VALUE_MAX + 1), metric: "0" } }) }).success).toBe(false)
  })
})

describe("GET /crons (scheduler list)", () => {
  it("carries the value line, and nothing for a job without one", () => {
    const cfg = daemonConfigSchema.parse({ node, agents: {}, crons: { queue: job({ value }), plain: job() } })
    const s = new CronScheduler(cfg, { execute: async () => ({}) } as any, undefined, () => {})
    const byId = Object.fromEntries(s.list().map((j) => [j.id, j]))
    expect(byId.queue.value).toEqual(value)
    expect(byId.plain.value).toBeUndefined()
  })
})

describe("cronValueOf", () => {
  it("keeps both parts trimmed and capped, and drops anything else", () => {
    expect(cronValueOf({ why: "  a ", metric: " b " })).toEqual({ why: "a", metric: "b" })
    expect(cronValueOf({ why: "x".repeat(500), metric: "1" })!.why).toHaveLength(CRON_VALUE_MAX)
    expect(cronValueOf({ why: "a" })).toBeUndefined()
    expect(cronValueOf({ why: "a", metric: 3 })).toBeUndefined()
    expect(cronValueOf("a")).toBeUndefined()
    expect(cronValueOf(undefined)).toBeUndefined()
  })
})

describe("fleet snapshot (the Wall's Recurring jobs)", () => {
  let server: Server
  let url: string
  let crons: unknown[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = req.url === "/agents" ? [] : req.url === "/crons" ? crons : null
      if (!body) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body))
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it("reads each job's value line from the node, and none for a job without one", async () => {
    crons = [
      { id: "queue", enabled: true, schedule: "0 9 * * 1", agent: "ops", value },
      { id: "plain", enabled: true, schedule: "0 9 * * 1", agent: "ops" },
      { id: "odd", enabled: false, schedule: "0 9 * * 1", agent: "ops", value: { why: 1 } },
    ]
    const node = await fetchDaemonAgents(url)
    const byId = Object.fromEntries((node.crons ?? []).map((j) => [j.id, j]))
    expect(byId.queue.value).toEqual(value)
    expect(byId.plain.value).toBeUndefined()
    expect(byId.odd.value).toBeUndefined()
  })
})

describe("Settings › Schedules (admin state)", () => {
  const prev = process.cwd()
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-cron-value-"))
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ agents: {}, crons: { queue: job({ value }), plain: job() } }))
    process.chdir(dir)
  })
  afterEach(() => { process.chdir(prev); rmSync(dir, { recursive: true, force: true }) })

  it("lists each schedule with its value line, or none", async () => {
    let body = ""
    const res = { writeHead: () => res, end: (b: string) => { body = b } } as unknown as ServerResponse
    await handleAdminApi({ method: "GET" } as IncomingMessage, res, "/api/admin/state")
    const byId = Object.fromEntries(JSON.parse(body).crons.map((c: any) => [c.id, c]))
    expect(byId.queue.value).toEqual(value)
    expect(byId.plain.value).toBeUndefined()
  })
})

describe("the value line on the page", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  const html = new Function(CRON_VALUE_SCRIPT + "\nreturn axCronValueHtml;")() as (v: unknown, e: typeof esc) => string

  it("shows why the job runs and the number that proves it, escaped", () => {
    const out = html({ why: "Keeps <b>it</b> answered", metric: "0 old tickets" }, esc)
    expect(out).toContain("Keeps &lt;b>it&lt;/b> answered")
    expect(out).toContain("0 old tickets")
    expect(out).not.toContain(NO_VALUE_LINE)
  })

  it("says no value line for a job without one, so the gap is visible", () => {
    expect(html(undefined, esc)).toContain(NO_VALUE_LINE)
    expect(html({ why: "a" }, esc)).toContain(NO_VALUE_LINE)
  })

  it("lists every node's jobs on the Wall, with and without a value line", () => {
    const jobs = new Function(CRON_VALUE_SCRIPT + CRON_JOBS_SCRIPT + "\nreturn axCronJobsHtml;")() as (n: unknown, e: typeof esc) => string
    const out = jobs([{ name: "studio", crons: [{ id: "queue", schedule: "0 9 * * 1", agent: "ops", enabled: true, value }, { id: "plain", schedule: "0 * * * *", agent: "ops", enabled: false }] }], esc)
    expect(out).toContain("queue</b> on studio")
    expect(out).toContain(value.metric)
    expect(out).toContain("plain</b> on studio")
    expect(out.match(new RegExp(NO_VALUE_LINE, "g"))).toHaveLength(1)
    expect(jobs([{ name: "studio", crons: [] }], esc)).toContain("No recurring jobs.")
    expect(jobs(undefined, esc)).toContain("Loading")
  })

  it("is on the Wall's Recurring jobs view and on Settings › Schedules", () => {
    const wall = renderWallPage()
    expect(wall).toContain('data-nav="jobs"')
    expect(wall).toContain('id="wall-jobs"')
    expect(wall).toContain("function axCronValueHtml")
    const admin = renderAdminPage()
    expect(admin).toContain("function axCronValueHtml")
    expect(admin).toMatch(/axCronValueHtml\(c\.value/)
  })
})
