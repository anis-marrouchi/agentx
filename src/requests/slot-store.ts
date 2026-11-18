import type Database from "better-sqlite3"
import { ensureJobColumns } from "@/jobs/store"
import { PRIORITIES, type Priority, type QueueItem, type SlotInputs } from "./slots"

// --- Where work is registered in the queue (#1909) ---
//
// One row per request, promise or job the daemon placed: its priority,
// where its due time came from, the time the daemon computed and the time
// the agent wrote. In shadow mode the rows are all that is written, so the
// two times can be compared before anything is refused.
//
// The queue itself is the job ledger (#1861): open rows of `requests`,
// read with their slot row when they have one.

/** Where a due time came from.
 *    daemon     computed from the queue
 *    requester  the words of the one who asked
 *    fact       an outside fact: a posting slot, a meeting
 *    agent      written by the agent with no source */
export const DUE_SOURCES = ["daemon", "requester", "fact", "agent"] as const
export type DueSource = (typeof DUE_SOURCES)[number]

export interface SlotRow {
  requestId: string
  agentId: string
  priority: Priority
  ahead: boolean
  source: DueSource
  sourceText: string | null
  /** "shadow" or "on": the mode it was written in. */
  mode: string
  /** The time the daemon computed (or would have given). */
  computedDue: number | null
  /** The time the agent wrote, if it wrote one. */
  agentDue: number | null
  /** The time the row has now. */
  givenDue: number | null
  /** What the daemon would have refused, in shadow: "no source", "does not fit". */
  wouldRefuse: string | null
  inputs: SlotInputs | null
  createdAt: number
  updatedAt: number
}

export function ensureSlotTable(db: Database.Database): void {
  ensureJobColumns(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS due_slots (
      request_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      priority TEXT NOT NULL,
      ahead INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      source_text TEXT,
      mode TEXT NOT NULL,
      computed_due INTEGER,
      agent_due INTEGER,
      given_due INTEGER,
      would_refuse TEXT,
      inputs TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_due_slots_agent ON due_slots(agent_id, created_at);
  `)
}

function toRow(r: any): SlotRow {
  let inputs: SlotInputs | null = null
  try { inputs = r.inputs ? JSON.parse(r.inputs) : null } catch { inputs = null }
  return {
    requestId: r.request_id, agentId: r.agent_id,
    priority: (PRIORITIES as readonly string[]).includes(r.priority) ? r.priority : "normal",
    ahead: !!r.ahead, source: r.source, sourceText: r.source_text ?? null, mode: r.mode,
    computedDue: r.computed_due ?? null, agentDue: r.agent_due ?? null, givenDue: r.given_due ?? null,
    wouldRefuse: r.would_refuse ?? null, inputs, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

/** An open row of the ledger that takes a place in the queue: not closed,
 *  not waiting on someone, not blocked or stalled, not owed by the owner. */
const QUEUED = `r.state NOT IN ('candidate', 'done', 'declined', 'dropped', 'waiting_owner', 'waiting_other', 'needs_attention')
  AND COALESCE(r.job_state, '') NOT IN ('done', 'dropped', 'waiting', 'blocked', 'stalled')
  AND COALESCE(r.owed_by, '') != 'owner'`

export class SlotStore {
  constructor(private db: Database.Database) {
    ensureSlotTable(db)
  }

  get(requestId: string): SlotRow | null {
    const r = this.db.prepare("SELECT * FROM due_slots WHERE request_id = ?").get(requestId)
    return r ? toRow(r) : null
  }

  /** Writes the row of a request; a second write for it replaces the first
   *  and keeps when it was made. */
  put(row: Omit<SlotRow, "createdAt" | "updatedAt">, now: number): void {
    this.db.prepare(
      `INSERT INTO due_slots (request_id, agent_id, priority, ahead, source, source_text, mode, computed_due, agent_due, given_due, would_refuse, inputs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET agent_id = excluded.agent_id, priority = excluded.priority, ahead = excluded.ahead,
         source = excluded.source, source_text = excluded.source_text, mode = excluded.mode, computed_due = excluded.computed_due,
         agent_due = excluded.agent_due, given_due = excluded.given_due, would_refuse = excluded.would_refuse, inputs = excluded.inputs,
         updated_at = excluded.updated_at`,
    ).run(
      row.requestId, row.agentId, row.priority, row.ahead ? 1 : 0, row.source, row.sourceText?.slice(0, 500) ?? null, row.mode,
      row.computedDue, row.agentDue, row.givenDue, row.wouldRefuse, row.inputs ? JSON.stringify(row.inputs) : null, now, now,
    )
  }

  /** The due time moved with the queue: the request's due time, a wake
   *  armed for the old one, and the slot row. */
  moveDue(requestId: string, from: number, to: number, now: number): void {
    this.db.prepare(
      "UPDATE requests SET due_at = ?, due_pushed_at = NULL, wake_at = CASE WHEN wake_at = ? THEN ? ELSE wake_at END, updated_at = ? WHERE id = ?",
    ).run(to, from, to, now, requestId)
    this.db.prepare("UPDATE due_slots SET given_due = ?, updated_at = ? WHERE request_id = ?").run(to, now, requestId)
  }

  /** The node's queue: every open row that takes a place in it. */
  queue(limit = 2000): QueueItem[] {
    return readQueue(this.db, limit)
  }

  /** Rows written since `since`, newest first, for the shadow report. */
  since(since: number, agentId?: string, limit = 2000): SlotRow[] {
    return readSlots(this.db, since, agentId, limit)
  }
}

/** Slot rows written since `since`, newest first. Reads only. */
export function readSlots(db: Database.Database, since: number, agentId?: string, limit = 2000): SlotRow[] {
  if (!hasSlotTable(db)) return []
  return (db.prepare(
    `SELECT * FROM due_slots WHERE created_at >= ? ${agentId ? "AND agent_id = ?" : ""} ORDER BY created_at DESC LIMIT ?`,
  ).all(...(agentId ? [since, agentId, limit] : [since, limit])) as any[]).map(toRow)
}

/** The node's queue, read only: empty on a database the daemon has not
 *  given the slot table yet. */
export function readQueue(db: Database.Database, limit = 2000): QueueItem[] {
  if (!hasSlotTable(db)) return []
  const rows = db.prepare(
    `SELECT r.id, r.agent_id, r.created_at, r.estimate_minutes, r.due_at, r.state, r.owed_to, r.sender, r.requester,
            COALESCE(r.headline, r.text) AS words, s.priority, s.ahead, s.source
       FROM requests r LEFT JOIN due_slots s ON s.request_id = r.id
      WHERE ${QUEUED}
      ORDER BY r.created_at LIMIT ?`,
  ).all(limit) as any[]
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    priority: (PRIORITIES as readonly string[]).includes(r.priority) ? r.priority : "normal",
    ahead: !!r.ahead,
    estimateMinutes: typeof r.estimate_minutes === "number" && r.estimate_minutes > 0 ? r.estimate_minutes : null,
    createdAt: r.created_at,
    dueAt: r.due_at ?? null,
    requester: r.state === "job" ? r.requester ?? null : r.owed_to ?? r.sender ?? "owner",
    // A due time with no slot row was written before the daemon gave
    // them: it is the agent's, and does not move on its own.
    source: r.source ?? (r.due_at ? "agent" : "none"),
    words: String(r.words ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
  }))
}

/** For readers that must not create the table (the dashboard, the CLI). */
export function hasSlotTable(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'due_slots'").get()
}
