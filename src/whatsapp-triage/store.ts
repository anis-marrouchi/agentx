import type Database from "better-sqlite3"
import type { WaMessage } from "./message"
import { normalizeJid } from "./rules"

// --- Watched messages and triage results (SQLite) ---
//
// One row per watched message, keyed by chat + WhatsApp message id. The
// key is the idempotency key: wacli redelivering a message, or the daemon
// restarting, never makes a second task. A message moves queued → taken
// (handed to the agent) → done. After a restart, queued rows are triaged;
// taken rows are not handed over again, because the agent may already
// have opened an issue for them.
//
// Messages that match no rule never reach this store.

export type TriageClass = "ack" | "action" | "fyi" | "ignore"
export const TRIAGE_CLASSES: readonly TriageClass[] = ["ack", "action", "fyi", "ignore"]

export interface QueuedMessage {
  key: string
  ruleId: string
  message: WaMessage
}

export interface TriageLogRow {
  id: number
  at: number
  ruleId: string
  chat: string
  chatName: string | null
  messages: number
  /** null when the agent's answer could not be read. */
  triage: TriageClass | null
  summary: string
  draftId: string | null
  error: string | null
}

const KEEP_MS = 30 * 86_400_000

export function messageKey(msg: Pick<WaMessage, "chat" | "id">): string {
  return `${normalizeJid(msg.chat)}|${msg.id}`
}

export class TriageStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_triage_messages (
      key TEXT PRIMARY KEY, rule_id TEXT NOT NULL, chat TEXT NOT NULL,
      message_json TEXT NOT NULL, status TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS whatsapp_triage_messages_status ON whatsapp_triage_messages(status);
      CREATE TABLE IF NOT EXISTS whatsapp_triage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, rule_id TEXT NOT NULL,
      chat TEXT NOT NULL, chat_name TEXT, messages INTEGER NOT NULL, triage TEXT,
      summary TEXT NOT NULL, draft_id TEXT, error TEXT);`)
  }

  /** Records a watched message. False when it was seen before. */
  add(ruleId: string, msg: WaMessage, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const r = this.db.prepare(
        "INSERT OR IGNORE INTO whatsapp_triage_messages (key, rule_id, chat, message_json, status, received_at) VALUES (?, ?, ?, ?, 'queued', ?)",
      ).run(messageKey(msg), ruleId, normalizeJid(msg.chat), JSON.stringify(msg), now)
      if (r.changes === 0) return false
      this.db.prepare("DELETE FROM whatsapp_triage_messages WHERE status != 'queued' AND received_at < ?").run(now - KEEP_MS)
      return true
    }).immediate()
  }

  /** Messages still waiting for triage, oldest first. */
  queued(): QueuedMessage[] {
    const rows = this.db.prepare(
      "SELECT key, rule_id, message_json FROM whatsapp_triage_messages WHERE status = 'queued' ORDER BY received_at, key",
    ).all() as Array<{ key: string; rule_id: string; message_json: string }>
    return rows.map((r) => ({ key: r.key, ruleId: r.rule_id, message: JSON.parse(r.message_json) as WaMessage }))
  }

  /** Claims queued messages for one agent run. Returns the keys this call
   *  claimed; a key another run already took is left out. */
  take(keys: readonly string[]): string[] {
    return this.db.transaction(() => {
      const stmt = this.db.prepare("UPDATE whatsapp_triage_messages SET status = 'taken' WHERE key = ? AND status = 'queued'")
      return keys.filter((k) => stmt.run(k).changes > 0)
    }).immediate()
  }

  finish(keys: readonly string[]): void {
    const stmt = this.db.prepare("UPDATE whatsapp_triage_messages SET status = 'done' WHERE key = ?")
    this.db.transaction(() => { for (const k of keys) stmt.run(k) })()
  }

  log(row: Omit<TriageLogRow, "id" | "at">, now = Date.now()): void {
    this.db.prepare(
      "INSERT INTO whatsapp_triage_log (at, rule_id, chat, chat_name, messages, triage, summary, draft_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(now, row.ruleId, row.chat, row.chatName, row.messages, row.triage, row.summary, row.draftId, row.error)
    this.db.prepare("DELETE FROM whatsapp_triage_log WHERE at < ?").run(now - KEEP_MS)
  }

  recent(limit = 20): TriageLogRow[] {
    const rows = this.db.prepare("SELECT * FROM whatsapp_triage_log ORDER BY id DESC LIMIT ?").all(limit) as any[]
    return rows.map((r) => ({
      id: r.id, at: r.at, ruleId: r.rule_id, chat: r.chat, chatName: r.chat_name, messages: r.messages,
      triage: r.triage, summary: r.summary, draftId: r.draft_id, error: r.error,
    }))
  }
}
