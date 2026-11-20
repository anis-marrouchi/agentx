import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2004: a one-time job runs at its `runAt` and then switches itself off,
// in memory and in agentx.json. A time missed while the daemon was down
// runs once at start; a job that already ran is switched off, not re-run.

const writes: Array<Record<string, any>> = []
vi.mock("../src/daemon/config-mutator", () => ({
  setAtPath: (obj: any, path: string, value: unknown) => {
    const keys = path.split(".")
    let o = obj
    for (const k of keys.slice(0, -1)) o = o[k] ??= {}
    o[keys[keys.length - 1]] = value
  },
  applyConfigMutation: async (fn: (c: any) => void) => {
    const cfg: Record<string, any> = {}
    fn(cfg)
    writes.push(cfg)
    return { success: true }
  },
}))

const { CronScheduler } = await import("../src/crons/scheduler")

let dir: string
const prevCwd = process.cwd()

function scheduler(runAt: string) {
  const s: any = new CronScheduler(
    {
      crons: {
        check: {
          enabled: true, schedule: "5 9 20 11 *", runAt, timezone: "UTC", agent: "coder-agent",
          prompt: "", command: "echo checked", timeout: 30, onError: ["log"],
        },
      },
      agents: {}, notifications: {},
    } as any,
    { execute: vi.fn() } as any,
    undefined,
    () => {},
  )
  s.running = true
  s.armTimer = vi.fn()
  return s
}

describe("one-time cron jobs (#2004)", () => {
  beforeEach(() => {
    writes.length = 0
    dir = mkdtempSync(join(tmpdir(), "agentx-once-"))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it("arms the single run at runAt", () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString()
    const s = scheduler(runAt)
    s.scheduleNext("check")
    expect(s.armTimer).toHaveBeenCalledWith("check", Date.parse(runAt), expect.any(Function))
  })

  it("switches itself off after it runs, and says so in agentx.json", async () => {
    const s = scheduler(new Date(Date.now() - 1000).toISOString())
    await s.executeJob("check")
    await new Promise((r) => setImmediate(r))
    const job = s.jobs.get("check")
    expect(job.totalRuns).toBe(1)
    expect(job.enabled).toBe(false)
    expect(writes).toContainEqual({ crons: { check: { enabled: false } } })
  })

  it("records its run on disk before the run starts", async () => {
    const s = scheduler(new Date(Date.now() - 1000).toISOString())
    s.executeCommandJob = vi.fn(async () => {
      const saved = JSON.parse(readFileSync(join(dir, ".agentx/cron/last-runs.json"), "utf8"))
      expect(saved.check).toBeTruthy()
    })
    await s.executeJob("check")
    expect(s.executeCommandJob).toHaveBeenCalled()
  })

  it("runs a time missed while the daemon was down once, at start", () => {
    const s = scheduler(new Date(Date.now() - 3_600_000).toISOString())
    const before = Date.now()
    s.scheduleNext("check")
    const [, at] = s.armTimer.mock.calls[0]
    expect(at).toBeGreaterThanOrEqual(before)
    expect(s.detectMissedRuns()).toEqual([])
  })

  it("does not run again after a restart when it already ran", () => {
    const runAt = new Date(Date.now() - 3_600_000).toISOString()
    mkdirSync(join(dir, ".agentx/cron"), { recursive: true })
    writeFileSync(join(dir, ".agentx/cron/last-runs.json"), JSON.stringify({ check: new Date(Date.now() - 1_800_000).toISOString() }))
    const s = scheduler(runAt)
    s.scheduleNext("check")
    expect(s.armTimer).not.toHaveBeenCalled()
    expect(s.jobs.get("check").enabled).toBe(false)
  })
})
