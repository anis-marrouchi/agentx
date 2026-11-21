import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { BatteryReading } from "../src/sensors/battery"
import { sensorSchema } from "../src/sensors/config"
import { SensorRunner, type WakeRequest } from "../src/sensors/runner"
import { readingText, recentSensorRuns, writeSensorRun, type SensorRunRow } from "../src/sensors/run-record"
import { readCronRunHistory, clearCronRunHistoryCache } from "../src/crons/run-history"
import { sensorsView } from "../src/crons/schedule-view"
import { SCRIPT_LEVELS } from "./fixtures/sensor-levels"

// #863 v2.1: each sensor wake is a run-history row with kind "sensor",
// shown with the last reading on the Wall and in Settings › Schedules.

const T0 = Date.parse("2030-05-01T10:00:00Z")
const cfg = sensorSchema.parse(SCRIPT_LEVELS)

let dir: string
let runsDir: string
let now: number
let reading: BatteryReading
let rows: SensorRunRow[]
let mode: "start" | "fail" | "hold"
let runner: SensorRunner

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-sensor-rows-"))
  runsDir = join(dir, ".agentx", "cron", "runs")
  now = T0
  rows = []
  mode = "start"
  reading = { ok: true, percent: 45, onBattery: true, onAC: false }
  runner = new SensorRunner({
    sensors: () => ({ battery: cfg }),
    read: async () => reading,
    wake: (w: WakeRequest) => {
      if (mode === "fail") return Promise.resolve({ error: "Agent not started: no room" })
      if (mode === "hold") return new Promise((resolve) => w.signal.addEventListener("abort", () => resolve({ error: "caller gone" })))
      w.onStart()
      now += 30_000
      return Promise.resolve({})
    },
    push: async () => ({ ok: true, reason: "sent" }),
    wall: () => {},
    record: (row) => { rows.push(row); writeSensorRun(runsDir, row) },
    log: () => {},
    stateFile: join(dir, ".agentx", "state", "sensors.json"),
    now: () => now,
  })
})
afterEach(() => {
  runner.stop()
  rmSync(dir, { recursive: true, force: true })
})

const settle = async () => { await runner.idle(); for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); await runner.idle() }

describe("sensor wakes as run rows", () => {
  it("a started wake is one row: kind sensor, level, target, the reading, its duration", async () => {
    await runner.readOnce("battery")
    await settle()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ jobId: "sensor-battery", kind: "sensor", sensor: "battery", level: "below-50", target: "ops-agent", reading: "battery 45 %, on battery", success: true, duration: 30_000 })
  })

  it("a failed wake is a failed row", async () => {
    mode = "fail"
    await runner.readOnce("battery")
    await settle()
    expect(rows[0]).toMatchObject({ success: false, error: "Agent not started: no room" })
  })

  it("the day's run history reads the row, marked as a sensor's", async () => {
    await runner.readOnce("battery")
    await settle()
    clearCronRunHistoryCache()
    const runs = await readCronRunHistory({ date: "2030-05-01", runsDir })
    expect(runs).toEqual([expect.objectContaining({ jobId: "sensor-battery", kind: "sensor", level: "below-50", reading: "battery 45 %, on battery", status: "success" })])
  })

  it("the view shows the last reading and the newest wakes", async () => {
    await runner.readOnce("battery")
    await settle()
    const view = sensorsView(dir, { battery: cfg })
    expect(view).toEqual([expect.objectContaining({ id: "battery", reading: "battery", every: "60s", last: "battery 45 %, on battery", lastAt: T0 })])
    expect(view[0].targets).toContain("push")
    expect(view[0].wakes).toEqual([expect.objectContaining({ level: "below-50", target: "ops-agent", ok: true })])
  })
})

describe("run-record helpers", () => {
  it("words a reading", () => {
    expect(readingText(undefined)).toBe("no reading yet")
    expect(readingText({ ok: false, why: "no battery on this machine" })).toBe("unavailable: no battery on this machine")
    expect(readingText({ ok: true, percent: 80, onBattery: false, onAC: true })).toBe("battery 80 %, on AC")
  })

  it("reads the newest rows first and skips broken files", () => {
    const base: SensorRunRow = { jobId: "sensor-b", kind: "sensor", sensor: "b", level: "l", target: "t", reading: "r", startedAt: "", completedAt: "", duration: 0, success: true }
    for (const at of ["2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z"]) writeSensorRun(runsDir, { ...base, startedAt: at, completedAt: at })
    mkdirSync(join(runsDir, "sensor-b"), { recursive: true })
    writeFileSync(join(runsDir, "sensor-b", "2030-01-03T00-00-00-000Z.json"), "{broken")
    expect(recentSensorRuns(runsDir, "b").map((r) => r.startedAt)).toEqual(["2030-01-02T00:00:00.000Z", "2030-01-01T00:00:00.000Z"])
  })
})
