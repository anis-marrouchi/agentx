import type Database from "better-sqlite3"
import { randomBytes } from "crypto"

// --- Task watchers on disk (#1030) ---
//
// Two tables:
//   task_watchers            one row per watcher; at most one live row per
//                            task key (a partial unique index enforces it)
//   task_watch_checkpoints   the audit trail: every checkpoint's decision,
//                            probability and watcher id, attached or not
//
// Named, not numbered, like the requests tables, so the schema cannot
// clash with a migration number another branch claimed.

export type WatcherSource = "dispatch" | "delegation" | "cron"

/** armed     waiting for a done signal or the due time
 *  fired     the delegator was told; the owner is next unless it resolves
 *  escalated the owner was told; nothing more to send
 *  done      a done signal arrived (before or after firing) */
export type WatcherStatus = "armed" | "fired" | "escalated" | "done"

/** Statuses that still hold the task key: a new checkpoint for the same
 *  key finds this watcher instead of making a second one. */
export const LIVE_STATUSES: readonly WatcherStatus[] = ["armed", "fired"]

export interface WatcherRecord {
  id: string
  taskKey: string
  source: WatcherSource
  agentId: string
  /** Agent to alert first. Null: the owner is alerted directly. */
  delegator: string | null
  channel: string | null
  chatId: string | null
  /** The task, clipped. Shown in the alert. */
  summary: string
  dueAt: number | null
  status: WatcherStatus
  createdAt: number
  updatedAt: number
  firedAt: number | null
  fireReason: string | null
  escalatedAt: number | null
}

export type CheckpointDecision = "attach" | "skip" | "existing"

export interface CheckpointRecord {
  taskKey: string
  source: WatcherSource
  agentId: string
  at: number
  decision: CheckpointDecision
  /** The seat's probability that the task needs a watcher. Null when the
   *  seat did not answer (off, unreachable). */
  probability: number | null
  seatMode: string | null
  callId: string | null
  reason: string
  /** The watcher attached, or the one found already watching. */
  watcherId: string | null
  /** What already watched the task, for "existing": "watcher", "request", … */
  existingKind: string | null
}

const SUMMARY_MAX = 300

