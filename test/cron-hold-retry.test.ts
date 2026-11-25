import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { readRecentCronRuns, clearCronRunHistoryCache } from "../src/crons/run-history"
import { daemonConfigSchema } from "../src/daemon/config"
import { holdRetryAt, missedRunText, runHold, HOLD_RETRY_MARGIN_MS, HOLD_RECHECK_MS, MAX_HOLD_RETRIES } from "../src/crons/hold-retry"
import { failStreak } from "../src/daemon/routines"
import { wsLast } from "../src/daemon/ui/pages/wall-schedules"

// #2247: a scheduled run held by a plan or usage limit, or a full machine,
// retried on a 30 s … 60 min ladder that ended long before the hold did,
// and the job lost its day with only a log line to show for it.

const PLAN = "Claude plan limit reached: Claude Code reports the five hour window as rejected. " +
  "Cold dispatches are held until it resets in about 149 min (2026-11-20T11:00:00.000Z); open conversations still go through."
const CODEX = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:30 PM."
const NO_ROOM = "I could not start this request: the machine that runs me is short of free memory, and that lasted too long. It is no longer in the queue. Please send it again."

describe("runHold", () => {
  const now = Date.parse("2026-11-20T08:30:00Z")

  it("reads a plan hold's end from retryAt, else from the message", () => {
    expect(runHold({ error: PLAN, errorKind: "dispatch_hold", retryAt: Date.parse("2026-11-20T11:00:00Z") }, now))
      .toEqual({ cause: "plan limit", until: Date.parse("2026-11-20T11:00:00Z") })
    expect(runHold({ error: PLAN, errorKind: "dispatch_hold" }, now))
      .toEqual({ cause: "plan limit", until: Date.parse("2026-11-20T11:00:00Z") })
  })

  it("reads the Codex 'try again at' time as the next such time on this machine's clock", () => {
    const hold = runHold({ error: CODEX }, now)!
    expect(hold.cause).toBe("usage limit")
    const at = new Date(hold.until!)
    expect([at.getHours(), at.getMinutes()]).toEqual([13, 30])
    expect(hold.until! > now && hold.until! - now <= 24 * 3600_000).toBe(true)
  })

  it("marks a run refused for no room as held with no known end", () => {
    expect(runHold({ error: NO_ROOM, errorKind: "no_room" }, now)).toEqual({ cause: "no room on the machine" })
  })

  it("leaves other failures to the normal retries", () => {
    expect(runHold({ error: "API Error: 500 internal" }, now)).toBeNull()
    expect(runHold({ error: "timed out", errorKind: "timeout" }, now)).toBeNull()
    expect(runHold({}, now)).toBeNull()
  })

  it("retries after the hold's end, or after a recheck, only inside the window", () => {
    const end = now + 10 * 3600_000
    expect(holdRetryAt({ cause: "plan limit", until: now + 3600_000 }, now, end)).toBe(now + 3600_000 + HOLD_RETRY_MARGIN_MS)
    expect(holdRetryAt({ cause: "no room on the machine" }, now, end)).toBe(now + HOLD_RECHECK_MS)
    expect(holdRetryAt({ cause: "plan limit", until: end }, now, end)).toBeNull()
  })

  it("names the job, the cause and the next run when a run is missed", () => {
    const t = missedRunText("daily-wake", "held by usage limit", { nextRun: new Date("2026-11-25T08:30:00Z") })
    expect(t).toContain('"daily-wake" did not run: held by usage limit.')
    expect(t).toContain("Next regular run: 2026-11-25T08:30:00.000Z")
  })
})

