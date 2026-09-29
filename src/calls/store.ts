// --- Calls an agent placed to the owner, kept in SQLite ---
//
// One row per call, so a missed call is still there after a restart and
// the dashboard can list them. Nothing else reads this table.

import type Database from "better-sqlite3"

export type CallStatus = "ringing" | "answered" | "ended" | "declined" | "missed" | "later"
export type CallUrgency = "normal" | "urgent"

export interface Call {
  id: string
  agentId: string
  reason: string
  urgency: CallUrgency
  status: CallStatus
  /** When the agent asked, ms since the epoch. */
  createdAt: number
  /** When it last started ringing: at the request, or when "later" came due. */
  ringingSince: number | null
  answeredAt: number | null
  endedAt: number | null
  /** Status "later": when it rings again. */
  ringAgainAt: number | null
  /** Why it ended the way it did, in a few words ("in Focus", "not answered"). */
  note: string | null
  /** The agent's own summary, written after hang-up. */
  summary: string | null
}

/** Calls still in progress: an agent has at most one of these. */
export const LIVE: CallStatus[] = ["ringing", "answered", "later"]

const COLUMNS = `id, agent_id AS agentId, reason, urgency, status, created_at AS createdAt,
  ringing_since AS ringingSince, answered_at AS answeredAt, ended_at AS endedAt,
  ring_again_at AS ringAgainAt, note, summary`

export class CallStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, reason TEXT NOT NULL,
      urgency TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      ringing_since INTEGER, answered_at INTEGER, ended_at INTEGER,
      ring_again_at INTEGER, note TEXT, summary TEXT);
      CREATE INDEX IF NOT EXISTS calls_recent ON calls(created_at DESC);`)
  }

  insert(call: Call): void {
    this.db.prepare(`INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      call.id, call.agentId, call.reason, call.urgency, call.status, call.createdAt,
      call.ringingSince, call.answeredAt, call.endedAt, call.ringAgainAt, call.note, call.summary)
  }

  get(id: string): Call | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM calls WHERE id=?`).get(id) as Call | undefined
  }

  /** Write the changed fields of one call. */
  update(id: string, patch: Partial<Omit<Call, "id" | "agentId" | "createdAt">>): Call | undefined {
    const cols: Record<string, string> = {
      reason: "reason", urgency: "urgency", status: "status", ringingSince: "ringing_since",
      answeredAt: "answered_at", endedAt: "ended_at", ringAgainAt: "ring_again_at", note: "note", summary: "summary",
    }
    const keys = Object.keys(patch).filter((k) => k in cols)
    if (keys.length) {
      const set = keys.map((k) => `${cols[k]}=?`).join(", ")
      this.db.prepare(`UPDATE calls SET ${set} WHERE id=?`).run(...keys.map((k) => (patch as any)[k] ?? null), id)
    }
    return this.get(id)
  }

  /** Change a call only if it is still `from`: the check and the write are
   *  one statement, so two sweeps, or a sweep and the owner answering,
   *  cannot both move the same call. Undefined when it had moved on. */
  transition(id: string, from: CallStatus | CallStatus[], patch: Partial<Omit<Call, "id" | "agentId" | "createdAt">>): Call | undefined {
    const statuses = Array.isArray(from) ? from : [from]
    const cols: Record<string, string> = {
      status: "status", ringingSince: "ringing_since", answeredAt: "answered_at", endedAt: "ended_at",
      ringAgainAt: "ring_again_at", note: "note", summary: "summary",
    }
    const keys = Object.keys(patch).filter((k) => k in cols)
    const set = keys.map((k) => `${cols[k]}=?`).join(", ")
    const marks = statuses.map(() => "?").join(",")
    const changed = this.db.prepare(`UPDATE calls SET ${set} WHERE id=? AND status IN (${marks})`)
      .run(...keys.map((k) => (patch as any)[k] ?? null), id, ...statuses).changes
    return changed ? this.get(id) : undefined
  }

  /** Newest first; only these statuses when given. */
  list(opts: { status?: CallStatus[]; limit?: number } = {}): Call[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    if (opts.status?.length) {
      const marks = opts.status.map(() => "?").join(",")
      return this.db.prepare(`SELECT ${COLUMNS} FROM calls WHERE status IN (${marks})
        ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...opts.status, limit) as Call[]
    }
    return this.db.prepare(`SELECT ${COLUMNS} FROM calls ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit) as Call[]
  }

  /** Calls this agent placed after `since` (ms), for the hourly limit. */
  countSince(agentId: string, since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE agent_id=? AND created_at>?")
      .get(agentId, since) as { n: number }).n
  }
}
