import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readBootLog, recordBootEntry, type BootEntry } from "../src/daemon/boot-record"
import {
  appendEvent, canaryReport, deployDecision, evaluateSoak, readEvents, readReleases, recordSoak,
  recordedSoak, releaseRuns, sameCommit,
  type CanarySettings, type TaskCounter, type TaskCounts,
} from "../src/daemon/canary-soak"
import { daemonConfigSchema } from "../src/daemon/config"

const MIN = 60_000
const T0 = Date.parse("2026-10-17T08:00:00Z")
const settings: CanarySettings = {
  enabled: true,
  soakMinutes: 120,
  thresholds: { maxRestarts: 1, maxCrashes: 0, maxFailedTasks: 3, maxErrorRateIncrease: 0.1, minTasksForRate: 10 },
}
const crashLoop = { restarts: 3, windowMinutes: 10 }

const clean = (at: number, commit: string | null): BootEntry => ({ at, by: "agentx daemon restart", reason: "SIGTERM", commit, version: "1.0.0" })
const crash = (at: number, commit: string | null): BootEntry => ({ at, by: null, reason: null, commit, version: "1.0.0" })

/** Tasks per window: the previous release's run, then the soak. */
function counter(prev: TaskCounts | null, soak: TaskCounts | null, soakStart = T0): TaskCounter {
  return (from) => (from >= soakStart ? soak : prev)
}

const judge = (boots: BootEntry[], now: number, tasks: TaskCounter = counter({ total: 0, failed: 0 }, { total: 0, failed: 0 })) =>
  evaluateSoak({ commit: "bbbbbbb", boots, now, settings, crashLoop, tasks })

describe("canary soak rules", () => {
  const prevRun = [clean(T0 - 600 * MIN, "aaaaaaa")]

  it("is not started when the commit never ran here", () => {
    const r = judge(prevRun, T0)
    expect(r.status).toBe("not-started")
    expect(deployDecision(settings, "bbbbbbb", r).allow).toBe(false)
  })

  it("soaks, with the time left, until soakMinutes have passed", () => {
    const r = judge([...prevRun, clean(T0, "bbbbbbb")], T0 + 45 * MIN)
    expect(r.status).toBe("soaking")
    expect(r.remainingMinutes).toBe(75)
    const d = deployDecision(settings, "bbbbbbb", r)
    expect(d.allow).toBe(false)
    expect(d.message).toContain("75 min left")
  })

  it("passes after a quiet soak", () => {
    const r = judge([...prevRun, clean(T0, "bbbbbbb")], T0 + 121 * MIN, counter({ total: 50, failed: 5 }, { total: 20, failed: 2 }))
    expect(r.status).toBe("passed")
    expect(r.checks.every((c) => c.ok !== false)).toBe(true)
    expect(deployDecision(settings, "bbbbbbb", r)).toMatchObject({ allow: true, overridden: false })
  })

  it("only judges the soak window: trouble after it does not count", () => {
    const boots = [...prevRun, clean(T0, "bbbbbbb"), crash(T0 + 200 * MIN, "bbbbbbb")]
    expect(judge(boots, T0 + 300 * MIN).status).toBe("passed")
  })

  it("fails on an unclean stop", () => {
    const r = judge([...prevRun, clean(T0, "bbbbbbb"), crash(T0 + 30 * MIN, "bbbbbbb")], T0 + 40 * MIN)
    expect(r.status).toBe("failed")
    expect(r.checks.find((c) => c.name === "crashes")?.ok).toBe(false)
    expect(deployDecision(settings, "bbbbbbb", r).message).toContain("crashes")
  })

  it("allows maxRestarts clean restarts, fails past them", () => {
    const one = [...prevRun, clean(T0, "bbbbbbb"), clean(T0 + 30 * MIN, "bbbbbbb")]
    expect(judge(one, T0 + 121 * MIN).status).toBe("passed")
    const two = [...one, clean(T0 + 60 * MIN, "bbbbbbb")]
    const r = judge(two, T0 + 121 * MIN)
    expect(r.status).toBe("failed")
    expect(r.checks.find((c) => c.name === "restarts")?.ok).toBe(false)
  })

  it("fails on a crash loop", () => {
    const boots = [...prevRun, clean(T0, "bbbbbbb"), clean(T0 + 2 * MIN, "bbbbbbb"), clean(T0 + 4 * MIN, "bbbbbbb")]
    const r = evaluateSoak({ commit: "bbbbbbb", boots, now: T0 + 5 * MIN, crashLoop, tasks: counter(null, { total: 0, failed: 0 }),
      settings: { ...settings, thresholds: { ...settings.thresholds, maxRestarts: 5 } } })
    expect(r.status).toBe("failed")
    expect(r.checks.find((c) => c.name === "crash-loop")?.ok).toBe(false)
  })

  it("fails past maxFailedTasks", () => {
    const r = judge([...prevRun, clean(T0, "bbbbbbb")], T0 + 30 * MIN, counter(null, { total: 6, failed: 4 }))
    expect(r.status).toBe("failed")
    expect(r.reason).toContain("failed-tasks (4 of 6 task(s) failed")
  })

  it("fails when the error rate rises more than allowed vs the previous release", () => {
    const loose = { ...settings, thresholds: { ...settings.thresholds, maxFailedTasks: 100 } }
    const run = (soak: TaskCounts) => evaluateSoak({
      commit: "bbbbbbb", boots: [...prevRun, clean(T0, "bbbbbbb")], now: T0 + 121 * MIN, settings: loose, crashLoop,
      tasks: counter({ total: 100, failed: 5 }, soak),
    })
    expect(run({ total: 20, failed: 3 }).status).toBe("passed") // 15% vs 5%: +10 points, allowed
    const r = run({ total: 20, failed: 4 }) // 20% vs 5%
    expect(r.status).toBe("failed")
    expect(r.checks.find((c) => c.name === "error-rate")?.ok).toBe(false)
  })

  it("skips the rate check with too few tasks or no baseline", () => {
    const few = judge([...prevRun, clean(T0, "bbbbbbb")], T0 + 121 * MIN, counter({ total: 100, failed: 0 }, { total: 3, failed: 2 }))
    expect(few.checks.find((c) => c.name === "error-rate")?.ok).toBeNull()
    expect(few.status).toBe("passed")
    const first = judge([clean(T0, "bbbbbbb")], T0 + 121 * MIN, counter(null, { total: 30, failed: 3 }))
    expect(first.checks.find((c) => c.name === "error-rate")?.detail).toContain("no tasks on the previous release")
    expect(first.status).toBe("passed")
  })

  it("cannot pass without task history", () => {
    const r = judge([...prevRun, clean(T0, "bbbbbbb")], T0 + 121 * MIN, () => null)
    expect(r.status).toBe("failed")
    expect(r.reason).toContain("task history unavailable")
  })

  it("is interrupted when another commit replaced it before the soak ended", () => {
    const boots = [...prevRun, clean(T0, "bbbbbbb"), clean(T0 + 30 * MIN, "ccccccc")]
    const r = judge(boots, T0 + 200 * MIN)
    expect(r.status).toBe("interrupted")
    expect(r.reason).toContain("30 of 120 min")
  })

  it("judges the latest run of a commit that ran twice", () => {
    const boots = [...prevRun, clean(T0 - 300 * MIN, "bbbbbbb"), clean(T0 - 280 * MIN, "ccccccc"), clean(T0, "bbbbbbb")]
    const r = judge(boots, T0 + 10 * MIN)
    expect(r.status).toBe("soaking")
    expect(r.startedAt).toBe(new Date(T0).toISOString())
  })

  it("groups boots into runs and matches short and long SHAs", () => {
    const runs = releaseRuns([crash(1, null), clean(2, "aaaaaaa"), clean(3, "aaaaaaa"), clean(4, "bbbbbbb")])
    expect(runs.map((r) => [r.commit, r.start, r.end, r.boots.length])).toEqual([[null, 1, 2, 1], ["aaaaaaa", 2, 4, 2], ["bbbbbbb", 4, null, 1]])
    expect(sameCommit("abc1234", "abc1234def")).toBe(true)
    expect(sameCommit("abc1234", "abc1235")).toBe(false)
    expect(sameCommit("abc1234-dirty", "abc1234")).toBe(false)
  })
})

