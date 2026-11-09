import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { NumberStore } from "../src/numbers/store"
import { DAY_MS, describePeriod, lastPeriod, parsePeriod, parseTags, periodAt, statusOf, type Reading } from "../src/numbers/model"
import { parseNumberInput } from "../src/numbers/input"
import { countUrl, parseSource, readSourceValue, valueAt, type CountSource } from "../src/numbers/sources"
import { readDueNumbers, syncConfigNumbers } from "../src/numbers/sweep"
import { checkNumber } from "../src/numbers/goal-check"
import { handleNumbersApi } from "../src/numbers/daemon-api"
import { runNumbersTool } from "../src/numbers/tool"
import { GoalStore, checkGoals, describeGoalCheck, parseGoalCheck } from "../src/requests/goal-store"
import { cronValueOf } from "../src/crons/value-line"
import { daemonConfigSchema } from "../src/daemon/config"

// Numbers: tracked numbers with readings (#1826 part N1).

const day = (s: string) => Date.parse(`${s}T00:00:00Z`)
// Tuesday 2026-11-10, 09:00 UTC: the last whole week is 11-02..11-08.
const NOW = Date.parse("2026-11-10T09:00:00Z")

let tmp: string
let db: Database.Database
let store: NumberStore

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-numbers-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new NumberStore(db)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const reading = (value: number | null, start: string, end: string): Reading => ({
  numberId: "n", value, error: value === null ? "boom" : null, readAt: NOW, periodStart: day(start), periodEnd: day(end) + DAY_MS, by: "reader", note: null,
})

describe("reading windows", () => {
  it("covers the last whole day, ISO week or month, in UTC", () => {
    expect(describePeriod(lastPeriod("daily", NOW))).toBe("2026-11-09")
    expect(describePeriod(lastPeriod("weekly", NOW))).toBe("2026-11-02..2026-11-08")
    expect(describePeriod(lastPeriod("monthly", NOW))).toBe("2026-10-01..2026-10-31")
    expect(periodAt("weekly", day("2026-11-08"))).toEqual({ start: day("2026-11-02"), end: day("2026-11-09") })
  })

  it("parses from and to as whole days, to included", () => {
    expect(parsePeriod("2026-11-02", "2026-11-08")).toEqual({ start: day("2026-11-02"), end: day("2026-11-09") })
    expect(parsePeriod("2026-11-02", undefined)).toEqual({ start: day("2026-11-02"), end: day("2026-11-03") })
    expect(parsePeriod("2026-11-08", "2026-11-02")).toEqual({ error: "to must be on or after from" })
    expect(parsePeriod("2026-02-30", undefined)).toMatchObject({ error: expect.stringMatching(/date/) })
  })
})

describe("status", () => {
  const n = { target: { value: 100, direction: "up" as const }, rhythm: "weekly" as const }
  it("says on target, missed, missed twice, no reading or no target", () => {
    expect(statusOf(n, [], NOW)).toBe("no_reading")
    expect(statusOf(n, [reading(120, "2026-11-02", "2026-11-08")], NOW)).toBe("on_target")
    expect(statusOf(n, [reading(80, "2026-11-02", "2026-11-08")], NOW)).toBe("missed")
    expect(statusOf(n, [reading(80, "2026-11-02", "2026-11-08"), reading(90, "2026-10-26", "2026-11-01")], NOW)).toBe("missed_twice")
    expect(statusOf(n, [reading(80, "2026-11-02", "2026-11-08"), reading(190, "2026-10-26", "2026-11-01")], NOW)).toBe("missed")
    expect(statusOf({ ...n, target: null }, [reading(5, "2026-11-02", "2026-11-08")], NOW)).toBe("no_target")
  })

  it("a failed read is no reading, never 0; a late number is no reading", () => {
    expect(statusOf(n, [reading(null, "2026-11-02", "2026-11-08"), reading(500, "2026-10-26", "2026-11-01")], NOW)).toBe("no_reading")
    expect(statusOf(n, [reading(500, "2026-10-26", "2026-11-01")], NOW)).toBe("no_reading")
  })

  it("a down target is a ceiling", () => {
    expect(statusOf({ ...n, target: { value: 2, direction: "down" } }, [reading(1, "2026-11-02", "2026-11-08")], NOW)).toBe("on_target")
  })
})

