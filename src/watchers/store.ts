import type Database from "better-sqlite3"
import { ensureColumns } from "@/storage/sqlite"
import type { Evidence } from "./evidence"

// --- Task watchers (#1030) ---
//
// One row per watched task, keyed by the task's key: the delegation id for
// a delegation (so the delegation start and the callee's own run share one
// watcher), the trace id for every other run. The key is UNIQUE, so a
// second checkpoint for the same task cannot add a second watcher.
//
// States:
//   open       watching: fires when the due time passes or the task ends
//              without a result
//   done       the task ended with a result, or someone marked it done
//              (with the evidence its type needs, #1049)
//   alerted    fired; the delegating agent was told
//   escalated  fired and the owner was told (straight away when there is
//              no delegating agent, else after `escalateAfterMinutes`)

export type WatcherState = "open" | "done" | "alerted" | "escalated"
export type WatchDecision = "yes" | "no" | "uncertain"

export interface WatcherRecord {
  id: string
  taskKey: string
  traceId: string | null
  kind: string
  agentId: string
  delegator: string | null
  summary: string
  dueAt: number
  state: WatcherState
  reason: string | null
  decision: WatchDecision
  probability: number | null
  decisionCallId: string | null
  createdAt: number
  updatedAt: number
  alertedAt: number | null
  escalatedAt: number | null
  /** The caller's `context.taskType`, which picks the evidence rule (#1049). */
  taskType: string | null
  /** The proof the done signal carried, when it carried one (#1049). */
  evidence: Evidence | null
}

/** Added after #1030: the task's type and the evidence on done (#1049). */
const EVIDENCE_COLUMNS: Array<[string, string]> = [
  ["task_type", "TEXT"],
  ["evidence", "TEXT"],
]

/** The checkpoint's record on the run it checked (`agentx trace`). */
export const WATCH_TRACE_COLUMNS: Array<[string, string]> = [
  ["watch_decision", "TEXT"],
  ["watch_probability", "REAL"],
  ["watcher_id", "TEXT"],
]

