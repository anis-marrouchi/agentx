import { describe, it, expect, vi } from "vitest"

// #863 review n158092 item 2: a missed run (catch-up at boot) checks
// enabled and until again after it awaits the goal check. Before, a job
// past its until, or paused meanwhile, still ran once at boot.

async function scheduler(def: Record<string, unknown> = {}) {
  const { CronScheduler } = await import("../src/crons/scheduler")
  const execute = vi.fn(async () => ({ content: "done", duration: 1 }))
  const s: any = new CronScheduler({
    crons: { j: { enabled: true, schedule: "0 9 * * *", timezone: "UTC", agent: "helper", prompt: "work", timeout: 60, onError: ["log"], ...def } },
    agents: {}, notifications: {},
  } as any, { execute } as any, undefined, () => {})
  s.running = true
  s.armTimer = vi.fn()
  s.saveLastRuns = vi.fn()
  s.logRun = vi.fn()
  s.deliverResult = vi.fn(async () => {})
  s.endAtUntil = vi.fn(async (job: any) => { job.enabled = false })
  return { s, execute }
}

const missed = [{ jobId: "j", missedAt: new Date(Date.now() - 3_600_000) }]
const go = { skip: false, brief: "" }

describe("a missed run after the goal check's await", () => {
  it("passes its until while the goal check awaits: ended, not run", async () => {
    const { s, execute } = await scheduler()
    // Set after the (slow, first) import, so it is still ahead at the start.
    s.jobs.get("j").until = new Date(Date.now() + 150).toISOString()
    s.goalHold = vi.fn(async () => { await new Promise((r) => setTimeout(r, 300)); return go })
    await s.executeMissedRuns(missed)
    expect(s.goalHold).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(s.endAtUntil).toHaveBeenCalledOnce()
    await s.stop()
  })

  it("already past its until at boot: ended, no goal check, not run", async () => {
    const { s, execute } = await scheduler({ until: new Date(Date.now() - 60_000).toISOString() })
    s.goalHold = vi.fn(async () => go)
    await s.executeMissedRuns(missed)
    expect(s.goalHold).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(s.endAtUntil).toHaveBeenCalledOnce()
    await s.stop()
  })

  it("paused while the goal check awaits: not run", async () => {
    const { s, execute } = await scheduler()
    s.goalHold = vi.fn(async () => { s.jobs.get("j").enabled = false; return go })
    await s.executeMissedRuns(missed)
    expect(execute).not.toHaveBeenCalled()
    await s.stop()
  })

  it("still due after the await: runs once", async () => {
    const { s, execute } = await scheduler({ until: new Date(Date.now() + 3_600_000).toISOString() })
    s.goalHold = vi.fn(async () => go)
    await s.executeMissedRuns(missed)
    expect(execute).toHaveBeenCalledOnce()
    await s.stop()
  })
})

describe("a live fire after the goal check's await", () => {
  it("paused while the goal check awaits: not run", async () => {
    const { s, execute } = await scheduler()
    s.goalHold = vi.fn(async () => { s.jobs.get("j").enabled = false; return go })
    await s.executeJob("j")
    expect(execute).not.toHaveBeenCalled()
    await s.stop()
  })
})
