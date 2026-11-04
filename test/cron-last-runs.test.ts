import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { clearCronRunHistoryCache } from "../src/crons/run-history"

// #1740: a restart rewrote last-runs.json from the jobs that had run since
// that start, so every other job lost its history and the next start could
// not see it had missed a run.

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-cron-last-"))
  process.chdir(dir)
  clearCronRunHistoryCache()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const job = { enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "ops-agent", prompt: "Report", timeout: 30, onError: ["log"] }

function scheduler(crons: Record<string, unknown>) {
  const registry = { execute: vi.fn(async () => ({ content: "done", duration: 5 })) }
  const s: any = new CronScheduler({ crons, agents: {}, notifications: {} } as any, registry as any, undefined, () => {})
  s.scheduleNext = () => {}
  s.scheduleRetry = () => {}
  s.running = true
  return s
}

const file = () => join(dir, ".agentx/cron/last-runs.json")
const read = () => JSON.parse(readFileSync(file(), "utf-8"))

function seed(data: Record<string, string>) {
  mkdirSync(join(dir, ".agentx/cron"), { recursive: true })
  writeFileSync(file(), JSON.stringify(data))
}

describe("last-run history across restarts (#1740)", () => {
  it("keeps the saved time of a job that has not run since this start", async () => {
    seed({ report: "2026-11-03T03:00:00.000Z", cards: "2026-11-03T03:00:00.000Z", gone: "2026-11-01T03:00:00.000Z" })
    const s = scheduler({ report: job, cards: job })
    await s.executeJob("report")
    const saved = read()
    expect(saved.cards).toBe("2026-11-03T03:00:00.000Z")
    expect(Date.parse(saved.report)).toBeGreaterThan(Date.parse("2026-11-03T03:00:00.000Z"))
    // A job no longer configured drops out.
    expect(saved.gone).toBeUndefined()
  })

  it("still sees the job's missed run on the start after that", async () => {
    seed({ report: "2026-11-03T03:00:00.000Z", cards: "2026-11-03T03:00:00.000Z" })
    const first = scheduler({ report: job, cards: job })
    await first.executeJob("report")
    await first.stop()
    const second = scheduler({ report: job, cards: job })
    const missed = second.detectMissedRuns().map((m: { jobId: string }) => m.jobId)
    expect(missed).toContain("cards")
    expect(second.health().missed).toBeGreaterThanOrEqual(1)
  })
})
