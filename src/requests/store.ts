import type Database from "better-sqlite3"

// --- Open requests: what a person asked for that is not finished (#356) ---
//
// One row per request a person made to an agent, kept until someone closes
// it. A turn from a person starts as a `candidate`; it becomes an open
// request when the turn leaves work behind (a delegation, a failure, a
// restart) or the agent says so. A candidate whose turn simply answered
// and ended is deleted.
//
// The store is plain sqlite in .agentx/db.sqlite. Every call is one small
// synchronous statement: nothing here calls a model or waits on I/O.

export type OpenState = "in_progress" | "waiting_owner" | "waiting_other" | "needs_attention"
export type ClosedState = "done" | "declined" | "dropped"
export type RequestState = "candidate" | OpenState | ClosedState

export const OPEN_STATES: readonly OpenState[] = ["in_progress", "waiting_owner", "waiting_other", "needs_attention"]
export const CLOSED_STATES: readonly ClosedState[] = ["done", "declined", "dropped"]

export type LinkKind = "run" | "delegation" | "card"

export interface RequestRecord {
  id: string
  state: RequestState
  channel: string
  chatId: string
  sender: string | null
  agentId: string
  /** The request in the person's words. */
  text: string
  createdAt: number
  /** Last time anything happened under this request. */
  updatedAt: number
  /** Why it needs attention, in words. */
  attentionReason: string | null
  /** When the owner was told it needs attention. Told once. */
  notifiedAt: number | null
  /** What the owner is being asked, while waiting on them. */
  question: string | null
  closedAt: number | null
  /** Link to the proof of a finished request (PR, issue, message, deploy). */
  evidence: string | null
  /** Why it was declined or dropped. */
  closeReason: string | null
}

export const TEXT_MAX = 4000
const REASON_MAX = 500

/** Creates the tables when missing. Named, not numbered, so it cannot
 *  clash with a migration number another branch claimed. */
