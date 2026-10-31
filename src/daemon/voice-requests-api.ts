// AgentX Voice's open-requests list, kept by the daemon (#1455).
//
// The Mac widget sends a request and moves on; its answer waits as "not
// heard" until the owner picks it from the list. Until now the widget kept
// that list in its own memory, so quitting it or restarting the daemon lost
// it, and nothing else could see what was open or heard. Here the daemon
// keeps it in SQLite, and every client reads the same rows.
//
//   GET  /voice/requests
//        {requests}: the open rows, oldest first (the order they were sent).
//        Summaries: the question, the state, heard or not, why it failed.
//   POST /voice/requests  {agentId, question, waiting?}
//        A new row, thinking, or waiting behind another request for the
//        same agent. 201 {request}. The client then asks with
//        POST /ask {..., request: <id>}, which moves the row along.
//   GET  /voice/requests/:id
//        One row with its answer as /ask returned it ({request, reply}).
//   POST /voice/requests/:id/heard
//        Played or opened: heard from now on, on every client.
//   POST /voice/requests/:id/close  {stop?}
//        Leaves the list. A thinking agent keeps working unless `stop` is
//        true: then its voice turn is stopped. The answer of a closed row
//        still lands in History. 200 {request, stopped}.
//   POST /voice/requests/:id/reopen
//        Undo a close.
//   POST /voice/requests/:id/continue  {question, waiting?}
//        A follow-up spoken with the row picked: the same row asks again
//        with these words, not heard, instead of a new row being added.
//   POST /voice/requests/close-heard
//        Closes every heard answer and every failure. {closed}.
//
// Gated like /voice/history (isMeshGatedPath): the rows hold what was
// asked and answered out loud.
//
// The phone: a request /ask runs for one of this node's agents goes in the
// phone app's conversation with that agent (voice-phone-thread.ts), the
// row keeps that conversation's id, and heard is one state for both. A
// row heard here marks the conversation read on the phone; the phone
// opening the conversation after the answer came makes the row heard.

import type Database from "better-sqlite3"
import { randomBytes } from "crypto"
import type { Reply } from "@/daemon/voice-talk-api"
import { AppChatStore } from "@/daemon/app-chat-store"

export type VoiceRequestState = "waiting" | "thinking" | "answered" | "failed"

export interface VoiceRequest {
  id: string
  agentId: string
  question: string
  state: VoiceRequestState
  /** When it was sent, ms since the epoch. */
  sentAt: number
  /** When it started thinking, or when its answer came back. */
  since: number
  /** Its answer, or why it failed, has been played or opened. */
  heard: boolean
  /** Why it failed, in one line. */
  error: string | null
  /** Closed rows are not listed; a reopen brings one back. */
  closed: boolean
  /** The phone app's conversation it ran in, if any. */
  conversationId: string | null
}

export const LIMITS = {
  question: 2_000,
  /** The /ask reply kept for a row, as JSON. A voice answer is short. */
  reply: 64_000,
  error: 300,
  /** Heard rows kept in the list; the oldest beyond this close by themselves. */
  keptHeard: 8,
  /** Rows listed at most. */
  open: 50,
  /** Closed rows are forgotten after this long. */
  closedDays: 7,
} as const

/** Why a request that was thinking when the daemon stopped has no answer. */
export const RESTART_REASON = "AgentX restarted before the answer came back. Ask again."

const ID_RE = /^r[a-z0-9]{8,32}$/

export function isVoiceRequestsPath(path: string): boolean {
  return path === "/voice/requests" || path.startsWith("/voice/requests/")
}

/** A row with its phone conversation's read time: heard when either says
 *  so. `read_at` is the phone's (app-chat-store.ts). */
const SELECT_ROWS = `SELECT v.*, c.read_at AS phone_read_at FROM voice_requests v
  LEFT JOIN app_chat_conversations c ON c.id = v.conversation_id`

/** Heard here, or its conversation opened on the phone after it was done. */
const HEARD_SQL = `(heard_at IS NOT NULL OR (state IN ('answered', 'failed') AND EXISTS
  (SELECT 1 FROM app_chat_conversations c WHERE c.id = voice_requests.conversation_id AND c.read_at >= voice_requests.since)))`

export class VoiceRequestStore {
  /** The phone app's conversations, in the same database. */
  readonly chats: AppChatStore

