import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { PlanStore } from "../src/requests/plan-store"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { GoalStore, checkGoals, goalBrief, parseGoalCheck } from "../src/requests/goal-store"
import { describeGoalRecord, runRequestTool } from "../src/requests/tool"
import { CronScheduler } from "../src/crons/scheduler"
import { cronGoalGate } from "../src/crons/goal-gate"
import { daemonConfigSchema } from "../src/daemon/config"
import { CRON_VALUE_SCRIPT, NO_GOAL } from "../src/daemon/ui/cron-value"

// A goal as its own record, and crons that hang off one (#1568 part 3).

const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const COUNT = { kind: "count", provider: "github", project: "acme/app", what: "issues", max: 0 }

let tmp: string
let db: Database.Database
let store: RequestStore
let plans: PlanStore
let goals: GoalStore
let tracker: RequestTracker
let now: number

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-goal-record-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  plans = new PlanStore(db)
  goals = new GoalStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  now = 6_000
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Calls as `agentId`, whose running turn is `taskId`. */
const api = (method: string, p: string, body?: Record<string, unknown>, agentId = "coder", taskId = "t1") =>
  handleRequestsApi(method, p, body, {
    store, tracker, plans, goals, enabled: true, hasAgent: (id) => ["coder", "ops"].includes(id), now,
    runningTurn: (a, pr) => (a === agentId && pr.taskId === taskId ? { channel: "telegram", chatId: `chat-${taskId}` } : null),
  }, { taskId })

describe("the goal store", () => {
  it("makes, changes, lists and closes a record; a closed one stays closed", () => {
    const g = goals.upsert({ id: "zero-issues", title: "No open issues", ownerAgent: "coder", doneWhen: "0 open" }, 1)
    expect(g).toMatchObject({ id: "zero-issues", state: "active", ownerAgent: "coder", doneWhen: "0 open", check: null, createdAt: 1 })
    goals.upsert({ id: "zero-issues", title: "", check: { kind: "count", provider: "github", project: "acme/app", what: "issues", max: 0 } }, 2)
    expect(goals.get("zero-issues")).toMatchObject({ title: "No open issues", doneWhen: "0 open", check: COUNT, updatedAt: 2 })
    expect(goals.list(["active"]).map((x) => x.id)).toEqual(["zero-issues"])
    expect(goals.close("zero-issues", "done", "all closed", 3)).toBe(true)
    expect(goals.close("zero-issues", "dropped", "again", 4)).toBe(false)
    expect(goals.get("zero-issues")).toMatchObject({ state: "done", evidence: "all closed", closedAt: 3 })
    expect(goals.list(["active"])).toEqual([])
  })

  it("ensure makes a record only when it is new", () => {
    goals.ensure({ id: "launch", title: "Launch" }, "coder", 1)
    goals.ensure({ id: "launch", title: "Another title" }, "ops", 2)
    expect(goals.get("launch")).toMatchObject({ title: "Launch", ownerAgent: "coder", createdAt: 1 })
  })

  it("takes any loop check or a count as its check", () => {
    expect(parseGoalCheck(COUNT)).toEqual(COUNT)
    expect(parseGoalCheck({ kind: "url", url: "https://example.com/v" })).toEqual({ kind: "url", url: "https://example.com/v" })
    expect(parseGoalCheck({ kind: "count", provider: "github", project: "nope" })).toMatch(/owner\/repo/)
    expect(parseGoalCheck({ kind: "smell" })).toMatch(/url, issue, git-ancestor, reply or count/)
  })
})

