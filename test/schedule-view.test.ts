import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { recordCronChange } from "../src/crons/change-ledger"
import { updateJobGoalState } from "../src/crons/goal-state"
import { cronExtras, schedulesExtras } from "../src/crons/schedule-view"
import { allowedHostJobsSchema, expiredHostJobs, hostJobEnds } from "../src/crons/host-jobs"
import { daemonConfigSchema } from "../src/daemon/config"

// #863: what Settings › Schedules and the Wall show beside each job (the
// owner's verdict, until / endedAt, the change log), and the allowed host
// jobs past their until.

let dir: string
let db: Database.Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-view-"))
  db = new Database(":memory:")
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("cronExtras", () => {
  it("joins the verdict, goal-check lines, until, endedAt and the newest 5 changes", () => {
    updateJobGoalState(dir, "a", (s) => {
      s.lastVerdict = { text: "all paid", at: "2026-11-20T10:00:00.000Z", by: "alpha" }
      s.changeOwed = { since: "2026-11-19T00:00:00Z", cardId: "c1" }
    })
    for (let i = 0; i < 7; i++) recordCronChange(db, { job: "a", field: "brief", old: `p${i}`, new: `p${i + 1}`, by: "alpha", reason: `r${i}`, at: 1000 + i })
    const x = cronExtras(dir, {
      a: { agent: "alpha", until: "2026-12-15T00:00:00.000Z" },
      b: { agent: "beta", endedAt: "2026-11-01T00:00:00.000Z" },
    }, { ledger: () => db })
    expect(x.a).toMatchObject({ until: "2026-12-15T00:00:00.000Z", lastVerdict: { text: "all paid" }, goalLines: ["change owed by alpha since 2026-11-19"] })
    expect(x.a.changes).toHaveLength(5)
    expect(x.a.changes![0]).toEqual({ field: "brief", old: "p6", new: "p7", by: "alpha", reason: "r6", at: 1006 })
    expect(x.b).toEqual({ endedAt: "2026-11-01T00:00:00.000Z" })
  })

  it("works with no state file and no ledger", () => {
    expect(cronExtras(dir, { a: { agent: "alpha" } }, { ledger: () => null })).toEqual({ a: {} })
  })
})

describe("allowedHostJobs", () => {
  const list = {
    "com.noqta.disk-hold-watch": { owner: "devops-agent", why: "its own PR later", until: "2026-11-20" },
    "com.noqta.later": { owner: "coo-agent", why: "moving in December", until: "2026-12-31" },
    "com.apple.backupd": { owner: "devops-agent", why: "a system service" },
  }

  it("lists only the entries past their until, for their owner; a bare date lasts the whole day", () => {
    expect(expiredHostJobs(list, Date.parse("2026-11-20T23:00:00Z"))).toEqual([])
    const lines = expiredHostJobs(list, Date.parse("2026-11-21T00:00:00Z"))
    expect(lines).toEqual([expect.objectContaining({ label: "com.noqta.disk-hold-watch", owner: "devops-agent", until: "2026-11-20" })])
    expect(lines[0].text).toMatch(/past its until 2026-11-20: devops-agent moves it/)
    expect(hostJobEnds("2026-11-20T08:00:00Z")).toBe(Date.parse("2026-11-20T08:00:00Z"))
  })

  it("is part of the config, and refuses a bad until", () => {
    expect(allowedHostJobsSchema.safeParse({ x: { owner: "a", why: "b", until: "someday" } }).success).toBe(false)
    const cfg = daemonConfigSchema.parse({ node: { id: "t", name: "T" }, agents: {}, allowedHostJobs: list })
    expect(Object.keys(cfg.allowedHostJobs)).toHaveLength(3)
    expect(daemonConfigSchema.parse({ node: { id: "t", name: "T" }, agents: {} }).allowedHostJobs).toEqual({})
  })

  it("goes out on GET /crons/extras with the sensors", () => {
    const out = schedulesExtras(dir, { allowedHostJobs: list }, Date.parse("2026-12-01T00:00:00Z"))
    expect(out.sensors).toEqual([])
    expect(out.hostJobs.map((h) => h.label)).toEqual(["com.noqta.disk-hold-watch"])
  })
})
