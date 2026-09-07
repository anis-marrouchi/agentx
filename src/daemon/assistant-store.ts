// --- Conversations with the ask-an-agent drawer ---------------------------
//
// The dashboard is server-rendered and multi-page, so navigating throws away
// every bit of browser state. Keeping the conversation in the page meant a
// turn died the moment you clicked a tab — exactly when you would want to go
// look at the thing you just asked about.
//
// So the thread lives here. A question is accepted, answered in the
// background, and written back; the drawer polls. Navigating, closing the
// drawer, or reloading loses nothing, and the same conversation is there from
// another tab.

import type Database from "better-sqlite3"

export interface AssistantMessage {
  seq: number
  role: "user" | "assistant"
  content: string
  /** assistant rows only: "pending" until the turn returns. */
  status: "pending" | "done" | "error"
  createdAt: number
}
export interface AssistantThread {
  id: string
  title: string
  agentId: string
  node: string | null
  createdAt: number
  updatedAt: number
}

export class AssistantStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT NOT NULL,
      node TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_messages (
      thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done',
      created_at INTEGER NOT NULL, PRIMARY KEY (thread_id, seq));
      CREATE INDEX IF NOT EXISTS assistant_threads_recent ON assistant_threads(updated_at DESC);`)
    // A turn in flight when the daemon stopped is never coming back; leaving
    // it "pending" would spin the drawer forever.
    db.prepare("UPDATE assistant_messages SET status='error', content=? WHERE status='pending'")
      .run("Interrupted — the daemon restarted while this was running.")
  }

  /** First words of the question, so the history list reads like the thing
   *  you asked rather than a row of identical timestamps. */
  private static titleFrom(message: string): string {
    const t = message.replace(/\s+/g, " ").trim()
    return (t.length > 60 ? t.slice(0, 59) + "…" : t) || "Untitled"
  }

  createThread(agentId: string, node: string | null, firstMessage: string): AssistantThread {
    const now = Date.now()
    const id = `t${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`
    this.db.prepare("INSERT INTO assistant_threads VALUES (?,?,?,?,?,?)")
      .run(id, AssistantStore.titleFrom(firstMessage), agentId, node, now, now)
    return { id, title: AssistantStore.titleFrom(firstMessage), agentId, node, createdAt: now, updatedAt: now }
  }

  listThreads(limit = 30): Array<AssistantThread & { messages: number }> {
    return this.db.prepare(`SELECT t.id, t.title, t.agent_id AS agentId, t.node,
      t.created_at AS createdAt, t.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM assistant_messages m WHERE m.thread_id = t.id) AS messages
      -- rowid breaks the tie: two conversations started in the same
      -- millisecond must not swap places between refreshes.
      FROM assistant_threads t ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ?`).all(limit) as any
  }

  messages(threadId: string): AssistantMessage[] {
    return this.db.prepare(`SELECT seq, role, content, status, created_at AS createdAt
      FROM assistant_messages WHERE thread_id=? ORDER BY seq`).all(threadId) as any
  }

  thread(id: string): AssistantThread | undefined {
    return this.db.prepare(`SELECT id, title, agent_id AS agentId, node,
      created_at AS createdAt, updated_at AS updatedAt FROM assistant_threads WHERE id=?`).get(id) as any
  }

  /** Append the question and a placeholder for its answer. Returns the seq of
   *  the placeholder so the caller can resolve it when the agent replies. */
  appendTurn(threadId: string, question: string): number {
    const now = Date.now()
    const next = (this.db.prepare("SELECT COALESCE(MAX(seq),-1) AS s FROM assistant_messages WHERE thread_id=?")
      .get(threadId) as { s: number }).s + 1
    const insert = this.db.prepare("INSERT INTO assistant_messages VALUES (?,?,?,?,?,?)")
    this.db.transaction(() => {
      insert.run(threadId, next, "user", question, "done", now)
      insert.run(threadId, next + 1, "assistant", "", "pending", now)
      this.db.prepare("UPDATE assistant_threads SET updated_at=? WHERE id=?").run(now, threadId)
    })()
    return next + 1
  }

  resolve(threadId: string, seq: number, content: string, status: "done" | "error"): void {
    this.db.prepare("UPDATE assistant_messages SET content=?, status=? WHERE thread_id=? AND seq=?")
      .run(content, status, threadId, seq)
    this.db.prepare("UPDATE assistant_threads SET updated_at=? WHERE id=?").run(Date.now(), threadId)
  }

  deleteThread(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM assistant_messages WHERE thread_id=?").run(id)
      this.db.prepare("DELETE FROM assistant_threads WHERE id=?").run(id)
    })()
  }
}
