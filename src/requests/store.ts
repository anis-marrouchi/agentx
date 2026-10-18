import type Database from "better-sqlite3"
import { ensureColumns, PERSON_COLUMNS } from "@/storage/sqlite"
import { readCloseWhen, type CloseWhen } from "./checkers"

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

export type LinkKind = "run" | "delegation" | "card" | "workflow"

/** Where the work of a request lives (#394): the issue, idea file,
 *  approval, ERP record or Desk card the agent named. A column, not a
 *  request_links kind: links are unique per (kind, ref), and two requests
 *  often land on the same issue. */
export const HOME_KINDS = ["issue", "idea", "approval", "erp", "card"] as const
export type HomeKind = (typeof HOME_KINDS)[number]
export interface RequestHome { kind: HomeKind; link: string }
export const HOME_LINK_MAX = 500

/** What the last run of a loop's checker said (#1039). */
export type VerifyState = "verified" | "unverified" | "failed"

/** Who a loop is owed to: the owner, an agent id, or a known person id. */
export const OWED_TO_OWNER = "owner"

export interface RequestRecord {
  id: string
  state: RequestState
  channel: string
  chatId: string
  sender: string | null
  /** The known person who asked (people, #384), when the sender is one. */
  person: string | null
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
  /** What the owner last wrote on it (a reply, or a note with a hand-off). */
  ownerNote: string | null
  /** That note was given to the agent in a pick-up: it is not said again. */
  noteSaid: boolean
  /** The agent it was asked of, once the owner handed it on. The chat it
   *  was asked in is that agent's: another agent may not be able to write
   *  there (#481). Null: never handed on. */
  askedAgent: string | null
  /** Where the work lives, once the agent named it (#394). */
  home: RequestHome | null
  // --- The open loop (#1039). Null on requests from before it. ---
  /** Who it is owed to: "owner", an agent id, or a known person id. A
   *  request from the owner's turn is owed to its sender. */
  owedTo: string | null
  /** An agent's promise (action promise), not a turn of the owner's. */
  promise: boolean
  /** When it is due, epoch ms. Past it, the loop is stalled. */
  dueAt: number | null
  /** What proves it is finished: the checker the requests check runs. */
  closeWhen: CloseWhen | null
  /** When the checker last ran, and what it said. */
  checkedAt: number | null
  verifiedAt: number | null
  verifyState: VerifyState | null
  /** The checker's last words: its evidence, or why it could not say. */
  verifyDetail: string | null
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
  ensureColumns(db, "requests", PERSON_COLUMNS)
  // Added after the first version: a database that already has the table
  // gets the columns here.
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
  for (const [name, type] of [["pickup_at", "INTEGER"], ["owner_note", "TEXT"], ["note_said", "INTEGER"], ["asked_agent", "TEXT"], ["home_kind", "TEXT"], ["home_link", "TEXT"],
    ["owed_to", "TEXT"], ["promise", "INTEGER"], ["due_at", "INTEGER"], ["close_when", "TEXT"], ["checked_at", "INTEGER"],
    ["verified_at", "INTEGER"], ["verify_state", "TEXT"], ["verify_detail", "TEXT"]]) {
    if (cols.some((c) => c.name === name)) continue
    try {
      db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`)
    } catch (e: any) {
      // Daemon and dashboard starting together: the other one added it first.
      if (!/duplicate column name/i.test(String(e?.message))) throw e
    }
  }
}

/** For readers: a database without the table has no requests, and reading
 *  it must not create one. */
export function hasRequestTables(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()
}

function toRecord(r: any): RequestRecord {
  return {
    id: r.id, state: r.state, channel: r.channel, chatId: r.chat_id, sender: r.sender ?? null, person: r.person ?? null,
    agentId: r.agent_id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at,
    attentionReason: r.attention_reason ?? null, notifiedAt: r.notified_at ?? null,
    question: r.question ?? null, closedAt: r.closed_at ?? null,
    evidence: r.evidence ?? null, closeReason: r.close_reason ?? null, ownerNote: r.owner_note ?? null, noteSaid: !!r.note_said,
    askedAgent: r.asked_agent ?? null,
    home: r.home_kind && r.home_link ? { kind: r.home_kind, link: r.home_link } : null,
    owedTo: r.owed_to ?? null, promise: !!r.promise, dueAt: r.due_at ?? null, closeWhen: readCloseWhen(r.close_when),
    checkedAt: r.checked_at ?? null, verifiedAt: r.verified_at ?? null, verifyState: r.verify_state ?? null, verifyDetail: r.verify_detail ?? null,
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
    person?: string | null; agentId: string; text: string; now: number
  }): void {
    // Owed to whoever asked: the known person, else the sender (#1039).
    const owedTo = input.person ?? input.sender ?? null
    this.db.prepare(
      `INSERT OR IGNORE INTO requests (id, state, channel, chat_id, sender, person, agent_id, text, created_at, updated_at, owed_to)
       VALUES (?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.channel, input.chatId, input.sender ?? null, input.person ?? null, input.agentId, input.text.slice(0, TEXT_MAX), input.now, input.now, owedTo)
    this.link(input.id, "run", input.runId, input.now)
  }

  /** An agent's promise (#1039): open at once, in progress, owed to
   *  `owedTo`. The chat is the one of the turn that made it. */
  addPromise(input: {
    id: string; channel: string; chatId: string; agentId: string; text: string; owedTo: string
    dueAt?: number | null; closeWhen?: CloseWhen | null; home?: RequestHome | null; now: number
  }): void {
    this.db.prepare(
      `INSERT INTO requests (id, state, channel, chat_id, agent_id, text, created_at, updated_at, owed_to, promise, due_at, close_when, home_kind, home_link)
       VALUES (?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      input.id, input.channel, input.chatId, input.agentId, input.text.slice(0, TEXT_MAX), input.now, input.now, input.owedTo,
      input.dueAt ?? null, input.closeWhen ? JSON.stringify(input.closeWhen) : null,
      input.home?.kind ?? null, input.home ? input.home.link.slice(0, HOME_LINK_MAX) : null,
    )
  }

  /** How many open promises this agent holds. */
  openPromises(agentId: string): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND promise = 1 AND state IN (${placeholders(OPEN_STATES.length)})`,
    ).get(agentId, ...OPEN_STATES) as { n: number }).n
  }