  constructor(private db: Database.Database, now = Date.now()) {
    db.exec(`CREATE TABLE IF NOT EXISTS voice_requests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, question TEXT NOT NULL,
      state TEXT NOT NULL, sent_at INTEGER NOT NULL, since INTEGER NOT NULL,
      heard_at INTEGER, closed_at INTEGER, reply TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS voice_requests_open ON voice_requests(closed_at, sent_at)`)
    const cols = db.prepare("PRAGMA table_info(voice_requests)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === "conversation_id")) db.exec("ALTER TABLE voice_requests ADD COLUMN conversation_id TEXT")
    this.chats = new AppChatStore(db)
    // The /ask that was holding a thinking row died with the last daemon:
    // nothing will ever answer it. Say so instead of thinking forever.
    db.prepare("UPDATE voice_requests SET state = 'failed', error = ?, since = ? WHERE state = 'thinking'")
      .run(RESTART_REASON, now)
    db.prepare("DELETE FROM voice_requests WHERE closed_at IS NOT NULL AND closed_at < ?")
      .run(now - LIMITS.closedDays * 24 * 60 * 60_000)
  }

  /** Open rows, oldest first. */
  list(): VoiceRequest[] {
    return (this.db.prepare(`${SELECT_ROWS} WHERE v.closed_at IS NULL
      ORDER BY v.sent_at, v.rowid LIMIT ?`).all(LIMITS.open) as any[]).map(toRequest)
  }

  get(id: string): VoiceRequest | null {
    if (!ID_RE.test(id)) return null
    const row = this.db.prepare(`${SELECT_ROWS} WHERE v.id = ?`).get(id) as any
    return row ? toRequest(row) : null
  }

  /** The answer as /ask returned it, or null. */
  reply(id: string): unknown {
    if (!ID_RE.test(id)) return null
    const row = this.db.prepare("SELECT reply FROM voice_requests WHERE id = ?").get(id) as { reply: string | null } | undefined
    if (!row?.reply) return null
    try { return JSON.parse(row.reply) } catch { return null }
  }

  create(agentId: string, question: string, waiting = false, now = Date.now()): VoiceRequest {
    const id = `r${now.toString(36)}${randomBytes(4).toString("hex")}`
    this.db.prepare(`INSERT INTO voice_requests (id, agent_id, question, state, sent_at, since)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, agentId, question.slice(0, LIMITS.question), waiting ? "waiting" : "thinking", now, now)
    // Too many open: the oldest that are done leave first, never one still
    // with its agent.
    const extra = (this.db.prepare("SELECT COUNT(*) AS n FROM voice_requests WHERE closed_at IS NULL").get() as { n: number }).n - LIMITS.open
    if (extra > 0) {
      this.db.prepare(`UPDATE voice_requests SET closed_at = ? WHERE id IN (SELECT id FROM voice_requests
        WHERE closed_at IS NULL AND state IN ('answered', 'failed') ORDER BY heard_at IS NULL, sent_at LIMIT ?)`).run(now, extra)
    }
    return this.get(id)!
  }

  /** A follow-up spoken with the row picked: the row asks again with
   *  `question`, its last answer and heard gone, instead of a new row. */
  followUp(id: string, question: string, waiting = false, now = Date.now()): VoiceRequest | null {
    if (!ID_RE.test(id)) return null
    this.db.prepare(`UPDATE voice_requests SET question = ?, state = ?, since = ?,
      heard_at = NULL, reply = NULL, error = NULL, closed_at = NULL WHERE id = ?`)
      .run(question.slice(0, LIMITS.question), waiting ? "waiting" : "thinking", now, id)
    return this.get(id)
  }

  /** It runs in the phone's conversation `conversationId`. */
  link(id: string, conversationId: string): void {
    if (!ID_RE.test(id)) return
    this.db.prepare("UPDATE voice_requests SET conversation_id = ? WHERE id = ?").run(conversationId, id)
  }

  /** /ask took it: thinking from now. */
  start(id: string, now = Date.now()): void {
    if (!ID_RE.test(id)) return
    this.db.prepare("UPDATE voice_requests SET state = 'thinking', since = ? WHERE id = ? AND state IN ('waiting', 'thinking')").run(now, id)
  }

  /** /ask answered with `status` and `body`. A 2xx without an error is an
   *  answer; anything else is a failure. Words the daemon took for the
   *  floor holder's sound (`dropped`) were never a request: the row goes. */
  settle(id: string, status: number, body: Record<string, unknown>, now = Date.now()): void {
    if (!ID_RE.test(id)) return
    if (body?.dropped) {
      this.db.prepare("DELETE FROM voice_requests WHERE id = ?").run(id)
      return
    }
    // Queued (202): the answer goes to the agent's queue, never to this row.
    const error = typeof body?.error === "string" && body.error ? body.error
      : body?.queued === true ? (typeof body.text === "string" && body.text ? body.text : "The agent was busy.") : null
    if (status >= 200 && status < 300 && !error) {
      let reply = JSON.stringify(body)
      if (reply.length > LIMITS.reply) reply = JSON.stringify({ ...body, full: null, ui: null })
      this.db.prepare("UPDATE voice_requests SET state = 'answered', since = ?, reply = ?, error = NULL WHERE id = ?").run(now, reply, id)
    } else {
      const why = error ?? `The daemon answered ${status}.`
      this.db.prepare("UPDATE voice_requests SET state = 'failed', since = ?, error = ? WHERE id = ?").run(now, oneLine(why, LIMITS.error), id)
    }
  }

  /** Played or opened. Beyond `keptHeard` heard rows, the oldest close. */
  heard(id: string, now = Date.now()): VoiceRequest | null {
    const r = this.get(id)
    if (!r) return null
    if (r.state !== "answered" && r.state !== "failed") return r
    this.db.prepare("UPDATE voice_requests SET heard_at = COALESCE(heard_at, ?) WHERE id = ?").run(now, id)
    this.readOnPhone(r, now)
    this.db.prepare(`UPDATE voice_requests SET closed_at = ? WHERE id IN (SELECT id FROM voice_requests
      WHERE closed_at IS NULL AND ${HEARD_SQL} ORDER BY sent_at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
      .run(now, LIMITS.keptHeard)
    return this.get(id)
  }

  /** Closing an answer not heard yet reads it on the phone as well. */
  close(id: string, now = Date.now()): VoiceRequest | null {
    if (!ID_RE.test(id)) return null
    this.db.prepare("UPDATE voice_requests SET closed_at = COALESCE(closed_at, ?) WHERE id = ?").run(now, id)
    const r = this.get(id)
    if (r && !r.heard && (r.state === "answered" || r.state === "failed")) this.readOnPhone(r, now)
    return r
  }

  /** The row's phone conversation is read up to `now`, on its own phone. */
  private readOnPhone(r: VoiceRequest, now: number): void {
    if (!r.conversationId) return
    const owner = this.chats.ownerOf(r.conversationId)
    if (owner) this.chats.markRead(owner, r.conversationId, now)
  }

  reopen(id: string): VoiceRequest | null {
    if (!ID_RE.test(id)) return null
    this.db.prepare("UPDATE voice_requests SET closed_at = NULL WHERE id = ?").run(id)
    return this.get(id)
  }

  /** Every heard answer and every failure leaves. How many left. */
  closeHeard(now = Date.now()): number {
    return this.db.prepare(`UPDATE voice_requests SET closed_at = ? WHERE closed_at IS NULL
      AND ((state = 'answered' AND ${HEARD_SQL}) OR state = 'failed')`).run(now).changes
  }
}

function toRequest(r: any): VoiceRequest {
  const done = r.state === "answered" || r.state === "failed"
  const readOnPhone = done && r.phone_read_at != null && r.phone_read_at >= r.since
  return {
    id: r.id, agentId: r.agent_id, question: r.question, state: r.state,
    sentAt: r.sent_at, since: r.since, heard: r.heard_at != null || readOnPhone,
    error: r.error ?? null, closed: r.closed_at != null,
    conversationId: r.conversation_id ?? null,
  }
}

function oneLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export interface VoiceRequestsDeps {
  store: VoiceRequestStore | null
  /** Is this an agent /ask can reach (here or on a mesh peer)? */
  knows: (agentId: string) => boolean
  /** Stop the request's turn: its agent's run in the request's phone
   *  conversation, else its voice turn. How many runs were stopped. */
  stop: (request: VoiceRequest) => number
}

export function handleVoiceRequests(
  deps: VoiceRequestsDeps,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Reply {
  const store = deps.store
  if (!store) return { status: 503, body: { error: "sqlite not opened" } }

  if (path === "/voice/requests") {
    if (method === "GET") return { status: 200, body: { requests: store.list() } }
    if (method !== "POST") return { status: 405, body: { error: "GET or POST" } }
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : ""
    const question = typeof body.question === "string" ? body.question.trim() : ""
    if (!agentId || !question) return { status: 400, body: { error: "Send agentId and question" } }
    if (!deps.knows(agentId)) return { status: 404, body: { error: `Unknown agent: "${agentId}"` } }
    return { status: 201, body: { request: store.create(agentId, question, body.waiting === true) } }
  }

  if (path === "/voice/requests/close-heard") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    return { status: 200, body: { closed: store.closeHeard() } }
  }

  const [, , , id, action, extra] = path.split("/")
  if (!id || extra !== undefined) return { status: 404, body: { error: "Not found" } }
  const found = store.get(id)
  if (!found) return { status: 404, body: { error: `No voice request ${id}` } }

  if (action === undefined) {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    return { status: 200, body: { request: found, reply: store.reply(id) } }
  }
  if (method !== "POST") return { status: 405, body: { error: "POST" } }

  switch (action) {
    case "heard":
      return { status: 200, body: { request: store.heard(id) } }
    case "close": {
      // Stopping is never implied: only an explicit stop, and only while
      // the agent is still on it.
      const stopped = body.stop === true && found.state === "thinking" ? deps.stop(found) : 0
      return { status: 200, body: { request: store.close(id), stopped } }
    }
    case "reopen":
      return { status: 200, body: { request: store.reopen(id) } }
    case "continue": {
      const question = typeof body.question === "string" ? body.question.trim() : ""
      if (!question) return { status: 400, body: { error: "Send question" } }
      return { status: 200, body: { request: store.followUp(id, question, body.waiting === true) } }
    }
    default:
      return { status: 404, body: { error: "Not found" } }
  }
}
