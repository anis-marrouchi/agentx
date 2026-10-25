import type Database from "better-sqlite3"

// --- Agent comments on GitHub and GitLab, by id (#1184) ---
//
// When the daemon posts an agent's comment on an issue, pull request or
// merge request, the forge answers with the comment's id. That id is kept
// here with the chat it went to, so the Wall can link to the exact
// comment, not only to the issue. Ids and chats only: never the text.

export const FORGE_COMMENT_CHANNELS = ["github", "gitlab"] as const

export interface ForgeCommentRow {
  channel: string
  chatId: string
  commentId: string
  agentId: string | null
  at: number
}

export function ensureForgeCommentsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forge_comments (
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      agent_id TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY (channel, chat_id, comment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_forge_comments_chat ON forge_comments(channel, chat_id, at);
  `)
}

export function insertForgeComment(db: Database.Database, c: ForgeCommentRow): void {
  db.prepare(
    "INSERT OR IGNORE INTO forge_comments (channel, chat_id, comment_id, agent_id, at) VALUES (?, ?, ?, ?, ?)",
  ).run(c.channel, c.chatId, c.commentId.slice(0, 64), c.agentId?.slice(0, 120) ?? null, c.at)
}

/** Every comment on these chats of one channel, newest first. */
export function forgeCommentsOnChats(db: Database.Database, channel: string, chatIds: string[]): ForgeCommentRow[] {
  if (chatIds.length === 0) return []
  return db.prepare(
    `SELECT channel, chat_id AS chatId, comment_id AS commentId, agent_id AS agentId, at FROM forge_comments
     WHERE channel = ? AND chat_id IN (${chatIds.map(() => "?").join(",")}) ORDER BY at DESC`,
  ).all(channel, ...chatIds) as ForgeCommentRow[]
}

/** The newest comments on one forge chat in [from, to], newest first. */
export function forgeCommentsOn(db: Database.Database, channel: string, chatId: string, from: number, to: number, limit = 5): ForgeCommentRow[] {
  return db.prepare(
    `SELECT channel, chat_id AS chatId, comment_id AS commentId, agent_id AS agentId, at FROM forge_comments
     WHERE channel = ? AND chat_id = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT ?`,
  ).all(channel, chatId, from, to, limit) as ForgeCommentRow[]
}