  /** Give an open request a due time or a checker, from accept or wait. */
  setLoop(id: string, loop: { dueAt?: number | null; closeWhen?: CloseWhen | null }, now: number): void {
    if (loop.dueAt !== undefined) this.db.prepare("UPDATE requests SET due_at = ?, updated_at = ? WHERE id = ?").run(loop.dueAt, now, id)
    if (loop.closeWhen !== undefined) {
      this.db.prepare("UPDATE requests SET close_when = ?, verify_state = NULL, verify_detail = NULL, updated_at = ? WHERE id = ?")
        .run(loop.closeWhen ? JSON.stringify(loop.closeWhen) : null, now, id)
    }
  }

  /** What the checker said. `met` is written by closeVerified, not here.
   *  Not a touch: a check is not activity on the loop. */
  markChecked(id: string, state: VerifyState | null, detail: string, now: number): void {
    this.db.prepare("UPDATE requests SET checked_at = ?, verify_state = ?, verify_detail = ? WHERE id = ?")
      .run(now, state, detail.slice(0, REASON_MAX) || null, id)
  }

  /** The checker found the evidence: closed as done, with its words. */
  closeVerified(id: string, evidence: string, now: number): boolean {
    const text = evidence.trim().slice(0, REASON_MAX) || "the check was met"
    return this.db.prepare(
      `UPDATE requests SET state = 'done', closed_at = ?, updated_at = ?, evidence = ?, close_reason = NULL,
         checked_at = ?, verified_at = ?, verify_state = 'verified', verify_detail = ?
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run(now, now, text, now, now, text, id, ...CLOSED_STATES).changes > 0
  }

  /** Open loops with a checker whose last run is older than `before`
   *  (or that never ran), oldest check first. */
  dueForCheck(before: number, limit = 50): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(OPEN_STATES.length)}) AND close_when IS NOT NULL
         AND (checked_at IS NULL OR checked_at < ?) ORDER BY COALESCE(checked_at, 0), created_at LIMIT ?`,
    ).all(...OPEN_STATES, before, limit).map(toRecord)
  }