export function ensureWatcherTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_watchers (
      id TEXT PRIMARY KEY,
      task_key TEXT NOT NULL UNIQUE,
      trace_id TEXT,
      kind TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      delegator TEXT,
      summary TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      decision TEXT NOT NULL,
      probability REAL,
      decision_call_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      alerted_at INTEGER,
      escalated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_task_watchers_state_due ON task_watchers(state, due_at);
    CREATE INDEX IF NOT EXISTS idx_task_watchers_trace ON task_watchers(trace_id);
  `)
  ensureColumns(db, "task_watchers", EVIDENCE_COLUMNS)
  const hasTraces = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_traces'").get()
  if (hasTraces) ensureColumns(db, "task_traces", WATCH_TRACE_COLUMNS)
}

function parseJson(s: unknown): Evidence | null {
  if (typeof s !== "string" || !s) return null
  try { return JSON.parse(s) as Evidence } catch { return null }
}

function toRecord(r: any): WatcherRecord {
  return {
    id: r.id, taskKey: r.task_key, traceId: r.trace_id ?? null, kind: r.kind, agentId: r.agent_id,
    delegator: r.delegator ?? null, summary: r.summary, dueAt: r.due_at, state: r.state,
    reason: r.reason ?? null, decision: r.decision, probability: r.probability ?? null,
    decisionCallId: r.decision_call_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    alertedAt: r.alerted_at ?? null, escalatedAt: r.escalated_at ?? null,
    taskType: r.task_type ?? null, evidence: parseJson(r.evidence),
  }
}

export class WatcherStore {
  constructor(private db: Database.Database) {
    ensureWatcherTables(db)
  }

  /** Adds the watcher unless one exists for the key. Returns the watcher
   *  for the key either way, and whether this call created it. */
  add(input: Omit<WatcherRecord, "id" | "state" | "reason" | "updatedAt" | "alertedAt" | "escalatedAt" | "taskType" | "evidence"> & { taskType?: string | null }): { watcher: WatcherRecord; created: boolean } {
    const id = `watch-${input.taskKey}`
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO task_watchers
        (id, task_key, trace_id, kind, agent_id, delegator, summary, due_at, state, decision, probability, decision_call_id, created_at, updated_at, task_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.taskKey, input.traceId, input.kind, input.agentId, input.delegator, input.summary.slice(0, 500),
      input.dueAt, input.decision, input.probability, input.decisionCallId, input.createdAt, input.createdAt,
      input.taskType ?? null,
    )
    return { watcher: this.byKey(input.taskKey)!, created: res.changes > 0 }
  }

  get(id: string): WatcherRecord | null {
    const r = this.db.prepare("SELECT * FROM task_watchers WHERE id = ?").get(id)
    return r ? toRecord(r) : null
  }

  byKey(taskKey: string): WatcherRecord | null {
    const r = this.db.prepare("SELECT * FROM task_watchers WHERE task_key = ?").get(taskKey)
    return r ? toRecord(r) : null
  }

  /** The watcher a run belongs to: its own, or the delegation it runs for. */
  byTrace(traceId: string): WatcherRecord | null {
    const r = this.db.prepare("SELECT * FROM task_watchers WHERE trace_id = ? OR task_key = ? LIMIT 1").get(traceId, traceId)
    return r ? toRecord(r) : null
  }

  /** Links the latest run to the watcher it runs under: a delegation's
   *  callee run, or a run resumed after a restart. */
  setTrace(id: string, traceId: string): void {
    this.db.prepare("UPDATE task_watchers SET trace_id = ? WHERE id = ?").run(traceId, id)
  }

  /** A later start of the task named its due time: it replaces the one
   *  the watcher was made with, while the watcher has not fired. */
  setDue(id: string, dueAt: number): void {
    this.db.prepare("UPDATE task_watchers SET due_at = ? WHERE id = ? AND state = 'open'").run(dueAt, id)
  }

  /** A later start of the task named its type (a delegation's callee run):
   *  it is kept while the watcher still watches. */
  setTaskType(id: string, taskType: string): void {
    this.db.prepare("UPDATE task_watchers SET task_type = ? WHERE id = ? AND state IN ('open', 'alerted', 'escalated')").run(taskType, id)
  }

  /** Open watchers whose due time has passed. */
  due(now: number): WatcherRecord[] {
    return (this.db.prepare("SELECT * FROM task_watchers WHERE state = 'open' AND due_at <= ? ORDER BY due_at").all(now) as any[]).map(toRecord)
  }

  /** Alerted watchers the owner has not heard about, alerted at or before `before`. */
  unescalated(before: number): WatcherRecord[] {
    return (this.db.prepare("SELECT * FROM task_watchers WHERE state = 'alerted' AND alerted_at <= ? ORDER BY alerted_at").all(before) as any[]).map(toRecord)
  }

  list(opts: { state?: WatcherState; limit?: number } = {}): WatcherRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    const rows = opts.state
      ? this.db.prepare("SELECT * FROM task_watchers WHERE state = ? ORDER BY created_at DESC LIMIT ?").all(opts.state, limit)
      : this.db.prepare("SELECT * FROM task_watchers ORDER BY created_at DESC LIMIT ?").all(limit)
    return (rows as any[]).map(toRecord)
  }

  /** Moves a watcher on. Only from a state that still watches (`from`), so
   *  a late signal cannot reopen or re-fire a watcher. `evidence` is kept
   *  with a done signal that carried it. */
  transition(id: string, from: WatcherState[], to: WatcherState, reason: string, now: number, evidence?: Evidence | null): boolean {
    const stamp = to === "alerted" ? ", alerted_at = @now" : to === "escalated" ? ", escalated_at = @now" : ""
    const ev = evidence ? ", evidence = @evidence" : ""
    const res = this.db.prepare(
      `UPDATE task_watchers SET state = @to, reason = @reason, updated_at = @now${stamp}${ev}
       WHERE id = @id AND state IN (${from.map((_, i) => `@f${i}`).join(",")})`,
    ).run({
      id, to, reason: reason.slice(0, 500), now, ...Object.fromEntries(from.map((f, i) => [`f${i}`, f])),
      ...(evidence ? { evidence: JSON.stringify(evidence) } : {}),
    })
    return res.changes > 0
  }

  /** Writes the checkpoint's decision on the run's trace row. */
  recordOnTrace(traceId: string, decision: WatchDecision | "existing", probability: number | null, watcherId: string | null): void {
    try {
      this.db.prepare("UPDATE task_traces SET watch_decision = ?, watch_probability = ?, watcher_id = ? WHERE task_id = ?")
        .run(decision, probability, watcherId, traceId)
    } catch {
      /* no trace table (tests, a reader-only database): the watcher row is the record */
    }
  }

  /** Deletes finished watchers older than `before`. Open ones are kept. */
  prune(before: number): number {
    return this.db.prepare("DELETE FROM task_watchers WHERE state IN ('done', 'escalated') AND updated_at < ?").run(before).changes
  }
}
