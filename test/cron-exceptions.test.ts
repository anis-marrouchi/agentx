import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { buildScheduleJob, notifyScope } from "../src/crons/schedule-ops"
import { parseEnglishToCron } from "../src/utils/nl-cron"
import { daemonConfigSchema } from "../src/daemon/config"
import { isQuietAnswer, NOTHING_TO_REPORT, withQuietRule } from "../src/crons/quiet"
import {
  exceptionsDigestText,
  lastDueFire,
  pausedAgents,
  requestExceptions,
  runExceptionsDigest,
  scheduleExceptions,
  windowStart,
  type DigestJob,
} from "../src/crons/exceptions-digest"

// #1289: schedules report only exceptions.
//   - `report: "exceptions"`: the run decides; a quiet answer sends nothing.
//   - One daily digest lists only what is wrong: failed or missed schedules,
//     stuck requests, paused agents. Nothing wrong, nothing sent.
//   - A failed or missed run shows up in the next digest (one cycle).

const HOUR = 3_600_000
let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-cron-exceptions-"))
  process.chdir(dir)
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

describe("the quiet answer", () => {
  it("accepts the word, with markdown, a full stop or other case", () => {
    for (const t of [NOTHING_TO_REPORT, " NOTHING_TO_REPORT\n", "`NOTHING_TO_REPORT`", "**NOTHING_TO_REPORT.**", "nothing_to_report"]) {
      expect(isQuietAnswer(t), t).toBe(true)
    }
  })
  it("refuses any other words", () => {
    for (const t of ["", undefined, "NOTHING_TO_REPORT but the disk is 95% full", "Nothing to report", "All good"]) {
      expect(isQuietAnswer(t as string), String(t)).toBe(false)
    }
  })
  it("is asked for only in exceptions mode", () => {
    expect(withQuietRule("Check the backups")).toBe("Check the backups")
    expect(withQuietRule("Check the backups", "always")).toBe("Check the backups")
    expect(withQuietRule("Check the backups", "exceptions")).toContain(`reply with exactly ${NOTHING_TO_REPORT}`)
  })
})

const notify = { channel: "telegram", chatId: "2000" }
const job = (extra: Record<string, unknown> = {}) => ({
  enabled: true, schedule: "0 9 * * *", timezone: "UTC", agent: "ops-agent",
  prompt: "Check the backups", timeout: 30, onError: ["log"], notify, ...extra,
})

function run(def: Record<string, unknown>, response: Record<string, unknown>) {
  const registry = { execute: vi.fn(async (_task: any) => ({ duration: 5, ...response })) }
  const s: any = new CronScheduler({ crons: { checks: def }, agents: {}, notifications: {} } as any, registry as any, undefined, () => {})
  s.scheduleNext = () => {}
  s.scheduleRetry = () => {}
  s.running = true
  const deliver = vi.fn(async () => {})
  s.setDeliverCallback(deliver)
  return { s, registry, deliver, go: () => s.executeJob("checks") }
}

function runRecords(): any[] {
  const d = join(dir, ".agentx/cron/runs/checks")
  if (!existsSync(d)) return []
  return readdirSync(d).map((n) => JSON.parse(readFileSync(join(d, n), "utf-8")))
}

