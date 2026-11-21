import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"
import { emptyState, type SensorState } from "./levels"

// --- Sensor state on disk (#863) ---
//
// `.agentx/state/sensors.json`, one entry per sensor id: the stretch, what
// each level has sent, the last reading. Not in agentx.json: a write there
// reloads the daemon. A wake still waiting at a restart was dropped with
// the daemon's queue, so it is read back as not sent and goes again.

export type SensorStates = Record<string, SensorState>

export function loadSensorStates(file: string, log: (m: string) => void): SensorStates {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<SensorState>>
    const out: SensorStates = {}
    for (const [id, s] of Object.entries(raw ?? {})) {
      const base = emptyState()
      const levels = Object.fromEntries(Object.entries(s?.levels ?? {}).map(([k, v]) => [k, { ...v, pending: undefined }]))
      out[id] = { ...base, ...s, levels, seq: Number(s?.seq) || 0 }
    }
    return out
  } catch (e: any) {
    log(`[sensors] ${file} could not be read, starting fresh: ${e?.message ?? e}`)
    return {}
  }
}

/** Written whole, through a temporary file, so a crash never leaves half. */
export function saveSensorStates(file: string, states: SensorStates): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(states, null, 2) + "\n")
  renameSync(tmp, file)
}