describe("the goal check", () => {
  it("closes a goal as done when its check is met, at most once per interval", async () => {
    goals.upsert({ id: "zero-issues", title: "No open issues", check: parseGoalCheck(COUNT) as any }, 0)
    goals.upsert({ id: "plain", title: "No check" }, 0)
    let open = 3
    const check = vi.fn(async () => (open <= 0 ? { verdict: "met" as const, detail: "0 open issues" } : { verdict: "not_met" as const, detail: `${open} open issues` }))
    expect(await checkGoals(goals, check, 10, 60_000)).toEqual([])
    expect(goals.get("zero-issues")).toMatchObject({ state: "active", lastCheck: "3 open issues", lastCheckAt: 60_000 })
    open = 0
    expect(await checkGoals(goals, check, 10, 120_000)).toEqual([]) // checked a minute ago
    expect(await checkGoals(goals, check, 10, 60_000 + 10 * 60_000)).toEqual(["zero-issues"])
    expect(goals.get("zero-issues")).toMatchObject({ state: "done", evidence: "check: 0 open issues" })
    expect(check).toHaveBeenCalledTimes(2)
    expect(goals.get("plain")?.state).toBe("active")
  })

  it("keeps going when one check throws", async () => {
    goals.upsert({ id: "a", title: "A", check: { kind: "url", url: "https://a.example" } }, 0)
    goals.upsert({ id: "b", title: "B", check: { kind: "url", url: "https://b.example" } }, 0)
    const closed = await checkGoals(goals, async (c: any) => {
      if (c.url.includes("a.")) throw new Error("boom")
      return { verdict: "met", detail: "up" }
    }, 10, 1)
    expect(closed).toEqual(["b"])
    expect(goals.get("a")).toMatchObject({ state: "active", lastCheck: "boom" })
  })
})

describe("the goal API", () => {
  function turn(taskId: string) {
    tracker.taskStarted({
      agentId: "coder", channel: "telegram", chatId: `chat-${taskId}`, taskId, messagePreview: "job", fullMessage: "job",
      at: "", humanRoot: true, sender: { id: "4242" },
    } as any)
  }

  it("accepting a request with a goal makes the goal's record", () => {
    turn("t1")
    const res = api("POST", "/requests", { action: "accept", agentId: "coder", work: "research", goal: { id: "launch", title: "Launch the site" } })
    expect(res.status).toBe(200)
    expect(goals.get("launch")).toMatchObject({ title: "Launch the site", ownerAgent: "coder", state: "active" })
    const list = api("GET", "/requests/goals").body as any
    expect(list.goals.map((g: any) => g.id)).toEqual(["launch"])
    expect(list.records).toEqual([expect.objectContaining({ id: "launch", state: "active" })])
    const one = api("GET", "/requests/goals/launch").body as any
    expect(one.goal).toMatchObject({ id: "launch" })
    expect(one.summary).toMatchObject({ id: "launch", open: 1 })
    expect(api("GET", "/requests/goals/nope").status).toBe(404)
  })

  it("creates a goal with a check, and only its owner closes or drops it", () => {
    const made = api("POST", "/requests/goals", { action: "create", agentId: "coder", goal: { id: "zero-issues", title: "No open issues" }, doneWhen: "0 open", check: COUNT })
    expect(made.status).toBe(201)
    expect((made.body as any).goal).toMatchObject({ id: "zero-issues", ownerAgent: "coder", check: COUNT, doneWhen: "0 open" })
    expect(api("POST", "/requests/goals", { action: "create", agentId: "coder", goal: { id: "zero-issues", title: "No open issues" }, doneWhen: "0 open issues" }).status).toBe(200)

    expect(api("POST", "/requests/goals", { action: "close", agentId: "ops", id: "zero-issues", evidence: "x" }, "ops", "t2").status).toBe(403)
    expect(api("POST", "/requests/goals", { action: "create", agentId: "ops", goal: { id: "zero-issues", title: "Mine" } }, "ops", "t2").status).toBe(403)
    expect(api("POST", "/requests/goals", { action: "close", agentId: "coder", id: "zero-issues" }).status).toBe(400)
    // No running turn of the agent named: refused.
    expect(handleRequestsApi("POST", "/requests/goals", { action: "close", agentId: "coder", id: "zero-issues", evidence: "x" }, {
      store, tracker, plans, goals, enabled: true, hasAgent: () => true, now, runningTurn: () => null,
    }, {}).status).toBe(403)
    expect(goals.get("zero-issues")?.state).toBe("active")
    expect((api("POST", "/requests/goals", { action: "drop", agentId: "coder", id: "zero-issues", reason: "not needed" }).body as any).goal).toMatchObject({ state: "dropped", evidence: "not needed" })
  })

  it("closes, then refuses to reopen or close again", () => {
    api("POST", "/requests/goals", { action: "create", agentId: "coder", goal: { title: "Ship it" } })
    const closed = api("POST", "/requests/goals", { action: "close", agentId: "coder", id: "ship-it", evidence: "https://example.com/pull/1" })
    expect((closed.body as any).goal).toMatchObject({ state: "done", evidence: "https://example.com/pull/1" })
    expect(api("POST", "/requests/goals", { action: "drop", agentId: "coder", id: "ship-it", reason: "no" }).status).toBe(409)
    expect((api("POST", "/requests/goals", { action: "create", agentId: "coder", goal: { title: "Ship it" } }).body as any).error).toMatch(/already done: a new goal needs a new id/)
    expect(api("POST", "/requests/goals", { action: "bogus", agentId: "coder" }).status).toBe(400)
    expect(api("POST", "/requests/goals", { action: "create", agentId: "coder", goal: { title: "X" }, check: { kind: "smell" } }).status).toBe(400)
  })
})