describe("a schedule set to report only exceptions", () => {
  it("asks the run for the quiet answer and sends nothing when it gives it", async () => {
    const { registry, deliver, go } = run(job({ report: "exceptions" }), { content: NOTHING_TO_REPORT })
    await go()
    expect(registry.execute.mock.calls[0][0].message).toContain(NOTHING_TO_REPORT)
    expect(deliver).not.toHaveBeenCalled()
    expect(runRecords()).toEqual([expect.objectContaining({ success: true, quiet: true })])
  })

  it("sends the answer when the run reports a problem", async () => {
    const { deliver, go } = run(job({ report: "exceptions" }), { content: "Backup of db-1 is 3 days old" })
    await go()
    expect(deliver).toHaveBeenCalledWith("checks", "ops-agent", "Backup of db-1 is 3 days old", expect.any(String))
    expect(runRecords()[0].quiet).toBeUndefined()
  })

  it("a command job that prints the word sends nothing either", async () => {
    const { deliver, go } = run(job({ report: "exceptions", prompt: undefined, command: `echo ${NOTHING_TO_REPORT}` }), {})
    await go()
    expect(deliver).not.toHaveBeenCalled()
    expect(runRecords()[0]).toMatchObject({ success: true, quiet: true })
  })

  it("a quiet answer stays quiet on a job that also requires sources (#1288)", async () => {
    const { deliver, go } = run(job({ report: "exceptions", requireSources: true }), { content: NOTHING_TO_REPORT })
    await go()
    expect(deliver).not.toHaveBeenCalled()
    expect(runRecords()[0]).toMatchObject({ success: true, quiet: true })
    expect(runRecords()[0].unsourced).toBeUndefined()
  })

  it("without the setting, every answer is sent as before", async () => {
    const { registry, deliver, go } = run(job(), { content: NOTHING_TO_REPORT })
    await go()
    expect(registry.execute.mock.calls[0][0].message).not.toContain(NOTHING_TO_REPORT)
    expect(deliver).toHaveBeenCalled()
  })

  it("is written by the schedule builder and kept by the schema", () => {
    const parsed = parseEnglishToCron("every day at 9am")!
    const base = { parsed, agent: "ops-agent", prompt: "p", notify }
    expect(buildScheduleJob(base).report).toBeUndefined()
    expect(buildScheduleJob({ ...base, report: "always" }).report).toBeUndefined()
    const quiet = buildScheduleJob({ ...base, report: "exceptions" })
    expect(quiet.report).toBe("exceptions")
    expect(notifyScope(quiet)).toBe("(exceptions and failures)")
    expect(notifyScope({ ...quiet, deliverResult: false })).toBe("(failures only)")

    const cfg = daemonConfigSchema.parse({
      node: { id: "t", name: "T", bind: "127.0.0.1:0" },
      agents: { "ops-agent": { name: "Ops", workspace: "./a", tier: "claude-code" } },
      crons: { checks: quiet },
    })
    expect(cfg.crons.checks.report).toBe("exceptions")
    expect(cfg.exceptionsDigest).toEqual({ enabled: false, time: "09:00" })
  })
})

// --- The digest ---

const NOW = Date.parse("2026-10-25T10:00:00.000Z")

function writeRun(jobId: string, startedAt: string, success: boolean, error?: string) {
  const d = join(dir, ".agentx/cron/runs", jobId)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify({
    jobId, startedAt, completedAt: startedAt, duration: 1000, success, ...(error ? { error } : {}),
  }))
}

const djob = (id: string, extra: Partial<DigestJob> = {}): DigestJob => ({
  id, agent: "ops-agent", enabled: true, schedule: "0 3 * * *", timezone: "UTC", timeout: 600, ...extra,
})

