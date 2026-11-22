import type Database from "better-sqlite3"
import { writeLedgerRow } from "./change-ledger"
import { endJobInConfig } from "./retired"

// --- How a recurring job ends by its `until`, and a late one-time run (#863) ---
//
// `crons.<id>.until`: after that time the scheduler ends the job the way a
// one-time job ends after its run: `enabled: false` and `endedAt` in
// agentx.json, plus a ledger row by the daemon. A restart loads it as off
// (scheduler.ts skips a job with `endedAt`) and it is never switched back
// on by a resume (crons/retired.ts).
//
// A one-time job whose time passed while the daemon was down runs once at
// start (#2004). Its brief then starts with one line saying how late it
// is, and the owner decides what that means.

/** Below this, a run is on time (a timer, a reload). */
export const LATE_AFTER_MS = 60_000

export interface UntilDeps {
  root: string
  configPath?: string
  log: (msg: string) => void
  ledger?: () => Database.Database | null
}

/** Whether a recurring job is past its `until` at `now`. */
export function pastUntil(until: string | undefined, now: number): boolean {
  if (!until) return false
  const at = Date.parse(until)
  return Number.isFinite(at) && at <= now
}

/** End a job whose `until` passed. Idempotent: an ended job writes nothing. */
export async function endByUntil(id: string, until: string, deps: UntilDeps): Promise<boolean> {
  const at = new Date(Date.parse(until)).toISOString()
  const ended = await endJobInConfig(id, at, { configPath: deps.configPath, reload: false, root: deps.root })
  if (!ended.ok) {
    deps.log(`Job "${id}" is past its until (${until}) but could not be ended: ${ended.error}`)
    return false
  }
  if (ended.changed) {
    writeLedgerRow(deps.root, { job: id, field: "end", old: "on", new: "ended", by: "daemon", reason: `until ${until}`, at: Date.parse(at) }, deps.ledger, deps.log)
    deps.log(`Job "${id}" reached its until (${until}); ended`)
  }
  return true
}

/** "This run is 5 h late (missed while the daemon was down)." or "". */
export function lateLine(lateMs: number | undefined): string {
  if (!lateMs || lateMs < LATE_AFTER_MS) return ""
  const hours = Math.round(lateMs / 3_600_000)
  const size = hours >= 1 ? `${hours} h` : `${Math.max(1, Math.round(lateMs / 60_000))} min`
  return `This run is ${size} late (missed while the daemon was down).`
}

/** The late line ahead of the job's own brief. */
export function withLateFirst(line: string, prompt: string): string {
  return line ? `${line}\n\n${prompt}` : prompt
}