describe("the agent tool", () => {
  it("shows a record and posts goal writes with the caller's identity", async () => {
    const calls: Array<{ url: string; body?: any }> = []
    const fetcher = (async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      if (url.endsWith("/requests/goals/zero-issues")) {
        return new Response(JSON.stringify({ goal: { id: "zero-issues", title: "No open issues", state: "active", ownerAgent: "coder", doneWhen: "0 open", check: COUNT, lastCheck: "3 open issues in acme/app" }, summary: { open: 1, done: 2, dropped: 0, costUsd: 1.5 } }))
      }
      return new Response(JSON.stringify({ goal: { id: "zero-issues", title: "No open issues", state: "done", ownerAgent: "coder", evidence: "x" } }))
    }) as any
    const shown = await runRequestTool({ action: "goal", id: "zero-issues" }, { daemonUrl: "http://d", fetch: fetcher, env: {} })
    expect(shown).toContain('zero-issues "No open issues" [active, owner coder]. Done when: 0 open. Check: open issues in github acme/app ≤ 0 (last: 3 open issues in acme/app).')
    expect(shown).toContain("Requests: 1 open, 2 done")
    const closed = await runRequestTool({ action: "goal", goalAction: "close", id: "zero-issues", evidence: "x", callerAgentId: "coder" }, { daemonUrl: "http://d", fetch: fetcher, env: {} })
    expect(closed).toBe("Goal zero-issues is done. Crons that name it no longer run.")
    expect(calls[1]).toMatchObject({ url: "http://d/requests/goals", body: { action: "close", agentId: "coder", id: "zero-issues", evidence: "x" } })
  })

  it("describes a closed record with its evidence", () => {
    expect(describeGoalRecord({ id: "g", title: "G", state: "dropped", ownerAgent: null, doneWhen: null, check: null, evidence: "no longer needed" } as any))
      .toBe('g "G" [dropped]. Closed: no longer needed.')
  })
})

