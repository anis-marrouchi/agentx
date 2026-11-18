import type Database from "better-sqlite3"
import { ensureJobColumns } from "@/jobs/store"
import { ensureColumns } from "@/storage/sqlite"
import { isoOf, PRIORITIES, type Priority, type QueueItem, type SlotInputs } from "./slots"

// --- Where work is registered in the queue (#1909) ---
//
// One row per request, promise or job the daemon placed: its priority,
// where its due time came from, the time the daemon computed and the time
// the agent wrote. In shadow mode the rows are all that is written, so the
// two times can be compared before anything is refused.
//
// The queue itself is the job ledger (#1861): open rows of `requests`,
// read with their slot row when they have one. The table is made on the
// first row written, so a node with due times off never gets it.

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
  // When its requester was last told the due time moved, and the oldest
  // time a move they were not told of yet started from.
  ensureColumns(db, "due_slots", [["told_at", "INTEGER"], ["told_from", "INTEGER"]])
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

/** A requester hears that a due time moved at most once in this long. */
export const TELL_WINDOW_MS = 60 * 60_000

/** How the queue is read: the clock, and how long an open row may sit
 *  untouched (with no wake ahead) before it is not counted. */
export interface QueueRead {
  now: number
  staleAfterMs: number
  limit?: number
}

/** A held-back move whose requester is told now. */
export interface DueNotice {
  requestId: string
  agentId: string
  from: number
  to: number
  requester: string | null
  words: string
}

export class SlotStore {
  private made = false
  constructor(private db: Database.Database) {}

  private ensure(): void {
    if (this.made) return
    ensureSlotTable(this.db)
    this.made = true
  }

  get(requestId: string): SlotRow | null {
    if (!hasSlotTable(this.db)) return null
    const r = this.db.prepare("SELECT * FROM due_slots WHERE request_id = ?").get(requestId)
    return r ? toRow(r) : null
  }

