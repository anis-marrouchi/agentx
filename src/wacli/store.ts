import type Database from "better-sqlite3"

// --- Watched WhatsApp messages: dedup and the pending batch ---
//
// One row per WhatsApp message (key = chat + message id), so a replay from
// wacli or a restart never makes a second task. A row holds the message
// only while it waits for its batch; claiming the batch clears the text
// and keeps the key. Claimed keys are kept 30 days.
//
// Claim-before-dispatch: a batch is claimed before the agent sees it, so a
// crash mid-triage loses that batch (logged) rather than running it twice,
// which could open a tracker issue twice. Unclaimed rows survive restarts
// and are triaged on boot.
//
// Only messages a rule matched reach this store.

const KEEP_MS = 30 * 24 * 60 * 60_000

export interface PendingBatch {
  chat: string
  rule: string
  /** When its first message arrived. */
  since: number
}

export class WacliStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS wacli_messages (
      key TEXT PRIMARY KEY,
      chat TEXT NOT NULL,
      rule TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      payload TEXT,
      claimed_at INTEGER)`)
    db.exec("CREATE INDEX IF NOT EXISTS wacli_messages_pending ON wacli_messages (chat, rule) WHERE claimed_at IS NULL")
  }

  static key(chat: string, id: string): string {
    return `${chat}\u0000${id}`
  }

  /** Save a matched message. False when this message was seen before. */
  add(chat: string, id: string, rule: string, payload: unknown, now = Date.now()): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO wacli_messages (key, chat, rule, received_at, payload) VALUES (?, ?, ?, ?, ?)")
      .run(WacliStore.key(chat, id), chat, rule, now, JSON.stringify(payload))
    return r.changes > 0
  }

  /** Batches still waiting, e.g. after a restart. */
  pending(): PendingBatch[] {
    return (this.db.prepare(`SELECT chat, rule, MIN(received_at) AS since FROM wacli_messages
      WHERE claimed_at IS NULL GROUP BY chat, rule`).all() as PendingBatch[])
  }

  /** Take every waiting message of one chat and rule, oldest first. */
  claim(chat: string, rule: string, now = Date.now()): unknown[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT key, payload FROM wacli_messages
        WHERE chat = ? AND rule = ? AND claimed_at IS NULL ORDER BY received_at, key`).all(chat, rule) as Array<{ key: string; payload: string | null }>
      const mark = this.db.prepare("UPDATE wacli_messages SET claimed_at = ?, payload = NULL WHERE key = ?")
      const out: unknown[] = []
      for (const row of rows) {
        mark.run(now, row.key)
        try { if (row.payload) out.push(JSON.parse(row.payload)) } catch { /* a row that can't be read is dropped with its claim */ }
      }
      return out
    }).immediate()
  }

  prune(now = Date.now()): number {
    return this.db.prepare("DELETE FROM wacli_messages WHERE claimed_at IS NOT NULL AND claimed_at < ?").run(now - KEEP_MS).changes
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM wacli_messages").get() as { n: number }).n
  }
}
