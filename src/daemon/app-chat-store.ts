import type Database from "better-sqlite3"
import { randomBytes } from "crypto"
import type { UiDirective } from "@/channels/ui-directive"

// --- Phone app conversations (server side of the Chat history) ---
//
// Same home as the push tables (push-store.ts): the dashboard opens the
// node's .agentx/db.sqlite, and the tables are created here with IF NOT
// EXISTS rather than as a numbered migration. Only the dashboard process
// touches them.
//
// Every conversation belongs to one paired phone (its device token id), so
// one phone never lists or opens another's, and it is pinned to one agent on
// one node when it starts. Everything is bounded: the text of one message,
// the messages kept per conversation and the conversations kept per phone.

export const LIMITS = {
  /** Characters kept of one message; a longer reply is cut with a note. */
  content: 32_000,
  messagesPerConversation: 200,
  conversationsPerDevice: 100,
  toolsPerMessage: 50,
} as const

export interface AppToolBadge {
  name: string
  arg?: string
  error?: boolean
}

export interface AppChatMessage {
  role: "user" | "assistant"
  content: string
  /** Assistant rows: how the turn ended. */
  status?: "done" | "error" | "stopped"
  error?: string
  ui?: UiDirective
  tools?: AppToolBadge[]
  at: number
}

export interface AppConversation {
  id: string
  title: string
  /** "local" for the node the dashboard serves, else the mesh peer name. */
  node: string
  nodeName: string
  agent: string
  agentName?: string
  createdAt: number
  updatedAt: number
  messages: AppChatMessage[]
}

export type AppConversationSummary = Omit<AppConversation, "messages"> & { messages: number; last?: string }

const ID_RE = /^c[a-z0-9]{8,32}$/

export function isConversationId(id: string): boolean {
  return ID_RE.test(id)
}

export class AppChatStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_chat_conversations (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, title TEXT NOT NULL,
      node TEXT NOT NULL, node_name TEXT NOT NULL, agent TEXT NOT NULL, agent_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS app_chat_conversations_device ON app_chat_conversations(device_id, updated_at);
      CREATE TABLE IF NOT EXISTS app_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT, error TEXT, ui TEXT, tools TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS app_chat_messages_conversation ON app_chat_messages(conversation_id, id);`)
  }

  create(deviceId: string, init: Pick<AppConversation, "node" | "nodeName" | "agent" | "agentName">, firstMessage: string, now = Date.now()): AppConversation {
    const id = `c${now.toString(36)}${randomBytes(4).toString("hex")}`
    const conv: AppConversation = { id, title: titleFrom(firstMessage), ...init, createdAt: now, updatedAt: now, messages: [] }
    this.db.prepare(`INSERT INTO app_chat_conversations
      (id, device_id, title, node, node_name, agent, agent_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, deviceId, conv.title, conv.node, conv.nodeName, conv.agent, conv.agentName ?? null, now, now)
    this.pruneDevice(deviceId)
    return conv
  }

  /** The conversation, only if it belongs to `deviceId`. */
  get(deviceId: string, id: string): AppConversation | null {
    if (!isConversationId(id)) return null
    const row = this.db.prepare("SELECT * FROM app_chat_conversations WHERE id = ? AND device_id = ?").get(id, deviceId) as any
    if (!row) return null
    const messages = (this.db.prepare("SELECT * FROM app_chat_messages WHERE conversation_id = ? ORDER BY id").all(id) as any[]).map(toMessage)
    return { ...toConversation(row), messages }
  }

  /** Most recently used first. */
  list(deviceId: string, limit: number = LIMITS.conversationsPerDevice): AppConversationSummary[] {
    const rows = this.db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM app_chat_messages m WHERE m.conversation_id = c.id) AS n,
        (SELECT substr(m.content, 1, 240) FROM app_chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last
      FROM app_chat_conversations c WHERE c.device_id = ? ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`)
      .all(deviceId, Math.max(0, limit)) as any[]
    return rows.map((r) => {
      const last = typeof r.last === "string" ? r.last.replace(/\s+/g, " ").trim().slice(0, 120) : ""
      return { ...toConversation(r), messages: r.n, ...(last ? { last } : {}) }
    })
  }

  append(deviceId: string, id: string, m: AppChatMessage): boolean {
    const owner = this.db.prepare("SELECT 1 FROM app_chat_conversations WHERE id = ? AND device_id = ?").get(id, deviceId)
    if (!owner) return false
    const content = m.content.length > LIMITS.content
      ? m.content.slice(0, LIMITS.content) + "\n\n[Cut here: the full answer is in the agent's task history.]"
      : m.content
    const tools = m.tools?.slice(0, LIMITS.toolsPerMessage)
    this.db.prepare(`INSERT INTO app_chat_messages (conversation_id, role, content, status, error, ui, tools, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, m.role, content, m.status ?? null, m.error?.slice(0, 500) ?? null,
        m.ui ? JSON.stringify(m.ui) : null, tools?.length ? JSON.stringify(tools) : null, m.at)
    this.db.prepare(`DELETE FROM app_chat_messages WHERE conversation_id = ? AND id NOT IN
      (SELECT id FROM app_chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?)`)
      .run(id, id, LIMITS.messagesPerConversation)
    this.db.prepare("UPDATE app_chat_conversations SET updated_at = ? WHERE id = ?").run(m.at, id)
    return true
  }

  /** Keeps the newest conversations of one phone. */
  private pruneDevice(deviceId: string): void {
    const old = this.db.prepare(`SELECT id FROM app_chat_conversations WHERE device_id = ?
      ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?`).all(deviceId, LIMITS.conversationsPerDevice) as Array<{ id: string }>
    for (const { id } of old) {
      this.db.prepare("DELETE FROM app_chat_messages WHERE conversation_id = ?").run(id)
      this.db.prepare("DELETE FROM app_chat_conversations WHERE id = ?").run(id)
    }
  }
}

function toConversation(r: any): Omit<AppConversation, "messages"> {
  return {
    id: r.id, title: r.title, node: r.node, nodeName: r.node_name, agent: r.agent,
    ...(r.agent_name ? { agentName: r.agent_name } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function toMessage(r: any): AppChatMessage {
  const parse = (s: string | null) => { if (!s) return undefined; try { return JSON.parse(s) } catch { return undefined } }
  const ui = parse(r.ui)
  const tools = parse(r.tools)
  return {
    role: r.role, content: r.content, at: r.at,
    ...(r.status ? { status: r.status } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(ui ? { ui } : {}),
    ...(tools ? { tools } : {}),
  }
}

/** First words of the question, so the history list reads like what you asked. */
function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim()
  return (t.length > 60 ? t.slice(0, 59) + "…" : t) || "Untitled"
}
