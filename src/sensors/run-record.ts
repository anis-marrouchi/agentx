import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { BatteryReading } from "./battery"

// --- A sensor wake as a run-history row (#863) ---
//
// Each wake a sensor level starts is one run record, beside the
// schedules' (`.agentx/cron/runs/sensor-<id>/<start>.json`), with
// `kind: "sensor"`, the level, the agent woken and the reading that crossed
// the line. The day's run history reads it like a schedule's run; the Wall
// and Settings › Schedules show it under the sensor with its last reading.

export interface SensorRunRow {
  jobId: string
  kind: "sensor"
  sensor: string
  level: string
  target: string
  reading: string
  startedAt: string
  completedAt: string
  duration: number
  success: boolean
  response?: string
  error?: string
}

/** The run-history directory name of a sensor. */
export const sensorJobId = (id: string) => `sensor-${id}`

/** One reading in a few words: "battery 14 %, on battery". */
export function readingText(r: (BatteryReading & { at?: number }) | undefined): string {
  if (!r) return "no reading yet"
  if (!r.ok) return `unavailable: ${r.why}`
  return `battery ${r.percent} %, ${r.onBattery ? "on battery" : r.onAC ? "on AC" : "power source unknown"}`
}

export function writeSensorRun(runsDir: string, row: SensorRunRow): void {
  const dir = resolve(runsDir, row.jobId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${row.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(row, null, 2))
}

/** A sensor's newest wakes, newest first. Unreadable files are skipped. */
export function recentSensorRuns(runsDir: string, id: string, limit = 5): SensorRunRow[] {
  const dir = resolve(runsDir, sensorJobId(id))
  if (!existsSync(dir)) return []
  const out: SensorRunRow[] = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort().reverse()) {
    if (out.length >= limit) break
    try {
      const row = JSON.parse(readFileSync(resolve(dir, name), "utf8"))
      if (row?.kind === "sensor") out.push(row)
    } catch { /* mid-write or corrupt: older rows still tell it */ }
  }
  return out
}