describe("input", () => {
  it("takes tags as a list or comma-separated text, lower case and once each", () => {
    expect(parseTags("Channel:YouTube, product:agentx,channel:youtube")).toEqual(["channel:youtube", "product:agentx"])
    expect(parseTags(["two words"])).toMatchObject({ error: expect.any(String) })
  })

  it("refuses a command source except from agentx.json", () => {
    const cmd = { kind: "command", command: "echo 3" }
    expect(parseNumberInput({ id: "x", name: "X", source: cmd }, "agent")).toMatchObject({ error: expect.stringMatching(/agentx.json/) })
    expect(parseNumberInput({ id: "x", name: "X", source: cmd }, "cli")).toMatchObject({ error: expect.stringMatching(/agentx.json/) })
    expect(parseNumberInput({ id: "x", name: "X", source: cmd }, "config")).toMatchObject({ source: { kind: "command", command: "echo 3", path: "", timeoutSeconds: 30 } })
    expect(parseSource({ kind: "http-json", url: "https://x.test/a", headers: { a: "b" } })).toMatchObject({ error: expect.stringMatching(/agentx.json/) })
  })

  it("checks count filters", () => {
    expect(parseSource({ kind: "count", provider: "gitlab", project: "g/p", state: "closed", window: "closed" })).toMatchObject({ error: expect.stringMatching(/GitHub only/) })
    expect(parseSource({ kind: "count", provider: "github", project: "o/r", window: "closed" })).toMatchObject({ error: expect.stringMatching(/state/) })
    expect(parseSource({ kind: "count", provider: "github", project: "o/r", labels: "bug, p1" })).toMatchObject({ labels: ["bug", "p1"], state: "open", window: "none" })
  })
})

describe("the store", () => {
  it("keeps tags as JSON text and one reading per window; a failed read never wipes a value", () => {
    store.upsert({ id: "yt-views", name: "YouTube views", unit: "views", tags: ["channel:youtube", "product:agentx"], target: { value: 1000, direction: "up" }, origin: "cli" }, 1)
    const raw = db.prepare("SELECT tags FROM numbers WHERE id = 'yt-views'").get() as any
    expect(JSON.parse(raw.tags)).toEqual(["channel:youtube", "product:agentx"])
    expect(store.list({ tags: ["channel:youtube"] }).map((n) => n.id)).toEqual(["yt-views"])
    expect(store.list({ tags: ["channel:tiktok"] })).toEqual([])

    const w = { numberId: "yt-views", readAt: 2, periodStart: day("2026-11-02"), periodEnd: day("2026-11-09"), by: "reader" }
    store.record({ ...w, value: 1200 })
    store.record({ ...w, value: null, error: "HTTP 500" })
    expect(store.readings("yt-views")).toMatchObject([{ value: 1200, error: null }])
    store.record({ ...w, value: 1300, by: "owner" })
    expect(store.readings("yt-views")).toMatchObject([{ value: 1300, by: "owner" }])
    expect(store.status(store.get("yt-views")!, NOW)).toBe("on_target")
  })

  it("archives without losing readings, and a change brings it back", () => {
    store.upsert({ id: "a", name: "A", origin: "agent" }, 1)
    store.record({ numberId: "a", value: 3, readAt: 1, periodStart: 0, periodEnd: DAY_MS, by: "x" })
    expect(store.archive("a", 2)).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.list({ archived: true })[0]).toMatchObject({ id: "a", archivedAt: 2 })
    expect(store.readings("a")).toHaveLength(1)
    store.upsert({ id: "a", name: "", origin: "agent" }, 3)
    expect(store.get("a")).toMatchObject({ name: "A", archivedAt: null })
  })
})