describe("schedule exceptions from the run files", () => {
  const since = NOW - 24 * HOUR

  it("lists a job whose latest run failed, and not one that recovered", async () => {
    writeRun("backup", "2026-10-25T03:00:00.000Z", false, "exit 2\ndisk full")
    writeRun("report", "2026-10-24T03:00:00.000Z", false, "boom")
    writeRun("report", "2026-10-25T03:00:00.000Z", true)
    const ex = await scheduleExceptions([djob("backup"), djob("report")], { since, now: NOW })
    expect(ex).toEqual([expect.objectContaining({ jobId: "backup", kind: "failed", detail: "failed: exit 2" })])
  })

  it("says when a failing job was switched off", async () => {
    writeRun("backup", "2026-10-25T03:00:00.000Z", false, "boom")
    const [e] = await scheduleExceptions([djob("backup", { enabled: false })], { since, now: NOW })
    expect(e.detail).toContain("now switched off")
  })

  it("lists a job that was due and did not run", async () => {
    // Ran yesterday at 03:00 but not today: due 03:00, well past its limit.
    writeRun("backup", "2026-10-24T03:00:00.000Z", true)
    const ex = await scheduleExceptions([djob("backup", { command: "true" })], { since, now: NOW })
    expect(ex).toEqual([expect.objectContaining({ jobId: "backup", kind: "missed", at: "2026-10-25T03:00:00.000Z" })])
  })

  it("does not call a run missed while it may still be running", async () => {
    // An agent run may take two hours: due 09:00, now 10:00, not late yet.
    writeRun("brief", "2026-10-24T09:00:00.000Z", true)
    const ex = await scheduleExceptions([djob("brief", { schedule: "0 9 * * *" })], { since, now: NOW })
    expect(ex).toEqual([])
  })

  it("skips a job that never ran, and a disabled job, for missed runs", async () => {
    writeRun("old", "2026-10-20T03:00:00.000Z", true)
    const ex = await scheduleExceptions([djob("new"), djob("old", { enabled: false })], { since, now: NOW })
    expect(ex).toEqual([])
  })

  it("finds the last due time in a window", () => {
    expect(lastDueFire("0 3 * * *", "UTC", since, NOW)?.toISOString()).toBe("2026-10-25T03:00:00.000Z")
    expect(lastDueFire("0 3 1 1 *", "UTC", since, NOW)).toBeNull()
    expect(lastDueFire("* * * * *", "UTC", since, NOW)?.toISOString()).toBe("2026-10-25T10:00:00.000Z")
  })

  it("covers at least a day, back to the last check, at most a week", () => {
    expect(windowStart(undefined, NOW)).toBe(NOW - 24 * HOUR)
    expect(windowStart(new Date(NOW - 3 * 24 * HOUR).toISOString(), NOW)).toBe(NOW - 3 * 24 * HOUR)
    expect(windowStart(new Date(NOW - 30 * 24 * HOUR).toISOString(), NOW)).toBe(NOW - 7 * 24 * HOUR)
    expect(windowStart(new Date(NOW - HOUR).toISOString(), NOW)).toBe(NOW - 24 * HOUR)
  })
})

describe("stuck requests and paused agents", () => {
  const req = (extra: Record<string, unknown>) => ({
    id: "r1", state: "in_progress", agentId: "ops-agent", text: "Renew the certificate", headline: null,
    dueAt: null, updatedAt: NOW - HOUR, attentionReason: null, ...extra,
  }) as any

  it("lists open requests the stalled rule calls stuck", () => {
    const items = [
      req({ id: "fresh" }),
      req({ id: "quiet", updatedAt: NOW - 30 * HOUR }),
      req({ id: "late", dueAt: NOW - HOUR, headline: "Certificate renewal" }),
      req({ id: "done", state: "done", updatedAt: NOW - 90 * HOUR }),
    ]
    const ex = requestExceptions(items, 24, NOW)
    expect(ex.map((e) => e.id)).toEqual(["quiet", "late"])
    expect(ex[1]).toMatchObject({ title: "Certificate renewal", why: expect.stringContaining("past its due time") })
  })

  it("lists agents and the fleet paused by budget", () => {
    const ex = pausedAgents({
      fleet: { spentUsd: 10, capUsd: 100, warnRatio: 0.8, state: "ok" },
      agents: [
        { agentId: "writer", spentUsd: 50, capUsd: 50, warnRatio: 0.8, state: "paused" },
        { agentId: "ops-agent", spentUsd: 5, capUsd: 50, warnRatio: 0.8, state: "ok" },
      ],
    } as any)
    expect(ex).toEqual([{ agentId: "writer", why: "monthly budget used ($50.00 of $50.00)" }])
  })

  it("has no text when nothing is wrong", () => {
    expect(exceptionsDigestText({ schedules: [], requests: [], agents: [] })).toBeNull()
  })
})

