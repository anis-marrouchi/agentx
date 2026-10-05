import type Database from "better-sqlite3"

// --- Messages waiting in line behind a busy agent (#443) ---
//
// The registry keeps the line itself in memory (agents/message-queue.ts).
// This table mirrors what is waiting right now, with the person who sent
// each message, so the member page, which runs in the dashboard and reads
// the database only, can tell a teammate how many messages are ahead of
// theirs. A row lives from the moment the message is queued to the moment
// the line is handed over to a new turn; nothing waits here for long, and
// the daemon empties the table when it boots, since the line it mirrors
// did not survive the restart.
//
// The preview is the first 200 characters of the message. The member page
// shows it only to the person who sent it; of anyone else's message it
// reads the count alone.

export const QUEUED_PREVIEW_MAX = 200

export interface QueuedMessageRow {
  id: number
  agentId: string
  channel: string
  chatId: string
  /** The person who sent it (people, #384), when known. */
  person: string | null
  sender: string | null
  messagePreview: string | null
  queuedAt: number
}

export function ensureQueuedMessagesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queued_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      person TEXT,
      sender TEXT,
      message_preview TEXT,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queued_messages_agent ON queued_messages(agent_id, queued_at);
  `)
}

export function insertQueuedMessage(db: Database.Database, m: {
  agentId: string; channel: string; chatId: string
  person?: string | null; sender?: string | null; messagePreview?: string | null; queuedAt: number
}): void {
  db.prepare(`
    INSERT INTO queued_messages (agent_id, channel, chat_id, person, sender, message_preview, queued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.agentId, m.channel, m.chatId, m.person ?? null, m.sender?.slice(0, 120) ?? null,
    m.messagePreview == null ? null : String(m.messagePreview).replace(/\s+/g, " ").trim().slice(0, QUEUED_PREVIEW_MAX),
    m.queuedAt,
  )
}

/** The line of one chat was handed over to a new turn: the messages queued
 *  up to `flushedAt` are no longer waiting. One queued again after that
 *  moment (the slot was taken meanwhile) has a newer row and stays. */
export function flushQueuedMessages(db: Database.Database, agentId: string, channel: string, chatId: string, flushedAt: number): number {
  const r = db.prepare(
    "DELETE FROM queued_messages WHERE agent_id = ? AND channel = ? AND chat_id = ? AND queued_at <= ?",
  ).run(agentId, channel, chatId, flushedAt)
  return r.changes ?? 0
}

/** The daemon starts: the line it kept in memory is gone, so is its mirror. */
export function clearQueuedMessages(db: Database.Database): number {
  return db.prepare("DELETE FROM queued_messages").run().changes ?? 0
}

/** Everything waiting now, oldest first. Small: a line holds a handful of
 *  messages, and only while an agent is busy. */
export function listQueuedMessages(db: Database.Database): QueuedMessageRow[] {
  const rows = db.prepare(
    "SELECT id, agent_id, channel, chat_id, person, sender, message_preview, queued_at FROM queued_messages ORDER BY queued_at, id LIMIT 500",
  ).all() as Array<Record<string, any>>
  return rows.map((r) => ({
    id: r.id, agentId: r.agent_id, channel: r.channel, chatId: r.chat_id,
    person: r.person ?? null, sender: r.sender ?? null, messagePreview: r.message_preview ?? null, queuedAt: r.queued_at,
  }))
}