describe("readers", () => {
  const period = { start: day("2026-11-02"), end: day("2026-11-09") }
  const connectors = { github: { apiUrl: "https://api.github.test", token: "t" }, gitlab: { url: "https://gl.test" } }

  it("builds count queries with labels, state and a date window", () => {
    const s = parseSource({ kind: "count", provider: "github", project: "o/r", state: "closed", labels: ["bug"], window: "closed" }) as CountSource
    const url = countUrl(s, "issues", period, connectors) as string
    expect(decodeURIComponent(url)).toContain('repo:o/r is:issue is:closed label:"bug" closed:2026-11-02..2026-11-08')
    const gl = parseSource({ kind: "count", provider: "gitlab", project: "g/p", state: "all", labels: ["a", "b"], window: "created", what: "prs" }) as CountSource
    const glUrl = new URL(countUrl(gl, "prs", period, connectors) as string)
    expect(glUrl.pathname).toBe("/api/v4/projects/g%2Fp/merge_requests")
    expect(Object.fromEntries(glUrl.searchParams)).toMatchObject({ state: "all", labels: "a,b", created_after: "2026-11-02T00:00:00.000Z", created_before: "2026-11-09T00:00:00.000Z" })
  })

  it("sums issues and pull requests; a failure is an error, never 0", async () => {
    const s = parseSource({ kind: "count", provider: "github", project: "o/r", what: "all" }) as CountSource
    let n = 0
    const ok = (async () => new Response(JSON.stringify({ total_count: ++n * 10 }))) as unknown as typeof fetch
    expect(await readSourceValue(s, period, { connectors, fetch: ok })).toEqual({ value: 30 })
    const bad = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch
    expect(await readSourceValue(s, period, { connectors, fetch: bad })).toEqual({ error: "o/r: HTTP 502" })
    expect(await readSourceValue(s, period, { connectors: {}, fetch: ok })).toMatchObject({ error: expect.stringMatching(/no github connector/) })
  })

  it("reads http-json at a path, with the window in the address", async () => {
    let asked = ""
    const f = (async (u: string) => { asked = u; return new Response(JSON.stringify({ data: { rows: [{ views: "1,234" }] } })) }) as unknown as typeof fetch
    const s = parseSource({ kind: "http-json", url: "https://stats.test/v?from={start}&to={end}", path: "$.data.rows[0].views" })
    expect(s).toMatchObject({ path: "data.rows[0].views" })
    expect(await readSourceValue(s as any, period, { connectors: {}, fetch: f })).toEqual({ value: 1234 })
    expect(asked).toBe("https://stats.test/v?from=2026-11-02&to=2026-11-08")
    expect(valueAt({ a: "x" }, "a")).toMatchObject({ error: "a is not a number" })
    expect(valueAt({}, "a.b")).toMatchObject({ error: "nothing at a.b" })
  })

  it("runs a command with the window in its environment", async () => {
    const s = parseSource({ kind: "command", command: "x", path: "total" }, true) as any
    let env: Record<string, string> = {}
    const run = async (_c: string, e: Record<string, string>) => { env = e; return { stdout: '{"total": 7}' } }
    expect(await readSourceValue(s, period, { connectors: {}, run })).toEqual({ value: 7 })
    expect(env).toEqual({ AGENTX_PERIOD_START: "2026-11-02", AGENTX_PERIOD_END: "2026-11-08" })
    const plain = parseSource({ kind: "command", command: "x" }, true) as any
    expect(await readSourceValue(plain, period, { connectors: {}, run: async () => ({ stdout: "log line\n42\n" }) })).toEqual({ value: 42 })
    expect(await readSourceValue(plain, period, { connectors: {}, run: async () => ({ error: "the command failed: nope" }) })).toEqual({ error: "the command failed: nope" })
  })
})

describe("the daemon's read", () => {
  const items = {
    "yt-views": { name: "YouTube views", rhythm: "weekly", target: 1000, tags: ["channel:youtube", "product:agentx"], source: { kind: "http-json", url: "https://stats.test/v", path: "views" } },
  }

  it("writes agentx.json numbers, reads each once per period, and retries a failure later", async () => {
    expect(syncConfigNumbers(store, items, NOW)).toEqual([])
    expect(store.get("yt-views")).toMatchObject({ origin: "config", tags: ["channel:youtube", "product:agentx"] })
    let calls = 0
    let answer: Response | Error = new Error("down")
    const f = (async () => { calls++; if (answer instanceof Error) throw answer; return answer }) as unknown as typeof fetch
    expect(await readDueNumbers(store, { connectors: {}, fetch: f }, { retryMinutes: 60 }, NOW)).toEqual(["yt-views"])
    expect(store.readings("yt-views")).toMatchObject([{ value: null, error: expect.stringMatching(/could not be reached/) }])
    expect(store.status(store.get("yt-views")!, NOW)).toBe("no_reading")
    expect(await readDueNumbers(store, { connectors: {}, fetch: f }, { retryMinutes: 60 }, NOW + 60_000)).toEqual([])
    answer = new Response(JSON.stringify({ views: 1500 }))
    expect(await readDueNumbers(store, { connectors: {}, fetch: f }, { retryMinutes: 60 }, NOW + 61 * 60_000)).toEqual(["yt-views"])
    expect(store.readings("yt-views")).toMatchObject([{ value: 1500, error: null }])
    expect(await readDueNumbers(store, { connectors: {}, fetch: f }, { retryMinutes: 60 }, NOW + 3 * 3600_000)).toEqual([])
    expect(calls).toBe(2)
  })

  it("archives a number taken out of agentx.json and reports a bad item", () => {
    syncConfigNumbers(store, items, NOW)
    expect(syncConfigNumbers(store, { bad: { name: "B", rhythm: "hourly" } }, NOW)).toEqual(["numbers.items.bad: rhythm must be daily, weekly, monthly"])
    expect(store.get("yt-views")?.archivedAt).toBe(NOW)
  })

  it("never touches a node with no numbers", async () => {
    expect(syncConfigNumbers(store, {}, NOW)).toEqual([])
    expect(await readDueNumbers(store, { connectors: {} }, { retryMinutes: 60 }, NOW)).toEqual([])
    expect(daemonConfigSchema.parse({ node: { id: "n", name: "n" } }).numbers).toEqual({ items: {}, retryMinutes: 60 })
  })

  it("refuses a bad number in agentx.json", () => {
    const r = daemonConfigSchema.safeParse({ node: { id: "n", name: "n" }, numbers: { items: { x: { source: { kind: "command" } } } } })
    expect(r.success).toBe(false)
  })
})