describe("the daily exceptions digest", () => {
  const settings = { enabled: true, time: "09:00", timezone: "UTC", destination: { channel: "telegram", chatId: "1" } }

  function digest(now: number, jobs: DigestJob[], extra: Record<string, unknown> = {}) {
    const send = vi.fn(async () => {})
    return {
      send,
      go: () => runExceptionsDigest({ settings, root: dir, jobs: () => jobs, send, now, log: () => {}, ...extra }),
    }
  }

  it("sends nothing when nothing is wrong", async () => {
    writeRun("backup", "2026-10-25T03:00:00.000Z", true)
    const { send, go } = digest(NOW, [djob("backup")], { budget: () => ({ agents: [], fleet: { spentUsd: 0, warnRatio: 0.8, state: "uncapped" } }) })
    expect(await go()).toBe("empty")
    expect(send).not.toHaveBeenCalled()
  })

  it("a failed run shows up in the next digest, once", async () => {
    // Day 1 digest: all fine.
    writeRun("backup", "2026-10-24T03:00:00.000Z", true)
    expect(await digest(NOW - 24 * HOUR, [djob("backup")]).go()).toBe("empty")
    // The next run fails; the next day's digest names it.
    writeRun("backup", "2026-10-25T03:00:00.000Z", false, "disk full")
    const day2 = digest(NOW, [djob("backup")])
    expect(await day2.go()).toBe("sent")
    expect(day2.send).toHaveBeenCalledWith(settings.destination, expect.stringContaining("backup (ops-agent): 2026-10-25 03:00 UTC, failed: disk full"))
    // Once a day: a minute later it is not sent again.
    const again = digest(NOW + 60_000, [djob("backup")])
    expect(await again.go()).toBe("not-due")
    expect(again.send).not.toHaveBeenCalled()
  })

  it("a missed run shows up in the next digest", async () => {
    writeRun("backup", "2026-10-24T03:00:00.000Z", true)
    const { send, go } = digest(NOW, [djob("backup", { command: "true" })])
    expect(await go()).toBe("sent")
    expect(send).toHaveBeenCalledWith(settings.destination, expect.stringContaining("backup (ops-agent): due 2026-10-25 03:00 UTC, did not run"))
  })

  it("lists stuck requests and paused agents beside schedules", async () => {
    const { send, go } = digest(NOW, [], {
      requests: () => ({ items: [{ id: "r1", state: "needs_attention", agentId: "ops-agent", text: "Renew the certificate", headline: null, dueAt: null, updatedAt: NOW, attentionReason: "the agent asked for a password" }], staleAfterHours: 24 }),
      budget: () => ({ agents: [{ agentId: "writer", spentUsd: 50, capUsd: 50, warnRatio: 0.8, state: "paused" }], fleet: { spentUsd: 50, warnRatio: 0.8, state: "uncapped" } }),
    })
    expect(await go()).toBe("sent")
    const text = (send.mock.calls[0] as any[])[1] as string
    expect(text).toContain("Stuck requests (1)\n- Renew the certificate (ops-agent): the agent asked for a password")
    expect(text).toContain("Paused agents (1)\n- writer: monthly budget used")
    expect(text).not.toContain("Schedules")
  })

  it("waits for its time, needs a destination, and is off unless enabled", async () => {
    expect(await digest(Date.parse("2026-10-25T08:59:00.000Z"), []).go()).toBe("not-due")
    const noDest = runExceptionsDigest({ settings: { ...settings, destination: undefined }, root: dir, jobs: () => [], send: async () => {}, now: NOW, log: () => {} })
    expect(await noDest).toBe("no-destination")
    const off = runExceptionsDigest({ settings: { ...settings, enabled: false }, root: dir, jobs: () => [], send: async () => {}, now: NOW, log: () => {} })
    expect(await off).toBe("disabled")
  })

  it("one source that throws does not stop the others", async () => {
    writeRun("backup", "2026-10-25T03:00:00.000Z", false, "boom")
    const { send, go } = digest(NOW, [djob("backup")], { requests: () => { throw new Error("db closed") } })
    expect(await go()).toBe("sent")
    expect((send.mock.calls[0] as any[])[1]).toContain("backup")
  })
})