  /** Open loops past their due time with nothing done since it passed,
   *  or quiet since `quietBefore` (the owner handed one on after it fell
   *  due: it gets the usual quiet time). A loop waiting on the owner is
   *  left alone: its question reminds them. */
  overdue(now: number, quietBefore: number): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN ('in_progress', 'waiting_other') AND due_at IS NOT NULL AND due_at < ?
         AND (updated_at <= due_at OR updated_at < ?)
       ORDER BY due_at, rowid`,
    ).all(now, quietBefore).map(toRecord)
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

  /** The agent's newest answer under this request: the final reply of its
   *  latest linked run that has one. Null when nothing was recorded, or
   *  when this database has no traces. */
  lastAnswer(requestId: string): { agentId: string; text: string; at: number } | null {
    try {
      const row = this.db.prepare(
        `SELECT t.agent_id AS agentId, t.final_response AS text, COALESCE(t.finished_at, t.started_at) AS at
         FROM request_links l JOIN task_traces t ON t.task_id = l.ref
         WHERE l.request_id = ? AND l.kind = 'run' AND t.final_response IS NOT NULL AND t.final_response != ''
         ORDER BY t.started_at DESC LIMIT 1`,
      ).get(requestId) as { agentId: string; text: string; at: number } | undefined
      return row ?? null
    } catch {
      return null
    }
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

  /** Requests in these states that nothing has touched since `before`.
   *  A loop with a due time is judged by that, not by quiet (#1039). */
  quietSince(states: RequestState[], before: number): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(states.length)}) AND updated_at < ? AND due_at IS NULL ORDER BY created_at, rowid`,
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

  /** Requests closed since `since`, newest first. */
  listClosedSince(since: number, limit = 50): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(CLOSED_STATES.length)}) AND closed_at >= ? ORDER BY closed_at DESC, rowid DESC LIMIT ?`,
    ).all(...CLOSED_STATES, since, limit).map(toRecord)
  }

  /** Every request made since `since`, open or closed, oldest first: the
   *  "what did I ask today" list (#394). Candidates are not requests yet.
   *  Past `limit` it keeps the newest: the oldest are the ones dropped. */
  listSince(since: number, limit = 500): RequestRecord[] {
    return this.db.prepare(
      "SELECT * FROM requests WHERE state != 'candidate' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(since, limit).map(toRecord).reverse()
  }

  /** Name where the work lives. A later home replaces an earlier one. */
  setHome(id: string, home: RequestHome, now: number): void {
    this.db.prepare("UPDATE requests SET home_kind = ?, home_link = ?, updated_at = ? WHERE id = ?")
      .run(home.kind, home.link.slice(0, HOME_LINK_MAX), now, id)
  }

  /** The owner said "pick it up again": back in progress, and the agent
   *  is to be told at the next check. */
  requestPickup(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET state = 'in_progress', updated_at = ?, attention_reason = NULL, notified_at = NULL, pickup_at = ?
       WHERE id = ? AND state = 'needs_attention'`,
    ).run(now, now, id).changes > 0
  }

  /** The owner replied, or handed it to an agent (the same or another):
   *  that agent has it, in progress, and is told at the next check. Any
   *  open request, not only one that needs attention. The agent it was
   *  asked of is kept from the first time: channel and chat stay its own. */
  handOff(id: string, agentId: string, note: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET agent_id = ?, state = 'in_progress', updated_at = ?, attention_reason = NULL, notified_at = NULL,
         question = NULL, pickup_at = ?, owner_note = ?, note_said = NULL, asked_agent = COALESCE(asked_agent, agent_id)
       WHERE id = ? AND state IN (${placeholders(OPEN_STATES.length)})`,
    ).run(agentId, now, now, note.trim().slice(0, TEXT_MAX) || null, id, ...OPEN_STATES).changes > 0
  }

  /** This note of the owner is given to the agent in a pick-up, or (false)
   *  was not after all. Only while it is still the note on the request: a
   *  reply written since has its own pick-up and its own mark. */
  setNoteSaid(id: string, note: string, said: boolean): void {
    this.db.prepare(`UPDATE requests SET note_said = ? WHERE id = ? AND owner_note = ?${said ? " AND pickup_at IS NULL" : ""}`).run(said ? 1 : null, id, note)
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
