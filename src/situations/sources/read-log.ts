import type Database from "better-sqlite3"
import type { ReadLogSink } from "./registry"

// --- The per-request read log (#1892 phase 7, design 2.3) ---
//
// One row per read of a per-request source (open apps, browser tabs,
// news): when, which source, which agent, for which request, and how it
// went. Never what was read: the content goes to the agent's turn and is
// not stored here, as camera frames are only logged as "handed over".
//
// The row is written before the source is read (registry.ts): no row, no
// read. So "nothing was read" is checked by an empty log.
//
// The consent itself is not here: it is the decision card the person
// answered (consent.ts). This log only says what was done with it.

export interface SourceReadRow {
  id: number
  at: number
  source: string
  agentId: string
  /** The request: the consent card's id, or the turn's task id for a
   *  source that needs no yes. */
  requestId: string
  /** "started" until the read ends; "read", "empty" or "down" after. */
  outcome: string
  /** How many answers came back. */
  count: number
}

/** Rows are kept this long. */
const KEEP_MS = 30 * 24 * 3600_000
const PRUNE_EVERY_MS = 3600_000

export class SourceReadLog implements ReadLogSink {
  private readonly insert: Database.Statement
  private readonly update: Database.Statement
  private readonly listAll: Database.Statement
  private readonly listByRequest: Database.Statement
  private readonly prune: Database.Statement
  private lastPrune = 0

  constructor(db: Database.Database, private readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS situation_source_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'started',
        count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_situation_source_reads_at ON situation_source_reads(at);
    `)
    const cols = "id, at, source, agent_id AS agentId, request_id AS requestId, outcome, count"
    this.insert = db.prepare("INSERT INTO situation_source_reads (at, source, agent_id, request_id) VALUES (?, ?, ?, ?)")
    this.update = db.prepare("UPDATE situation_source_reads SET outcome = ?, count = ? WHERE id = ?")
    this.listAll = db.prepare(`SELECT ${cols} FROM situation_source_reads ORDER BY id DESC LIMIT ?`)
    this.listByRequest = db.prepare(`SELECT ${cols} FROM situation_source_reads WHERE request_id = ? ORDER BY id DESC LIMIT ?`)
    this.prune = db.prepare("DELETE FROM situation_source_reads WHERE at < ?")
  }

  start(row: { at: number; source: string; agentId: string; requestId: string }): number {
    if (row.at - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = row.at
      this.prune.run(this.now() - KEEP_MS)
    }
    return Number(this.insert.run(row.at, row.source, row.agentId, row.requestId).lastInsertRowid)
  }

  finish(id: number, outcome: "read" | "down" | "empty", count: number): void {
    this.update.run(outcome, count, id)
  }

  list(opts: { limit?: number; requestId?: string } = {}): SourceReadRow[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)))
    return (opts.requestId ? this.listByRequest.all(opts.requestId, limit) : this.listAll.all(limit)) as SourceReadRow[]
  }
}