describe("the goal check", () => {
  it("closes a goal when the newest reading crosses its threshold", async () => {
    const goals = new GoalStore(db)
    const check = parseGoalCheck({ kind: "number", number: "signups", atLeast: 50 })
    expect(check).toEqual({ kind: "number", number: "signups", atLeast: 50 })
    expect(describeGoalCheck(check as any)).toBe("number signups reads ≥ 50")
    expect(parseGoalCheck({ kind: "number", number: "signups" })).toMatch(/atLeast or atMost/)
    goals.upsert({ id: "fifty", title: "Fifty signups", check: check as any }, 1)
    expect(goals.get("fifty")?.check).toEqual(check)

    store.upsert({ id: "signups", name: "Signups", origin: "agent" }, 1)
    const run = (c: any) => Promise.resolve(checkNumber(c, store))
    expect(await checkGoals(goals, run, 10, 100 * 60_000)).toEqual([])
    expect(goals.get("fifty")?.lastCheck).toBe("signups: no reading")
    store.record({ numberId: "signups", value: 40, readAt: 1, periodStart: day("2026-11-02"), periodEnd: day("2026-11-09"), by: "x" })
    expect(await checkGoals(goals, run, 10, 200 * 60_000)).toEqual([])
    store.record({ numberId: "signups", value: null, error: "down", readAt: 1, periodStart: day("2026-11-09"), periodEnd: day("2026-11-16"), by: "x" })
    expect(checkNumber(check as any, store).verdict).toBe("unverifiable")
    store.record({ numberId: "signups", value: 55, readAt: 1, periodStart: day("2026-11-09"), periodEnd: day("2026-11-16"), by: "x" })
    expect(await checkGoals(goals, run, 10, 300 * 60_000)).toEqual(["fifty"])
    expect(goals.get("fifty")).toMatchObject({ state: "done", evidence: "check: Signups: 55 for 2026-11-09..2026-11-15" })
  })
})

describe("value line", () => {
  it("keeps an optional number id", () => {
    expect(cronValueOf({ why: "w", metric: "m", number: " yt-views " })).toEqual({ why: "w", metric: "m", number: "yt-views" })
    expect(cronValueOf({ why: "w", metric: "m", number: "bad id" })).toEqual({ why: "w", metric: "m" })
  })
})