export function ensureWatcherTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_watchers (
      id TEXT PRIMARY KEY,
      task_key TEXT NOT NULL,
      source TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      delegator TEXT,
      channel TEXT,
      chat_id TEXT,
      summary TEXT NOT NULL,
      due_at INTEGER,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      fired_at INTEGER,
      fire_reason TEXT,
      escalated_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_watchers_live
      ON task_watchers(task_key) WHERE status IN ('armed', 'fired');
    CREATE INDEX IF NOT EXISTS idx_task_watchers_status ON task_watchers(status, due_at);
    CREATE TABLE IF NOT EXISTS task_watch_checkpoints (
      task_key TEXT NOT NULL,
      source TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      decision TEXT NOT NULL,
      probability REAL,
      seat_mode TEXT,
      call_id TEXT,
      reason TEXT NOT NULL,
      watcher_id TEXT,
      existing_kind TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_watch_checkpoints_key ON task_watch_checkpoints(task_key, at);
  `)
}

function toWatcher(r: any): WatcherRecord {
  return {
    id: r.id, taskKey: r.task_key, source: r.source, agentId: r.agent_id, delegator: r.delegator ?? null,
    channel: r.channel ?? null, chatId: r.chat_id ?? null, summary: r.summary, dueAt: r.due_at ?? null,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, firedAt: r.fired_at ?? null,
    fireReason: r.fire_reason ?? null, escalatedAt: r.escalated_at ?? null,
  }
}

function toCheckpoint(r: any): CheckpointRecord {
  return {
    taskKey: r.task_key, source: r.source, agentId: r.agent_id, at: r.at, decision: r.decision,
    probability: r.probability ?? null, seatMode: r.seat_mode ?? null, callId: r.call_id ?? null,
    reason: r.reason, watcherId: r.watcher_id ?? null, existingKind: r.existing_kind ?? null,
  }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

export class WatcherStore {
  constructor(private db: Database.Database) {
    ensureWatcherTables(db)
  }

  /** The watcher still holding this task key, if any. */
  live(taskKey: string): WatcherRecord | null {
    const r = this.db.prepare(
      `SELECT * FROM task_watchers WHERE task_key = ? AND status IN ('armed', 'fired') LIMIT 1`,
    ).get(taskKey)
    return r ? toWatcher(r) : null
  }

  get(id: string): WatcherRecord | null {
    const r = this.db.prepare(`SELECT * FROM task_watchers WHERE id = ?`).get(id)
    return r ? toWatcher(r) : null
  }

  /** Arm a watcher, or return the one already holding the key. Never makes
   *  a second live row: the unique index turns a race into a lookup. */
  arm(input: {
    taskKey: string; source: WatcherSource; agentId: string; delegator?: string | null
    channel?: string | null; chatId?: string | null; summary: string; dueAt?: number | null; now: number
  }): { watcher: WatcherRecord; created: boolean } {
    const found = this.live(input.taskKey)
    if (found) return { watcher: found, created: false }
    const id = `wch-${input.now.toString(36)}-${randomBytes(4).toString("hex")}`
    try {
      this.db.prepare(
        `INSERT INTO task_watchers (id, task_key, source, agent_id, delegator, channel, chat_id, summary, due_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?)`,
      ).run(
        id, input.taskKey, input.source, input.agentId, input.delegator ?? null, input.channel ?? null,
        input.chatId ?? null, clip(input.summary, SUMMARY_MAX), input.dueAt ?? null, input.now, input.now,
      )
    } catch (e: any) {
      const raced = /UNIQUE constraint failed/i.test(String(e?.message)) ? this.live(input.taskKey) : null
      if (raced) return { watcher: raced, created: false }
      throw e
    }
    return { watcher: this.get(id)!, created: true }
  }

  /** A done signal. Returns false when the watcher was not live. */
  markDone(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE task_watchers SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('armed', 'fired')`,
    ).run(now, id).changes > 0
  }

  /** First alert sent. Only from `armed`, so two signals cannot fire twice. */
  markFired(id: string, reason: string, now: number, escalated: boolean): boolean {
    return this.db.prepare(
      `UPDATE task_watchers SET status = ?, fired_at = ?, fire_reason = ?, updated_at = ?, escalated_at = ?
       WHERE id = ? AND status = 'armed'`,
    ).run(escalated ? "escalated" : "fired", now, clip(reason, 500), now, escalated ? now : null, id).changes > 0
  }

  markEscalated(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE task_watchers SET status = 'escalated', escalated_at = ?, updated_at = ? WHERE id = ? AND status = 'fired'`,
    ).run(now, now, id).changes > 0
  }

  /** Armed watchers whose due time has passed. */
  overdue(now: number): WatcherRecord[] {
    return (this.db.prepare(
      `SELECT * FROM task_watchers WHERE status = 'armed' AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at`,
    ).all(now) as any[]).map(toWatcher)
  }

  /** Armed watchers with no due time that have heard nothing since `before`. */
  quietSince(before: number): WatcherRecord[] {
    return (this.db.prepare(
      `SELECT * FROM task_watchers WHERE status = 'armed' AND due_at IS NULL AND updated_at <= ? ORDER BY created_at`,
    ).all(before) as any[]).map(toWatcher)
  }

  /** Fired watchers whose first alert went out at or before `before`. */
  firedBefore(before: number): WatcherRecord[] {
    return (this.db.prepare(
      `SELECT * FROM task_watchers WHERE status = 'fired' AND fired_at <= ? ORDER BY fired_at`,
    ).all(before) as any[]).map(toWatcher)
  }

  listLive(): WatcherRecord[] {
    return (this.db.prepare(
      `SELECT * FROM task_watchers WHERE status IN ('armed', 'fired') ORDER BY created_at`,
    ).all() as any[]).map(toWatcher)
  }

  recordCheckpoint(c: CheckpointRecord): void {
    this.db.prepare(
      `INSERT INTO task_watch_checkpoints (task_key, source, agent_id, at, decision, probability, seat_mode, call_id, reason, watcher_id, existing_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.taskKey, c.source, c.agentId, c.at, c.decision, c.probability, c.seatMode, c.callId,
      clip(c.reason, 500), c.watcherId, c.existingKind,
    )
  }

  checkpoints(taskKey: string): CheckpointRecord[] {
    return (this.db.prepare(
      `SELECT * FROM task_watch_checkpoints WHERE task_key = ? ORDER BY at, rowid`,
    ).all(taskKey) as any[]).map(toCheckpoint)
  }

  /** Delete finished watchers and checkpoints older than `before`. Live
   *  watchers are kept whatever their age. */
  prune(before: number): number {
    const a = this.db.prepare(
      `DELETE FROM task_watchers WHERE status IN ('escalated', 'done') AND updated_at < ?`,
    ).run(before).changes
    const b = this.db.prepare(`DELETE FROM task_watch_checkpoints WHERE at < ?`).run(before).changes
    return a + b
  }
}
