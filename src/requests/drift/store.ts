import type Database from "better-sqlite3"

// --- What status drift has already said and written (#1138 step F) ---
//
// One row per drift: an issue, its kind of drift, and the merges behind
// it. The owner is told about a row once; write mode changes the issue
// once (a failed write is tried again, up to WRITE_TRIES times).

export const WRITE_TRIES = 3
const KEEP_DAYS = 60

export interface DriftRow {
  key: string
  issue: string
  kind: string
  line: string
  firstAt: number
  toldAt: number | null
  writtenAt: number | null
  writeTries: number
  writeError: string | null
}

const toRow = (r: any): DriftRow => ({
  key: r.key, issue: r.issue, kind: r.kind, line: r.line, firstAt: r.first_at, toldAt: r.told_at,
  writtenAt: r.written_at, writeTries: r.write_tries, writeError: r.write_error,
})

export class DriftStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_drift (
        key TEXT PRIMARY KEY,
        issue TEXT NOT NULL,
        kind TEXT NOT NULL,
        line TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        told_at INTEGER,
        written_at INTEGER,
        write_tries INTEGER NOT NULL DEFAULT 0,
        write_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_status_drift_first ON status_drift(first_at);
    `)
  }

  /** The row of a drift, made the first time it is seen. */
  see(key: string, issue: string, kind: string, line: string, now: number): DriftRow {
    this.db.prepare("INSERT OR IGNORE INTO status_drift (key, issue, kind, line, first_at) VALUES (?, ?, ?, ?, ?)").run(key, issue, kind, line, now)
    return toRow(this.db.prepare("SELECT * FROM status_drift WHERE key = ?").get(key))
  }

  /** Told (a time), or not told after all (null): told again next check. */
  told(key: string, at: number | null): void {
    this.db.prepare("UPDATE status_drift SET told_at = ? WHERE key = ?").run(at, key)
  }

  written(key: string, at: number): void {
    this.db.prepare("UPDATE status_drift SET written_at = ?, write_tries = write_tries + 1, write_error = NULL WHERE key = ?").run(at, key)
  }

  writeFailed(key: string, error: string): void {
    this.db.prepare("UPDATE status_drift SET write_tries = write_tries + 1, write_error = ? WHERE key = ?").run(error.slice(0, 500), key)
  }

  list(limit = 100): DriftRow[] {
    return this.db.prepare("SELECT * FROM status_drift ORDER BY first_at DESC LIMIT ?").all(limit).map(toRow)
  }

  prune(now: number): number {
    return this.db.prepare("DELETE FROM status_drift WHERE first_at < ?").run(now - KEEP_DAYS * 86_400_000).changes
  }
}