describe("/numbers and agentx_numbers", () => {
  const deps = () => ({
    store, now: NOW, hasAgent: (id: string) => ["coder", "ops"].includes(id),
    runningTurn: (a: string, p: any) => (p.taskId === `t-${a}` ? { channel: "telegram", chatId: "c" } : null),
  })
  const post = (body: Record<string, unknown>, agent = "coder") => handleNumbersApi("POST", "/numbers", new URLSearchParams(), { ...body, agentId: agent }, deps(), { taskId: `t-${agent}` })
  const get = (p: string, q = "") => handleNumbersApi("GET", p, new URLSearchParams(q), undefined, deps())

  it("lets an agent make a number, record readings and list them by tag", () => {
    expect(post({ action: "create", id: "yt-views", name: "YouTube views", target: 1000, tags: ["channel:youtube", "product:agentx"] }).status).toBe(201)
    expect(post({ action: "record", id: "yt-views", value: 1200, from: "2026-11-02", to: "2026-11-08" })).toMatchObject({ status: 200 })
    const list = get("/numbers", "tags=channel:youtube,product:agentx").body as any
    expect(list.numbers).toMatchObject([{ id: "yt-views", ownerAgent: "coder", status: "on_target", latest: { value: 1200, periodStart: day("2026-11-02"), periodEnd: day("2026-11-09") } }])
    expect((get("/numbers", "tags=channel:tiktok").body as any).count).toBe(0)
    expect((get("/numbers/yt-views").body as any).number.readings).toHaveLength(1)
  })

  it("keeps a number to its owner, and agentx.json numbers to agentx.json", () => {
    post({ action: "create", id: "a", name: "A" })
    expect(post({ action: "record", id: "a", value: 1 }, "ops")).toMatchObject({ status: 403 })
    expect(post({ action: "create", id: "c", name: "C", source: { kind: "command", command: "echo 1" } })).toMatchObject({ status: 400 })
    syncConfigNumbers(store, { cfg: { name: "Cfg" } }, NOW)
    expect(post({ action: "create", id: "cfg", name: "Mine" })).toMatchObject({ status: 409 })
    expect(post({ action: "archive", id: "cfg" })).toMatchObject({ status: 409 })
    expect(post({ action: "record", id: "a", value: "n/a" })).toMatchObject({ status: 400 })
    expect(handleNumbersApi("POST", "/numbers", new URLSearchParams(), { action: "record", id: "a", value: 1, agentId: "coder" }, deps(), {})).toMatchObject({ status: 403 })
  })

  it("never shows agentx.json header values or command text", async () => {
    const secret = "Bearer tok-SECRET-123"
    const cmd = "curl -H 'X-Key: cmd-SECRET-456' https://stats.test"
    expect(syncConfigNumbers(store, {
      web: { name: "Web", ownerAgent: "coder", source: { kind: "http-json", url: "https://stats.test/v", path: "views", headers: { Authorization: secret } } },
      cmd: { name: "Cmd", source: { kind: "command", command: cmd, path: "" } },
    }, NOW)).toEqual([])
    store.record({ numberId: "web", value: 5, readAt: NOW, periodStart: day("2026-11-09"), periodEnd: day("2026-11-10"), by: "reader", note: null })
    const replies = [get("/numbers"), get("/numbers/web"), get("/numbers/cmd"), post({ action: "record", id: "web", value: 6 })]
    for (const r of replies) {
      expect(r.status).toBe(200)
      const text = JSON.stringify(r.body)
      expect(text).not.toContain("SECRET")
      expect(text).not.toContain("curl")
    }
    expect((get("/numbers/web").body as any).number.source.headers).toEqual({ Authorization: "***" })
    expect((get("/numbers/cmd").body as any).number.source.command).toBe("***")
    // the store keeps the real values, so the reader still works
    expect(store.get("web")!.source).toMatchObject({ headers: { Authorization: secret } })
    expect(store.get("cmd")!.source).toMatchObject({ command: cmd })
    const f = (async (u: string) => {
      const url = new URL(u)
      const r = handleNumbersApi("GET", url.pathname, url.searchParams, undefined, deps())
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as unknown as typeof fetch
    for (const args of [{ action: "list" }, { action: "show", id: "web" }, { action: "show", id: "cmd" }]) {
      expect(await runNumbersTool(args, { daemonUrl: "http://d", fetch: f, env: {} })).not.toMatch(/SECRET|curl/)
    }
  })

  it("the tool reads the endpoints as text", async () => {
    post({ action: "create", id: "yt-views", name: "YouTube views", unit: "views", target: 1000, tags: ["channel:youtube"] })
    post({ action: "record", id: "yt-views", value: 800, from: "2026-11-02", to: "2026-11-08" })
    const f = (async (u: string, init?: RequestInit) => {
      const url = new URL(u)
      const r = init?.method === "POST"
        ? handleNumbersApi("POST", url.pathname, url.searchParams, JSON.parse(String(init.body)), deps(), { taskId: "t-coder" })
        : handleNumbersApi("GET", url.pathname, url.searchParams, undefined, deps())
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as unknown as typeof fetch
    const opts = { daemonUrl: "http://d", fetch: f, env: {} }
    expect(await runNumbersTool({ action: "list", tags: ["channel:youtube"] }, opts)).toContain('yt-views "YouTube views" [missed]: 800 views for 2026-11-02..2026-11-08')
    expect(await runNumbersTool({ action: "show", id: "yt-views" }, opts)).toContain("2026-11-02..2026-11-08: 800 views, by coder")
    expect(await runNumbersTool({ action: "record", id: "yt-views", value: 1100, callerAgentId: "coder" }, opts)).toContain("[on target]: 1,100 views")
  })
})