describe("deploy decision", () => {
  const off = { ...settings, enabled: false }
  it("never blocks with the switch off", () => {
    expect(deployDecision(off, null, null)).toMatchObject({ allow: true, overridden: false })
  })
  it("refuses dirty or unknown builds", () => {
    expect(deployDecision(settings, null, null).allow).toBe(false)
    expect(deployDecision(settings, "abc1234-dirty", null).message).toContain("uncommitted")
  })
  it("lets a stated override through, marked as such", () => {
    const d = deployDecision(settings, "bbbbbbb", null, "  hotfix for an outage ")
    expect(d).toMatchObject({ allow: true, overridden: true })
    expect(d.message).toContain("hotfix for an outage")
    expect(deployDecision(settings, "bbbbbbb", null, "  ").allow).toBe(false)
  })
})

describe("ledger and boot log", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "canary-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("keeps the first decision per release and reports blocked releases", () => {
    const soaking = judge([clean(T0, "bbbbbbb")], T0 + 10 * MIN)
    expect(recordSoak(dir, soaking)).toBeNull()
    const passed = judge([clean(T0, "bbbbbbb")], T0 + 121 * MIN)
    expect(recordSoak(dir, passed)?.status).toBe("passed")
    const later = judge([clean(T0, "bbbbbbb"), crash(T0 + 30 * MIN, "bbbbbbb")], T0 + 200 * MIN)
    expect(recordSoak(dir, later)?.status).toBe("passed")
    expect(recordedSoak(dir, "bbbbbbb")?.decidedAt).toBe(new Date(T0 + 121 * MIN).toISOString())

    appendEvent(dir, { at: new Date(T0).toISOString(), type: "blocked", commit: "ccccccc", host: "remote", reason: "soaking" })
    appendEvent(dir, { at: new Date(T0 + MIN).toISOString(), type: "blocked", commit: "ccccccc", host: "remote", reason: "soaking" })
    appendEvent(dir, { at: new Date(T0 + 2 * MIN).toISOString(), type: "override", commit: "ccccccc", host: "remote", reason: "outage", by: "op" })
    const report = canaryReport(Object.values(readReleases(dir)), readEvents(dir))
    expect(report).toMatchObject({ passed: 1, failed: 0, blockedReleases: 1, blockedDeploys: 2, overrides: 1 })
    expect(canaryReport(Object.values(readReleases(dir)), readEvents(dir), T0 + 200 * MIN).blockedDeploys).toBe(0)
  })

  it("records the build each boot ran", () => {
    recordBootEntry(dir, T0, [], { commit: "aaaaaaa", version: "1.0.0" })
    recordBootEntry(dir, T0 + MIN)
    const log = readBootLog(dir)
    expect(log[0]).toEqual({ at: T0, by: null, reason: null, commit: "aaaaaaa", version: "1.0.0" })
    expect(log[1]).toEqual({ at: T0 + MIN, by: null, reason: null })
  })

  it("is off by default in config", () => {
    const q = daemonConfigSchema.shape.quality.parse(undefined).canary
    expect(q).toEqual({ enabled: false, soakMinutes: 120, thresholds: settings.thresholds })
  })
})
