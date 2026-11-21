import type Database from "better-sqlite3"
import { resolve } from "path"
import { openDb } from "@/storage/sqlite"

// --- What changed on a schedule, and who changed it (#863) ---
//
// One row per change an owner agent, the operator or the daemon makes to
// a schedule: its brief, time, goal, value or end time, a pause or resume,
// and its retirement. Old and new value, who, why, when. Shown on the
// Wall and in Settings › Schedules. A row by the owner on brief, time,
// goal, value or retire also pays off a change the operator asked for
// (changeOwed); a pause or resume row does not.

export const CHANGE_FIELDS = ["brief", "time", "goal", "value", "until", "pause", "resume", "retire", "end"] as const
export type CronChangeField = (typeof CHANGE_FIELDS)[number]

/** The rows that carry out a change the operator asked for. */
export const CLEARS_CHANGE_OWED: readonly CronChangeField[] = ["brief", "time", "goal", "value", "retire"]

const TEXT_MAX = 2000

export interface CronChangeRow {
  job: string
  field: CronChangeField
  old: string | null
  new: string | null
  by: string
  reason: string | null
  /** Epoch ms. */
  at: number
}

export function ensureCronChangesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      field TEXT NOT NULL,
      old TEXT,
      new TEXT,
      by TEXT NOT NULL,
      reason TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cron_changes_job ON cron_changes(job, at);
  `)
}

const clip = (v: string | null) => (v === null ? null : v.slice(0, TEXT_MAX))

export function recordCronChange(db: Database.Database, row: CronChangeRow): void {
  ensureCronChangesTable(db)
  db.prepare("INSERT INTO cron_changes (job, field, old, new, by, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.job, row.field, clip(row.old), clip(row.new), row.by, clip(row.reason), row.at)
}

/** A job's changes, newest first. */
export function cronChanges(db: Database.Database, job: string, limit = 20): CronChangeRow[] {
  ensureCronChangesTable(db)
  return db.prepare("SELECT job, field, old, new, by, reason, at FROM cron_changes WHERE job = ? ORDER BY at DESC, id DESC LIMIT ?")
    .all(job, limit) as CronChangeRow[]
}

/** Whether `by` wrote a row that pays off a change owed on `job`, at or
 *  after `since` (epoch ms). */
export function ownerChangedSince(db: Database.Database, job: string, by: string, since: number): boolean {
  ensureCronChangesTable(db)
  const fields = CLEARS_CHANGE_OWED.map(() => "?").join(",")
  const row = db.prepare(`SELECT 1 FROM cron_changes WHERE job = ? AND by = ? AND at >= ? AND field IN (${fields}) LIMIT 1`)
    .get(job, by, since, ...CLEARS_CHANGE_OWED)
  return !!row
}

/** The node's database for the ledger; null when SQLite is unavailable. */
export function openChangeLedger(root: string): Database.Database | null {
  return openDb({ path: resolve(root, ".agentx", "db.sqlite") })
}

/** A value as one ledger cell. */
export function ledgerText(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null
  return typeof v === "string" ? v : JSON.stringify(v)
}

/** Write one row; never throws. False when it was not written (no
 *  database, or the write failed): the change itself still stands. */
export function writeLedgerRow(root: string, row: CronChangeRow, ledger?: () => Database.Database | null, log?: (msg: string) => void): boolean {
  try {
    const db = ledger ? ledger() : openChangeLedger(root)
    if (!db) return false
    recordCronChange(db, row)
    return true
  } catch (e: any) {
    log?.(`[cron-goal] change log row for "${row.job}" not written: ${e?.message ?? e}`)
    return false
  }
}