describe("the retryWindowMinutes setting", () => {
  it("is accepted on a cron", () => {
    const parsed = daemonConfigSchema.parse({
      node: { id: "t", name: "T", bind: "127.0.0.1:0" },
      agents: { a: { name: "A", workspace: "./a", tier: "claude-code" } },
      crons: { j: { enabled: true, schedule: "30 8 * * *", agent: "a", prompt: "p", retryWindowMinutes: 450 } },
    } as any)
    expect(parsed.crons.j.retryWindowMinutes).toBe(450)
  })
})

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-cron-hold-"))
  process.chdir(dir)
  clearCronRunHistoryCache()
})
afterEach(() => {
  vi.useRealTimers()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const job = (extra: Record<string, unknown> = {}) => ({
  enabled: true, schedule: "30 8 * * *", timezone: "UTC", agent: "sales-agent",
  prompt: "Send today's planned messages.", timeout: 30, onError: ["log"], ...extra,
})

function setup(def: Record<string, unknown>, responses: Array<Record<string, unknown>>) {
  const execute = vi.fn(async (_task: any) => ({ duration: 5, content: "", ...(responses.shift() ?? { content: "done" }) }))
  const notices = { add: vi.fn() }
  const registry = { execute, notices, getAgent: (id: string) => (["sales-agent", "pm-agent"].includes(id) ? {} : undefined) }
  const s: any = new CronScheduler({ crons: { wake: def }, agents: {}, notifications: {} } as any, registry as any, undefined, () => {})
  s.running = true
  const nextRegular = vi.fn()
  s.scheduleNext = nextRegular
  const notify = vi.fn(async () => {})
  s.setNotifyCallback(notify)
  return { s, execute, notices, notify, nextRegular }
}

function runRecords(): any[] {
  const d = join(dir, ".agentx/cron/runs/wake")
  if (!existsSync(d)) return []
  return readdirSync(d).sort().map((n) => JSON.parse(readFileSync(join(d, n), "utf-8")))
}

describe("a scheduled run that is held", () => {
  it("runs again after the plan window resets, without counting as a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-20T08:30:00Z"))
    const reset = Date.parse("2026-11-20T11:00:00Z")
    const { s, execute, notices, nextRegular } = setup(job(), [
      { error: PLAN, errorKind: "dispatch_hold", retryAt: reset },
    ])
    await s.executeJob("wake")
    const state = s.jobs.get("wake")
    expect(state.consecutiveErrors).toBe(0)
    expect(state.retryPending).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)

    // Nothing runs before the reset (the old ladder would have run 5 times).
    await vi.advanceTimersByTimeAsync(reset - Date.now() - 1000)
    expect(execute).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOLD_RETRY_MARGIN_MS + 2000)
    expect(execute).toHaveBeenCalledTimes(2)

    expect(notices.add).not.toHaveBeenCalled()
    expect(nextRegular).toHaveBeenCalledTimes(1)
    expect(state.missedAt).toBeUndefined()
    const recs = runRecords()
    expect(recs.map((r) => [r.success, r.held === true])).toEqual([[false, true], [true, false]])
    expect(recs[0].heldUntil).toBe("2026-11-20T11:00:00.000Z")
    const recent = await readRecentCronRuns({ perJob: 5 })
    expect(recent.get("wake")!.map((r) => r.status)).toEqual(["success", "held"])
  })

  it("retries a Codex 'try again at' hold at that time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-24T08:30:00Z"))
    const { s, execute } = setup(job(), [{ error: CODEX }])
    await s.executeJob("wake")
    const until = runHold({ error: CODEX })!.until!
    await vi.advanceTimersByTimeAsync(until - Date.now() + HOLD_RETRY_MARGIN_MS + 1000)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("retries a run refused for no room once the machine has had time to clear", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-23T08:30:00Z"))
    const { s, execute } = setup(job(), [{ error: NO_ROOM, errorKind: "no_room" }])
    await s.executeJob("wake")
    await vi.advanceTimersByTimeAsync(HOLD_RECHECK_MS + 1000)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("is reported as missed to its owner and creator when the hold outlasts its window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-24T08:30:00Z"))
    const { s, execute, notices, notify, nextRegular } = setup(
      job({ retryWindowMinutes: 60, createdBy: "pm-agent" }),
      [{ error: PLAN.replace("2026-11-20T11:00", "2026-11-24T13:30"), errorKind: "dispatch_hold" }],
    )
    await s.executeJob("wake")
    expect(execute).toHaveBeenCalledTimes(1)
    expect(nextRegular).toHaveBeenCalledTimes(1)
    expect(notices.add.mock.calls.map((c) => c[0])).toEqual(["sales-agent", "pm-agent"])
    expect(notices.add.mock.calls[0][2]).toContain('"wake" did not run')
    expect(notify).toHaveBeenCalledTimes(1)
    const state = s.jobs.get("wake")
    expect(state.missedAt).toBeInstanceOf(Date)
    expect(s.health().jobs[0].status).toBe("missed")
    expect(runRecords()[0]).toEqual(expect.objectContaining({ held: true, missed: true }))
    const recent = await readRecentCronRuns({ perJob: 5 })
    expect(recent.get("wake")![0].status).toBe("missed")
  })

  it("stops after MAX_HOLD_RETRIES and reports the run missed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-23T08:30:00Z"))
    const held = Array.from({ length: MAX_HOLD_RETRIES + 1 }, () => ({ error: NO_ROOM, errorKind: "no_room" }))
    const { s, execute, notices } = setup(job(), held)
    await s.executeJob("wake")
    for (let i = 0; i < MAX_HOLD_RETRIES; i++) await vi.advanceTimersByTimeAsync(HOLD_RECHECK_MS + 1000)
    expect(execute).toHaveBeenCalledTimes(MAX_HOLD_RETRIES + 1)
    expect(notices.add).toHaveBeenCalledTimes(1)
  })

  it("is not retried when fired on demand: the caller decides", async () => {
    const { s, execute, notices } = setup(job(), [{ error: PLAN, errorKind: "dispatch_hold" }])
    await s.executeJob("wake", 0, { firedAt: new Date(), payload: {} })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(s.jobs.get("wake").holdRetryPending).toBeFalsy()
    expect(notices.add).not.toHaveBeenCalled()
  })
})