export function ensureRequestTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender TEXT,
      agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attention_reason TEXT,
      notified_at INTEGER,
      question TEXT,
      closed_at INTEGER,
      evidence TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_state_created ON requests(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_chat ON requests(agent_id, channel, chat_id, created_at);
    CREATE TABLE IF NOT EXISTS request_links (
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (kind, ref),
      FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_request_links_request ON request_links(request_id);
  `)
  // Added after the first version: a database that already has the table
  // gets the column here.
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === "pickup_at")) {
    try {
      db.exec("ALTER TABLE requests ADD COLUMN pickup_at INTEGER")
    } catch (e: any) {
      // Daemon and dashboard starting together: the other one added it first.
      if (!/duplicate column name/i.test(String(e?.message))) throw e
    }
  }
}

function toRecord(r: any): RequestRecord {
  return {
    id: r.id, state: r.state, channel: r.channel, chatId: r.chat_id, sender: r.sender ?? null,
    agentId: r.agent_id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at,
    attentionReason: r.attention_reason ?? null, notifiedAt: r.notified_at ?? null,
    question: r.question ?? null, closedAt: r.closed_at ?? null,
    evidence: r.evidence ?? null, closeReason: r.close_reason ?? null,
  }
}

const placeholders = (n: number) => Array(n).fill("?").join(",")

export class RequestStore {
  constructor(private db: Database.Database) {
    ensureRequestTables(db)
    db.pragma("foreign_keys = ON")
  }

  /** Note a turn a person started. Linked to its run. */
  addCandidate(input: {
    id: string; runId: string; channel: string; chatId: string; sender?: string | null
    agentId: string; text: string; now: number
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO requests (id, state, channel, chat_id, sender, agent_id, text, created_at, updated_at)
       VALUES (?, 'candidate', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.channel, input.chatId, input.sender ?? null, input.agentId, input.text.slice(0, TEXT_MAX), input.now, input.now)
    this.link(input.id, "run", input.runId, input.now)
  }

  get(id: string): RequestRecord | null {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id)
    return row ? toRecord(row) : null
  }

  /** The request a run, delegation or card belongs to. */
  byLink(kind: LinkKind, ref: string): RequestRecord | null {
    const row = this.db.prepare(
      "SELECT r.* FROM requests r JOIN request_links l ON l.request_id = r.id WHERE l.kind = ? AND l.ref = ?",
    ).get(kind, ref)
    return row ? toRecord(row) : null
  }

  link(requestId: string, kind: LinkKind, ref: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO request_links (request_id, kind, ref, at) VALUES (?, ?, ?, ?)").run(requestId, kind, ref, now)
  }

  links(requestId: string): Array<{ kind: LinkKind; ref: string; at: number }> {
    return this.db.prepare("SELECT kind, ref, at FROM request_links WHERE request_id = ? ORDER BY at, rowid").all(requestId) as any
  }

  /** Something happened under this request: it is not quiet. */
  touch(id: string, now: number): void {
    this.db.prepare("UPDATE requests SET updated_at = ? WHERE id = ?").run(now, id)
  }

  /** Work is under way. Opens a candidate; clears an earlier "needs
   *  attention" so a later failure is raised again. Closed stays closed. */
  progress(id: string, now: number, state: "in_progress" | "waiting_other" = "in_progress"): void {
    this.db.prepare(
      `UPDATE requests SET state = ?, updated_at = ?, attention_reason = NULL, notified_at = NULL, question = NULL
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run(state, now, id, ...CLOSED_STATES)
  }

  /** The next step is the owner's answer. */
  waitOnOwner(id: string, question: string, now: number): void {
    this.db.prepare(
      `UPDATE requests SET state = 'waiting_owner', updated_at = ?, question = ?, attention_reason = NULL, notified_at = NULL
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run(now, question.slice(0, TEXT_MAX), id, ...CLOSED_STATES)
  }

  /** The work failed, timed out, was cut off, or went quiet. A request
   *  already waiting for attention keeps its first reason and is not
   *  raised a second time. */
  needsAttention(id: string, reason: string, now: number): boolean {
    const res = this.db.prepare(
      `UPDATE requests SET state = 'needs_attention', updated_at = ?, attention_reason = ?, notified_at = NULL
       WHERE id = ? AND state NOT IN ('needs_attention', ${placeholders(CLOSED_STATES.length)})`,
    ).run(now, reason.replace(/\s+/g, " ").trim().slice(0, REASON_MAX), id, ...CLOSED_STATES)
    return res.changes > 0
  }

  /** Close it: done needs evidence, declined and dropped need a reason. */
  close(id: string, state: ClosedState, detail: string, now: number): boolean {
    const text = detail.trim()
    if (!text) throw new Error(state === "done" ? "a finished request needs a link to the evidence" : `a ${state} request needs a reason`)
    const res = this.db.prepare(
      `UPDATE requests SET state = ?, closed_at = ?, updated_at = ?, evidence = ?, close_reason = ?
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run(state, now, now, state === "done" ? text.slice(0, REASON_MAX) : null, state === "done" ? null : text.slice(0, REASON_MAX), id, ...CLOSED_STATES)
    return res.changes > 0
  }

  /** A candidate whose turn ended with nothing left to follow. */
  discardCandidate(id: string): boolean {
    return this.db.prepare("DELETE FROM requests WHERE id = ? AND state = 'candidate'").run(id).changes > 0
  }

  /** Open requests, oldest first. */
  listOpen(): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(OPEN_STATES.length)}) ORDER BY created_at, rowid`,
    ).all(...OPEN_STATES).map(toRecord)
  }

  /** Requests in these states that nothing has touched since `before`. */
  quietSince(states: RequestState[], before: number): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(states.length)}) AND updated_at < ? ORDER BY created_at, rowid`,
    ).all(...states, before).map(toRecord)
  }

  /** Requests that need attention and were not raised yet. */
  awaitingNotice(): RequestRecord[] {
    return this.db.prepare(
      "SELECT * FROM requests WHERE state = 'needs_attention' AND notified_at IS NULL ORDER BY created_at, rowid",
    ).all().map(toRecord)
  }

  markNotified(id: string, now: number | null): void {
    this.db.prepare("UPDATE requests SET notified_at = ? WHERE id = ?").run(now, id)
  }

  /** Requests in one state, oldest first. */
  listByState(state: RequestState): RequestRecord[] {
    return this.db.prepare("SELECT * FROM requests WHERE state = ? ORDER BY created_at, rowid").all(state).map(toRecord)
  }

  /** The owner said "pick it up again": back in progress, and the agent
   *  is to be told at the next check. */
  requestPickup(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET state = 'in_progress', updated_at = ?, attention_reason = NULL, notified_at = NULL, pickup_at = ?
       WHERE id = ? AND state = 'needs_attention'`,
    ).run(now, now, id).changes > 0
  }

  /** Requests whose agent has not been told to pick them up yet. Each is
   *  returned once. One statement: a mark the dashboard (another process)
   *  writes meanwhile is either returned here or kept for the next read. */
  takePickups(): RequestRecord[] {
    return this.db.prepare("UPDATE requests SET pickup_at = NULL WHERE pickup_at IS NOT NULL RETURNING *").all()
      .map(toRecord)
      .filter((r) => r.state === "in_progress")
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Delete closed requests older than `before`. Open ones never age out. */
  pruneClosed(before: number): number {
    return this.db.prepare(
      `DELETE FROM requests WHERE state IN (${placeholders(CLOSED_STATES.length)}) AND closed_at < ?`,
    ).run(...CLOSED_STATES, before).changes
  }
}
