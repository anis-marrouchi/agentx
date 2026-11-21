import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { runScheduleTool, type ScheduleCaller } from "../src/crons/schedule-tool"
import { cronChanges } from "../src/crons/change-ledger"
import { jobGoalState, updateJobGoalState } from "../src/crons/goal-state"
import { lateLine, pastUntil } from "../src/crons/job-end"
import { retiredRefusalAt } from "../src/crons/retired"
import { CronScheduler } from "../src/crons/scheduler"
import type { GoalCheckDeps } from "../src/crons/goal-check"

// #863 v2: the owner's verdict line, `until` on a recurring job, and the
// late line of a one-time run missed while the daemon was down.

const NOW = new Date("2026-11-28T08:00:00.000Z")
let dir: string
let configPath: string
let db: Database.Database
const alpha: ScheduleCaller = { agentId: "alpha" }
const beta: ScheduleCaller = { agentId: "beta" }

function writeConfig(crons: Record<string, any>) {
  writeFileSync(configPath, JSON.stringify({
    node: { id: "t", name: "T", bind: "127.0.0.1:0" },
    agents: {
      alpha: { name: "Alpha", workspace: "./agents/alpha", tier: "claude-code" },
      beta: { name: "Beta", workspace: "./agents/beta", tier: "claude-code" },
    },
    crons,
  }, null, 2))
}
const crons = () => JSON.parse(readFileSync(configPath, "utf-8")).crons
const tool = (args: Record<string, unknown>, caller = alpha) => runScheduleTool(args, caller, { configPath, reload: false, now: () => NOW, ledger: () => db })
const daily = { enabled: true, schedule: "0 9 * * *", timezone: "UTC", agent: "alpha", prompt: "report", createdBy: "beta" }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-until-"))
  configPath = join(dir, "agentx.json")
  db = new Database(":memory:")
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("verdict", () => {
  it("the owner writes one line, kept in the state file", async () => {
    writeConfig({ d: daily })
    expect(await tool({ action: "verdict", id: "d", text: "  3 invoices sent,\n all paid " })).toMatch(/Recorded the verdict/)
    expect(jobGoalState(dir, "d").lastVerdict).toEqual({ text: "3 invoices sent, all paid", at: NOW.toISOString(), by: "alpha" })
  })

  it("only from the owner, at most 200 characters, never empty", async () => {
    writeConfig({ d: daily })
    expect(await tool({ action: "verdict", id: "d", text: "x" }, beta)).toMatch(/only the job's owner/)
    expect(await tool({ action: "verdict", id: "d", text: "x".repeat(201) })).toMatch(/longer than 200/)
    expect(await tool({ action: "verdict", id: "d" })).toMatch(/needs `text`/)
  })
})

describe("until through change", () => {
  it("sets and clears it with a ledger row each time", async () => {
    writeConfig({ d: daily })
    expect(await tool({ action: "change", id: "d", until: "2026-12-15T00:00:00Z", reason: "renewal ends" })).toMatch(/ends after 2026-12-15T00:00:00.000Z/)
    expect(crons().d.until).toBe("2026-12-15T00:00:00.000Z")
    expect(await tool({ action: "change", id: "d", until: "none", reason: "keeps going" })).toMatch(/no end time/)
    expect(crons().d.until).toBeUndefined()
    expect(cronChanges(db, "d").map((r) => [r.field, r.new])).toEqual([["until", null], ["until", "2026-12-15T00:00:00.000Z"]])
  })

  it("refuses a past time, a bad time, a one-time job, and any until while on goal check", async () => {
    writeConfig({ d: daily, once: { ...daily, runAt: "2026-12-01T09:00:00Z" } })
    expect(await tool({ action: "change", id: "d", until: "2026-11-01T00:00:00Z", reason: "x" })).toMatch(/in the past/)
    expect(await tool({ action: "change", id: "d", until: "soon", reason: "x" })).toMatch(/ISO time/)
    expect(await tool({ action: "change", id: "once", until: "2026-12-15T00:00:00Z", reason: "x" })).toMatch(/runs once/)
    updateJobGoalState(dir, "d", (s) => { s.goalCheck = { goalId: "g", since: "2026-11-20T00:00:00Z", reason: "closed" } })
    expect(await tool({ action: "change", id: "d", until: "2026-12-15T00:00:00Z", reason: "x" })).toMatch(/on goal check.*end time/)
  })
})

describe("the late line", () => {
  it("says how late, in hours or minutes, and nothing when on time", () => {
    expect(lateLine(undefined)).toBe("")
    expect(lateLine(30_000)).toBe("")
    expect(lateLine(25 * 60_000)).toBe("This run is 25 min late (missed while the daemon was down).")
    expect(lateLine(5 * 3_600_000 + 10 * 60_000)).toBe("This run is 5 h late (missed while the daemon was down).")
  })
})

describe("in the scheduler", () => {
  function scheduler(job: Record<string, unknown>) {
    const execute = vi.fn(async (_t: any) => ({ content: "done", duration: 1 }))
    const s: any = new CronScheduler({
      crons: { d: { schedule: "0 9 * * *", timezone: "UTC", agent: "alpha", prompt: "report", timeout: 60, onError: ["log"], enabled: true, ...job } },
      agents: {}, notifications: {},
    } as any, { execute } as any, undefined, () => {})
    s.running = true
    s.armTimer = vi.fn()
    s.saveLastRuns = vi.fn()
    s.logRun = vi.fn()
    s.loadLastRuns = () => ({})
    s.goalCheck = { root: dir, configPath, ledger: () => db } as Partial<GoalCheckDeps>
    return { s, execute }
  }

  it("a job past its until ends: off, endedAt in agentx.json, a ledger row by the daemon, never resumed", async () => {
    writeConfig({ d: { ...daily, until: "2026-01-01T00:00:00Z" } })
    const { s } = scheduler({ until: "2026-01-01T00:00:00Z" })
    s.scheduleNext("d")
    await vi.waitFor(() => expect(crons().d.endedAt).toBe("2026-01-01T00:00:00.000Z"))
    expect(crons().d.enabled).toBe(false)
    expect(s.jobs.get("d").enabled).toBe(false)
    expect(cronChanges(db, "d")).toEqual([expect.objectContaining({ field: "end", by: "daemon", reason: "until 2026-01-01T00:00:00Z" })])
    expect(retiredRefusalAt(dir, "d", crons().d)).toMatch(/retired on 2026-01-01/)
  })

  it("an until before the next run arms the end at the until, not a run", () => {
    const until = new Date(Date.now() + 60_000).toISOString()
    writeConfig({ d: { ...daily, schedule: "0 0 1 1 *", until } })
    const { s } = scheduler({ schedule: "0 0 1 1 *", until })
    s.scheduleNext("d")
    expect(s.armTimer).toHaveBeenCalledWith("d", Date.parse(until), expect.any(Function))
    expect(s.jobs.get("d").nextRun).toBeUndefined()
  })

  it("a fire past its until does not run", async () => {
    writeConfig({ d: { ...daily, until: "2026-01-01T00:00:00Z" } })
    const { s, execute } = scheduler({ until: "2026-01-01T00:00:00Z" })
    await s.executeJob("d")
    expect(execute).not.toHaveBeenCalled()
    expect(pastUntil("2026-01-01T00:00:00Z", Date.now())).toBe(true)
  })

  it("a one-time run missed while the daemon was down starts with the late line, once", async () => {
    const runAt = new Date(Date.now() - 3 * 3_600_000).toISOString()
    writeConfig({ d: { ...daily, runAt } })
    const { s, execute } = scheduler({ runAt })
    s.scheduleNext("d")
    await s.executeJob("d")
    expect(execute.mock.calls[0][0].message).toMatch(/^This run is 3 h late \(missed while the daemon was down\)\.\n\nreport/)
    expect(s.jobs.get("d").lateBy).toBeUndefined()
  })

  it("a one-time run on time has no late line", async () => {
    const runAt = new Date(Date.now() + 1000).toISOString()
    writeConfig({ d: { ...daily, runAt } })
    const { s, execute } = scheduler({ runAt })
    s.scheduleNext("d")
    await s.executeJob("d")
    expect(execute.mock.calls[0][0].message).not.toMatch(/late/)
  })
})