  /** Writes the row of a request; a second write for it replaces the first
   *  and keeps when it was made. */
  put(row: Omit<SlotRow, "createdAt" | "updatedAt">, now: number): void {
    this.ensure()
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
   *  armed for the old one and its note (which names the time), and the
   *  slot row. */
  moveDue(requestId: string, from: number, to: number, now: number): void {
    this.ensure()
    this.db.prepare(
      `UPDATE requests SET due_at = ?, due_pushed_at = NULL,
         job_note = CASE WHEN wake_at = ? AND job_note IS NOT NULL THEN REPLACE(job_note, ?, ?) ELSE job_note END,
         wake_at = CASE WHEN wake_at = ? THEN ? ELSE wake_at END, updated_at = ? WHERE id = ?`,
    ).run(to, from, isoOf(from), isoOf(to), from, to, now, requestId)
    this.db.prepare("UPDATE due_slots SET given_due = ?, updated_at = ? WHERE request_id = ?").run(to, now, requestId)
  }

  /** A move of this request's due time: may its requester be told now?
   *  At most once per TELL_WINDOW_MS. Told: from the oldest time not told
   *  yet. Not yet: that oldest time is kept for a later notice. */
  noteMove(requestId: string, from: number, now: number): { tell: boolean; from: number } {
    this.ensure()
    const r = this.db.prepare("SELECT told_at, told_from FROM due_slots WHERE request_id = ?").get(requestId) as { told_at: number | null; told_from: number | null } | undefined
    if (!r) return { tell: true, from }
    const oldest = r.told_from ?? from
    if (r.told_at == null || now - r.told_at >= TELL_WINDOW_MS) {
      this.db.prepare("UPDATE due_slots SET told_at = ?, told_from = NULL WHERE request_id = ?").run(now, requestId)
      return { tell: true, from: oldest }
    }
    this.db.prepare("UPDATE due_slots SET told_from = ? WHERE request_id = ?").run(oldest, requestId)
    return { tell: false, from: oldest }
  }

  /** Moves held back by the window, once the window is over: the
   *  requester is told from the oldest time to the latest. Each is marked
   *  told; a closed row, or one back at its old time, says nothing. */
  dueNotices(now: number, limit = 50): DueNotice[] {
    if (!hasSlotTable(this.db)) return []
    this.ensure()
    const rows = this.db.prepare(
      `SELECT s.request_id, s.agent_id, s.told_from, s.given_due, r.state, r.requester, r.owed_to, r.sender, r.closed_at, COALESCE(r.headline, r.text) AS words
         FROM due_slots s JOIN requests r ON r.id = s.request_id
        WHERE s.told_from IS NOT NULL AND s.told_at IS NOT NULL AND s.told_at <= ? LIMIT ?`,
    ).all(now - TELL_WINDOW_MS, limit) as any[]
    const out: DueNotice[] = []
    for (const r of rows) {
      this.db.prepare("UPDATE due_slots SET told_at = ?, told_from = NULL WHERE request_id = ?").run(now, r.request_id)
      if (r.closed_at != null || r.given_due == null || r.given_due <= r.told_from) continue
      out.push({
        requestId: r.request_id, agentId: r.agent_id, from: r.told_from, to: r.given_due,
        requester: r.state === "job" ? r.requester ?? null : r.owed_to ?? r.sender ?? "owner",
        words: String(r.words ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      })
    }
    return out
  }

  /** The node's queue: every open row that takes a place in it. */
  queue(read: QueueRead): QueueItem[] {
    return readQueue(this.db, read)
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

/** The node's queue, read only. Left out: rows untouched for longer than
 *  `staleAfterMs` with no wake ahead of them (forgotten work does not
 *  hold the queue). A job running now carries when its run started; a
 *  job that waits for a later wake (not the wake of its own due time)
 *  carries that wake. Works before the slot table exists. */
export function readQueue(db: Database.Database, read: QueueRead): QueueItem[] {
  if (!hasJobColumns(db)) return []
  const slots = hasSlotTable(db)
  const slotCols = slots
    ? "s.priority, s.ahead, s.source, s.created_at AS slot_at, json_extract(s.inputs, '$.estimateMinutes') AS slot_est"
    : "NULL AS priority, 0 AS ahead, NULL AS source, NULL AS slot_at, NULL AS slot_est"
  const rows = db.prepare(
    `SELECT r.id, r.agent_id, r.created_at, r.updated_at, r.estimate_minutes, r.due_at, r.state, r.job_state, r.wake_at, r.owed_to, r.sender, r.requester,
            COALESCE(r.headline, r.text) AS words, ${slotCols},
            CASE WHEN r.job_state = 'working'
              THEN (SELECT MAX(l.at) FROM request_links l WHERE l.request_id = r.id AND l.kind IN ('run', 'step_run')) END AS run_at
       FROM requests r ${slots ? "LEFT JOIN due_slots s ON s.request_id = r.id" : ""}
      WHERE ${QUEUED}
        AND (r.updated_at >= ? OR (r.wake_at IS NOT NULL AND r.wake_at > ?))
      ORDER BY r.created_at LIMIT ?`,
  ).all(read.now - read.staleAfterMs, read.now, read.limit ?? 2000) as any[]
  const positive = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null)
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    priority: (PRIORITIES as readonly string[]).includes(r.priority) ? r.priority : "normal",
    ahead: !!r.ahead,
    // The ledger's estimate, else the one the slot was placed with (a
    // shadow promise does not write it to the ledger).
    estimateMinutes: positive(r.estimate_minutes) ?? positive(r.slot_est),
    // Accepted work queues from when it was accepted, not when it was asked.
    createdAt: r.slot_at ?? r.created_at,
    dueAt: r.due_at ?? null,
    requester: r.state === "job" ? r.requester ?? null : r.owed_to ?? r.sender ?? "owner",
    // A due time with no slot row was written before the daemon gave
    // them: it is the agent's, and does not move on its own.
    source: r.source ?? (r.due_at ? "agent" : "none"),
    words: String(r.words ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    runningSince: r.job_state === "working" ? Math.min(read.now, r.run_at ?? r.updated_at) : null,
    notBefore: r.job_state === "continue" && r.wake_at != null && r.wake_at > read.now && r.wake_at !== r.due_at ? r.wake_at : null,
  }))
}

function hasJobColumns(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
  return cols.some((c) => c.name === "job_state") && cols.some((c) => c.name === "wake_at")
}

/** For readers that must not create the table (the dashboard, the CLI). */
export function hasSlotTable(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'due_slots'").get()
}
