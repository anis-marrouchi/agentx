import type Database from "better-sqlite3"
import { resolve } from "path"
import { loadSensorStates } from "@/sensors/state"
import { readingText, recentSensorRuns } from "@/sensors/run-record"
import { cronChanges, openChangeLedger, type CronChangeRow } from "./change-ledger"
import { goalWallLines, readCronGoalState, type JobGoalState } from "./goal-state"
import { expiredHostJobs, type HostJobLine } from "./host-jobs"

// --- What Settings › Schedules and the Wall show beside each job (#863) ---
//
// Read from files the daemon keeps, never from its memory, so the
// dashboard process can show them: the goal-check state (verdict, held,
// change owed), the change ledger, `until` / `endedAt` from agentx.json,
// the sensors with their last reading and wakes, and the allowed host jobs
// past their `until`.

export interface CronExtras {
  until?: string
  endedAt?: string
  lastVerdict?: JobGoalState["lastVerdict"]
  goalLines?: string[]
  /** The newest change-log rows, newest first. */
  changes?: Array<Pick<CronChangeRow, "field" | "old" | "new" | "by" | "reason" | "at">>
}

export interface SensorView {
  id: string
  reading: string
  every: string
  /** Who its levels wake, or "push" for a model-free level. */
  targets: string[]
  last: string
  lastAt: number | null
  wakes: Array<{ at: string; level: string; target: string; reading: string; ok: boolean; error?: string }>
}

const CHANGES_SHOWN = 5

/** Per job: until, endedAt, verdict, goal-check lines, change log. */
export function cronExtras(root: string, crons: Record<string, any> | undefined, opts: { ledger?: () => Database.Database | null; log?: (m: string) => void } = {}): Record<string, CronExtras> {
  let state: Record<string, JobGoalState> = {}
  try { state = readCronGoalState(root).jobs } catch (e: any) { opts.log?.(`[schedules] goal state unreadable: ${e?.message ?? e}`) }
  let db: Database.Database | null = null
  try { db = opts.ledger ? opts.ledger() : openChangeLedger(root) } catch { db = null }
  const out: Record<string, CronExtras> = {}
  for (const [id, c] of Object.entries(crons ?? {})) {
    const e: CronExtras = {}
    if (typeof c?.until === "string") e.until = c.until
    if (typeof c?.endedAt === "string") e.endedAt = c.endedAt
    const s = state[id]
    if (s?.lastVerdict) e.lastVerdict = s.lastVerdict
    const lines = s ? goalWallLines(s, String(c?.agent ?? "")) : []
    if (lines.length) e.goalLines = lines
    if (db) {
      try {
        const rows = cronChanges(db, id, CHANGES_SHOWN)
        if (rows.length) e.changes = rows.map(({ field, old, new: next, by, reason, at }) => ({ field, old, new: next, by, reason, at }))
      } catch { /* no ledger yet */ }
    }
    out[id] = e
  }
  return out
}

/** Each sensor with its last reading and newest wakes. */
export function sensorsView(root: string, sensors: Record<string, any> | undefined, log: (m: string) => void = () => {}): SensorView[] {
  const ids = Object.keys(sensors ?? {})
  if (!ids.length) return []
  const states = loadSensorStates(resolve(root, ".agentx/state/sensors.json"), log)
  const runsDir = resolve(root, ".agentx/cron/runs")
  return ids.map((id) => {
    const cfg = sensors![id] ?? {}
    const last = states[id]?.last
    return {
      id,
      reading: String(cfg.reading ?? ""),
      every: String(cfg.every ?? ""),
      targets: [...new Set<string>((cfg.levels ?? []).map((l: any) => (l?.urgent ? "push" : String(l?.target ?? ""))).filter(Boolean))],
      last: readingText(last),
      lastAt: typeof last?.at === "number" ? last.at : null,
      wakes: recentSensorRuns(runsDir, id).map((r) => ({ at: r.startedAt, level: r.level, target: r.target, reading: r.reading, ok: r.success, ...(r.error ? { error: r.error } : {}) })),
    }
  })
}

/** GET /crons/extras: what the Wall shows beside the jobs. */
export function schedulesExtras(root: string, cfg: { sensors?: Record<string, any>; allowedHostJobs?: Record<string, any> }, now: number): { sensors: SensorView[]; hostJobs: HostJobLine[] } {
  return { sensors: sensorsView(root, cfg.sensors), hostJobs: expiredHostJobs(cfg.allowedHostJobs, now) }
}