describe("crons.<id>.goal", () => {
  const prevCwd = process.cwd()
  beforeEach(() => process.chdir(tmp))
  afterEach(() => process.chdir(prevCwd))
  const node = { id: "node-a", name: "node-a" }
  const job = (extra: Record<string, unknown> = {}) => ({ schedule: "0 9 * * 1", agent: "ops", prompt: "Report on the open issues", ...extra })

  it("is a goal id in config", () => {
    const ok = daemonConfigSchema.safeParse({ node, agents: {}, crons: { hourly: job({ goal: "zero-issues" }) } })
    expect(ok.success && ok.data.crons.hourly.goal).toBe("zero-issues")
    expect(daemonConfigSchema.safeParse({ node, agents: {}, crons: { hourly: job({ goal: "not an id" }) } }).success).toBe(false)
  })

  function scheduler(state: string | null) {
    const cfg = daemonConfigSchema.parse({ node, agents: {}, crons: { hourly: job({ goal: "zero-issues" }), plain: job() } })
    const registry = { execute: vi.fn(async (_task: any) => ({ content: "ok", duration: 1 })) }
    const logs: string[] = []
    const s: any = new CronScheduler(cfg, registry as any, undefined, (...a: unknown[]) => logs.push(a.join(" ")))
    s.scheduleNext = vi.fn()
    s.scheduleRetry = () => {}
    s.logRun = () => {}
    s.running = true
    s.setGoalSource((id: string) => (state === null ? null : { state, brief: `[Goal] No open issues (${id}): ${state}.` }))
    return { s, registry, logs }
  }

  it("puts the goal's state ahead of the prompt of each run", async () => {
    const { s, registry } = scheduler("active")
    await s.executeJob("hourly")
    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(registry.execute.mock.calls[0][0].message).toMatch(/^\[Goal\] No open issues \(zero-issues\): active\.\n\nReport on the open issues/)
    await s.executeJob("plain")
    expect(registry.execute.mock.calls[1][0].message).not.toContain("[Goal]")
  })

  it("skips the run once its goal is done, logs it once, and keeps the job's schedule", async () => {
    const { s, registry, logs } = scheduler("done")
    await s.executeJob("hourly")
    await s.executeJob("hourly")
    expect(registry.execute).not.toHaveBeenCalled()
    expect(s.scheduleNext).toHaveBeenCalledTimes(2)
    expect(logs.filter((l) => l.includes('Job "hourly" skipped: goal "zero-issues" is done'))).toHaveLength(1)
    const listed = s.list().find((j: any) => j.id === "hourly")
    expect(listed).toMatchObject({ goal: "zero-issues", goalClosed: { state: "done" }, enabled: true })
  })

  it("runs as before when this node has no record of the goal", () => {
    expect(cronGoalGate("zero-issues", () => null)).toEqual({ skip: null, brief: "[Goal] zero-issues: no record of this goal on this node." })
    expect(cronGoalGate(undefined, () => { throw new Error("never read") })).toEqual({ skip: null, brief: "" })
    expect(cronGoalGate("g", () => { throw new Error("db gone") }).skip).toBeNull()
  })

  it("the goal brief says the state, what done means, the check and the requests", () => {
    const g = goals.upsert({ id: "zero-issues", title: "No open issues", ownerAgent: "coder", doneWhen: "0 open", check: parseGoalCheck(COUNT) as any }, 0)
    goals.markChecked("zero-issues", "3 open issues in acme/app", Date.UTC(2026, 9, 31, 16, 0))
    expect(goalBrief(goals.get("zero-issues")!, { open: 1, done: 2 })).toBe([
      "[Goal] No open issues (zero-issues): active, owner coder.",
      "Done when: 0 open",
      "Check: open issues in github acme/app ≤ 0; last seen: 3 open issues in acme/app (2026-10-31 16:00 UTC)",
      "Requests under it: 1 open, 2 done.",
    ].join("\n"))
    expect(g.state).toBe("active")
  })

  it("the Jobs tab and Settings say which goal, ask to turn it off once done, and show no goal on a prompt job without one", () => {
    const esc = (s: string) => String(s).replace(/</g, "&lt;")
    const html = new Function(CRON_VALUE_SCRIPT + "\nreturn axCronGoalHtml;")() as (c: unknown, e: typeof esc) => string
    expect(html({ goal: "zero-issues" }, esc)).toContain("Goal: <b>zero-issues</b>")
    expect(html({ goal: "zero-issues", goalClosed: { state: "done" } }, esc)).toContain("goal zero-issues done, disable?")
    expect(html({ kind: "agent" }, esc)).toContain(NO_GOAL)
    expect(html({ kind: "command" }, esc)).toBe("")
  })
})