describe("a hold retry that does not happen", () => {
  it("does not hand its window to the next regular run", () => {
    const { s } = setup(job(), [])
    const state = s.jobs.get("wake")
    state.holdRetryPending = true
    // The real scheduleNext: what a hook block, a goal hold or a pause calls.
    CronScheduler.prototype["scheduleNext" as keyof CronScheduler].call(s, "wake")
    expect(state.holdRetryPending).toBe(false)
    s.stop()
  })

  it("survives a restart: the held slot is caught up as a missed run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-24T08:30:00.400Z"))
    const { s } = setup(job(), [{ error: NO_ROOM, errorKind: "no_room" }])
    await s.executeJob("wake")
    expect(s.jobs.get("wake").holdRetryPending).toBe(true)
    // While this process waits for the retry, the run is not counted missed.
    expect(s.detectMissedRuns()).toEqual([])
    await s.stop()
    vi.setSystemTime(new Date("2026-11-24T08:40:00Z"))
    const { s: next } = setup(job(), [])
    const missed = next.detectMissedRuns()
    expect(missed.map((m: any) => [m.jobId, m.missedAt.toISOString()])).toEqual([["wake", "2026-11-24T08:30:00.000Z"]])
  })

  it("a caught-up run still held is retried when the hold ends, not counted as a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"))
    const reset = Date.parse("2026-11-24T13:00:00Z")
    const { s, execute, notices } = setup(job(), [{ error: PLAN, errorKind: "dispatch_hold", retryAt: reset }])
    s.stillDue = async () => true
    await s.executeMissedRuns([{ jobId: "wake", missedAt: new Date("2026-11-24T08:30:00Z") }])
    const state = s.jobs.get("wake")
    expect(state.consecutiveErrors).toBe(0)
    expect(state.holdRetryPending).toBe(true)
    expect(notices.add).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(reset - Date.now() + HOLD_RETRY_MARGIN_MS + 1000)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(state.windowStart.toISOString()).toBe("2026-11-24T08:30:00.000Z")
  })

  it("a caught-up run held past its window is recorded and reported as missed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"))
    const { s, notices } = setup(job({ retryWindowMinutes: 120 }), [
      { error: PLAN, errorKind: "dispatch_hold", retryAt: Date.parse("2026-11-24T13:00:00Z") },
    ])
    s.stillDue = async () => true
    await s.executeMissedRuns([{ jobId: "wake", missedAt: new Date("2026-11-24T08:30:00Z") }])
    const state = s.jobs.get("wake")
    expect(state.consecutiveErrors).toBe(0)
    expect(state.missedAt?.toISOString()).toBe("2026-11-24T08:30:00.000Z")
    expect(notices.add).toHaveBeenCalledTimes(1)
    expect(runRecords()[0]).toEqual(expect.objectContaining({ held: true, missed: true }))
  })

  it("a one-time job with a pending hold retry is run again after a restart, not retired", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date("2026-11-24T08:30:00Z"))
    const once = job({ runAt: "2026-11-24T08:30:00Z" })
    const { s } = setup(once, [{ error: NO_ROOM, errorKind: "no_room" }])
    await s.executeJob("wake")
    // Saved at once (a crash has no stop()).
    const saved = JSON.parse(readFileSync(s.lastRunFile, "utf-8"))
    expect(Date.parse(saved.wake)).toBeLessThan(Date.parse("2026-11-24T08:30:00Z"))
  })
})

describe("a run that fails all its retries", () => {
  it("does not send the notify chat a second message after its failure alert", async () => {
    const { s, notices, notify } = setup(job({ onError: ["notify"] }), [])
    s.jobs.get("wake").lastError = "API Error: 500"
    s.scheduleRetry("wake", 5)
    await Promise.resolve()
    expect(notices.add).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it("tells the owner the run was missed", async () => {
    const { s, notices, notify } = setup(job(), [])
    s.jobs.get("wake").lastError = "API Error: 500"
    s.scheduleRetry("wake", 5)
    await Promise.resolve()
    expect(notices.add).toHaveBeenCalledTimes(1)
    expect(notices.add.mock.calls[0][2]).toContain("it failed 6 times (API Error: 500)")
    await Promise.resolve()
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe("held and missed runs in the views", () => {
  it("skip held runs and count missed ones in the fail streak", () => {
    expect(failStreak([{ status: "held" }, { status: "missed" }, { status: "failed" }, { status: "success" }])).toBe(2)
  })
  it("read as Held and Missed on the schedules wall", () => {
    const esc = (x: string) => x
    expect(wsLast({ status: "missed" }, esc, () => "").html).toContain("Missed")
    expect(wsLast({ status: "missed" }, esc, () => "").failed).toBe(true)
    expect(wsLast({ status: "held" }, esc, () => "").html).toContain("Held, retry waiting")
  })
})
