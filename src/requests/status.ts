import type Database from "better-sqlite3"

// --- Request status: where a person's request stands, for that person (#383) ---
//
// One row per request made on a channel that has status turned on
// (`requestStatus.channels`). The row is what the status comment on a
// GitLab or GitHub thread shows. It is kept apart from the owner's open
// requests (store.ts): those follow what the owner asked for until someone
// closes it; this follows anyone's request until its work ends.
//
// A row holds nothing about the node or about other people's work: an
// error text never gets here, only that the work failed.

export type StatusState = "queued" | "working" | "waiting" | "done" | "failed" | "timed_out" | "restart" | "stopped"

/** States after which nothing more happens under the request. */
export const FINAL_STATES: readonly StatusState[] = ["done", "failed", "timed_out", "restart", "stopped"]

export interface StatusRow {
  id: string
  channel: string
  chatId: string
  agentId: string
  /** The sender's id on that channel, for "my requests only". */
  senderId: string | null
  state: StatusState
  /** Who the work waits on, while waiting. */
  waitingOn: string | null
  /** When the current state began. */
  since: number
  /** Delegations handed out and not back yet. */
  pending: number
  /** The turn that received the request is still running. */
  turnLive: boolean
  /** The status comment, once posted. */
  commentRef: string | null
  /** The text that comment shows now. */
  shown: string | null
  createdAt: number
  updatedAt: number
}

export type RefKind = "run" | "delegation" | "card"

function toRow(r: any): StatusRow {
  return {
    id: r.id, channel: r.channel, chatId: r.chat_id, agentId: r.agent_id, senderId: r.sender_id ?? null,
    state: r.state, waitingOn: r.waiting_on ?? null, since: r.since, pending: r.pending,
    turnLive: !!r.turn_live, commentRef: r.comment_ref ?? null, shown: r.shown ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

const FINAL_SQL = FINAL_STATES.map((s) => `'${s}'`).join(",")

export class StatusStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_status (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        sender_id TEXT,
        state TEXT NOT NULL,
        waiting_on TEXT,
        since INTEGER NOT NULL,
        pending INTEGER NOT NULL DEFAULT 0,
        turn_live INTEGER NOT NULL DEFAULT 0,
        comment_ref TEXT,
        shown TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_status_chat ON request_status(agent_id, channel, chat_id, created_at);
      CREATE TABLE IF NOT EXISTS request_status_refs (
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        status_id TEXT NOT NULL,
        PRIMARY KEY (kind, ref),
        FOREIGN KEY (status_id) REFERENCES request_status(id) ON DELETE CASCADE
      );
    `)
    db.pragma("foreign_keys = ON")
  }

  add(input: {
    id: string; channel: string; chatId: string; agentId: string; senderId?: string | null
    state: "queued" | "working"; now: number
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO request_status (id, channel, chat_id, agent_id, sender_id, state, since, turn_live, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.channel, input.chatId, input.agentId, input.senderId ?? null, input.state, input.now, input.state === "working" ? 1 : 0, input.now, input.now)
  }

  get(id: string): StatusRow | null {
    const row = this.db.prepare("SELECT * FROM request_status WHERE id = ?").get(id)
    return row ? toRow(row) : null
  }

  /** The request a run or a delegation belongs to. */
  byRef(kind: RefKind, ref: string): StatusRow | null {
    const row = this.db.prepare(
      "SELECT s.* FROM request_status s JOIN request_status_refs r ON r.status_id = s.id WHERE r.kind = ? AND r.ref = ?",
    ).get(kind, ref)
    return row ? toRow(row) : null
  }

  ref(id: string, kind: RefKind, ref: string): void {
    this.db.prepare("INSERT OR IGNORE INTO request_status_refs (kind, ref, status_id) VALUES (?, ?, ?)").run(kind, ref, id)
  }

  /** The newest request of this agent in this chat that matches. */
  inChat(agentId: string, channel: string, chatId: string, where: "queued" | "live"): StatusRow | null {
    const row = this.db.prepare(
      `SELECT * FROM request_status WHERE agent_id = ? AND channel = ? AND chat_id = ?
       AND ${where === "queued" ? "state = 'queued'" : "turn_live = 1"} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(agentId, channel, chatId)
    return row ? toRow(row) : null
  }

  /** Change a row. `since` moves only when the state does. */
  set(id: string, patch: Partial<Pick<StatusRow, "state" | "waitingOn" | "pending" | "turnLive">>, now: number): void {
    const cur = this.get(id)
    if (!cur) return
    const state = patch.state ?? cur.state
    this.db.prepare(
      "UPDATE request_status SET state = ?, waiting_on = ?, pending = ?, turn_live = ?, since = ?, updated_at = ? WHERE id = ?",
    ).run(
      state,
      state === "waiting" ? (patch.waitingOn ?? cur.waitingOn) : null,
      Math.max(0, patch.pending ?? cur.pending),
      (patch.turnLive ?? cur.turnLive) ? 1 : 0,
      state === cur.state ? cur.since : now,
      now,
      id,
    )
  }

  posted(id: string, commentRef: string, shown: string): void {
    this.db.prepare("UPDATE request_status SET comment_ref = ?, shown = ? WHERE id = ?").run(commentRef, shown, id)
  }

  /** Requests whose work has not ended. */
  open(): StatusRow[] {
    return this.db.prepare(`SELECT * FROM request_status WHERE state NOT IN (${FINAL_SQL}) ORDER BY created_at, rowid`).all().map(toRow)
  }

  /** Rows changed since `after`: the ones whose comment may be behind. */
  changedSince(after: number): StatusRow[] {
    return this.db.prepare("SELECT * FROM request_status WHERE updated_at >= ? ORDER BY created_at, rowid").all(after).map(toRow)
  }

  /** Delete ended requests older than `before`. Open ones never age out. */
  prune(before: number): number {
    return this.db.prepare(`DELETE FROM request_status WHERE state IN (${FINAL_SQL}) AND updated_at < ?`).run(before).changes
  }
}

/** Hidden in every status comment. A forge adapter that sees it on a
 *  comment from an account AgentX posts with drops the comment whoever
 *  signed it: a status is never a message to an agent. */
export const STATUS_TAG = "<!-- agentx-status -->"

export const isStatusComment = (body: string | undefined | null): boolean => !!body && body.includes(STATUS_TAG)

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`

/** The words of the status comment. Says only what the person who asked
 *  may know: the agent they asked, the state, the time, and who the work
 *  waits on. */
export function statusText(r: Pick<StatusRow, "state" | "agentId" | "waitingOn" | "since">): string {
  const at = when(r.since)
  const line: Record<StatusState, string> = {
    queued: `**Queued** since ${at}. ${r.agentId} is busy and starts this next.`,
    working: `**Working** since ${at}.`,
    waiting: `**Waiting on ${r.waitingOn ?? "someone"}** since ${at}.`,
    done: `**Done** at ${at}.`,
    failed: `**Failed** at ${at}. Nothing is retrying it: ask again.`,
    timed_out: `**Timed out** at ${at}. Nothing is retrying it: ask again.`,
    restart: `**Cut off by a restart** and not picked up again (noted ${at}). Ask again.`,
    stopped: `**Stopped** at ${at}.`,
  }
  return `Request status: ${line[r.state]}\n\n_${r.agentId} keeps this comment up to date; it is edited, not repeated._\n${STATUS_TAG}`
}
