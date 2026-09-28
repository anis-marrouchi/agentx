import type Database from "better-sqlite3"
import { randomBytes } from "crypto"
import type { UiDirective } from "@/channels/ui-directive"
import { ARTIFACT_LIMITS, artifactType, type DeclaredArtifact } from "@/utils/artifact-sentinel"

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
  /** Files an answer may declare (utils/artifact-sentinel.ts). */
  filesPerMessage: ARTIFACT_LIMITS.perMessage,
} as const

/** A file an answer declared, as the phone sees it. The path stays on the
 *  computer; the phone only gets the id, which is random and unguessable. */
export interface AppFileRef {
  id: string
  name: string
  mime: string
  kind: "image" | "audio" | "video" | "file"
}

/** A declared file resolved for serving: only for the phone that owns it. */
export interface AppFileRecord extends AppFileRef {
  /** As the agent declared it, relative to its workspace. */
  path: string
  conversationId: string
  /** Where the agent ran: "local" or a mesh peer name. */
  node: string
  agent: string
}

const FILE_ID_RE = /^[a-f0-9]{32}$/

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
  /** Files the answer declared (served by /api/app/files/:id). */
  files?: AppFileRef[]
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
  /** The agent's orb colour when the conversation started, if it had one. */
  color?: string
  createdAt: number
  updatedAt: number
  messages: AppChatMessage[]
}

export type AppConversationSummary = Omit<AppConversation, "messages"> & { messages: number; last?: string }

/** A conversation whose newest message is an answer this phone hasn't opened. */
export interface AppUnreadAnswer {
  id: string
  title: string
  agent: string
  agentName?: string
  color?: string
  /** The answer's first ~240 characters, whitespace squeezed. */
  answer: string
  status: "done" | "error" | "stopped"
  at: number
}

const ID_RE = /^c[a-z0-9]{8,32}$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

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
      CREATE INDEX IF NOT EXISTS app_chat_messages_conversation ON app_chat_messages(conversation_id, id);
      CREATE TABLE IF NOT EXISTS app_chat_files (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS app_chat_files_conversation ON app_chat_files(conversation_id);`)
    // Databases from before answers could declare files lack the column.
    const cols = db.prepare("PRAGMA table_info(app_chat_messages)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === "files")) db.exec("ALTER TABLE app_chat_messages ADD COLUMN files TEXT")
    // Read state (#265): when the phone last opened each conversation. Rows
    // from before it count as read, so an update never lights up the strip
    // with every old conversation.
    const convCols = db.prepare("PRAGMA table_info(app_chat_conversations)").all() as Array<{ name: string }>
    // The column and its backfill go in one transaction: a crash between
    // them would leave every old conversation unread and never backfilled.
    // IMMEDIATE takes the write lock before the second look, so the
    // dashboard and the daemon opening the file together can't both add it.
    if (!convCols.some((c) => c.name === "read_at")) {
      db.transaction(() => {
        const again = db.prepare("PRAGMA table_info(app_chat_conversations)").all() as Array<{ name: string }>
        if (again.some((c) => c.name === "read_at")) return
        db.exec("ALTER TABLE app_chat_conversations ADD COLUMN read_at INTEGER")
        db.exec("UPDATE app_chat_conversations SET read_at = updated_at")
      }).immediate()
    }
    if (!convCols.some((c) => c.name === "color")) db.exec("ALTER TABLE app_chat_conversations ADD COLUMN color TEXT")
  }

  create(deviceId: string, init: Pick<AppConversation, "node" | "nodeName" | "agent" | "agentName" | "color">, firstMessage: string, now = Date.now()): AppConversation {
    const id = `c${now.toString(36)}${randomBytes(4).toString("hex")}`
    const { color: wanted, ...rest } = init
    const color = wanted && COLOR_RE.test(wanted) ? wanted : undefined
    const conv: AppConversation = { id, title: titleFrom(firstMessage), ...rest, ...(color ? { color } : {}), createdAt: now, updatedAt: now, messages: [] }
    this.db.prepare(`INSERT INTO app_chat_conversations
      (id, device_id, title, node, node_name, agent, agent_name, color, created_at, updated_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, deviceId, conv.title, conv.node, conv.nodeName, conv.agent, conv.agentName ?? null, color ?? null, now, now, now)
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

  /** The phone has seen this conversation up to `now` (opened, attached,
   *  or watched an answer finish). Only its own conversations. */
  markRead(deviceId: string, id: string, now = Date.now()): void {
    if (!isConversationId(id)) return
    this.db.prepare("UPDATE app_chat_conversations SET read_at = MAX(COALESCE(read_at, 0), ?) WHERE id = ? AND device_id = ?").run(now, id, deviceId)
  }

  /** Conversations whose newest message is an answer saved after the phone
   *  last opened them, newest first. One indexed query per poll. */
  unread(deviceId: string, limit: number): AppUnreadAnswer[] {
    const rows = this.db.prepare(`SELECT c.id, c.title, c.agent, c.agent_name, c.color,
        substr(m.content, 1, 240) AS answer, m.status, m.at
      FROM app_chat_conversations c
      JOIN app_chat_messages m ON m.id = (SELECT MAX(id) FROM app_chat_messages WHERE conversation_id = c.id)
      WHERE c.device_id = ? AND m.role = 'assistant' AND m.at > COALESCE(c.read_at, 0)
      ORDER BY m.at DESC, m.id DESC LIMIT ?`).all(deviceId, Math.max(0, limit)) as any[]
    return rows.map((r) => ({
      id: r.id, title: r.title, agent: r.agent,
      ...(r.agent_name ? { agentName: r.agent_name } : {}),
      ...(r.color ? { color: r.color } : {}),
      answer: String(r.answer ?? "").trim(),
      status: r.status === "error" || r.status === "stopped" ? r.status : "done",
      at: r.at,
    }))
  }

  append(deviceId: string, id: string, m: AppChatMessage): boolean {
    return this.appendWithFiles(deviceId, id, m) !== null
  }

  /** Saves a message and registers the files its answer declared, each
   *  under a fresh random id. Returns what the phone may see of them, or
   *  null when the conversation isn't this phone's. A declared path that
   *  could never be served (its type, its length) is left out here. */
  appendWithFiles(deviceId: string, id: string, m: AppChatMessage, declared: DeclaredArtifact[] = []): AppFileRef[] | null {
    const owner = this.db.prepare("SELECT 1 FROM app_chat_conversations WHERE id = ? AND device_id = ?").get(id, deviceId)
    if (!owner) return null
    const content = m.content.length > LIMITS.content
      ? m.content.slice(0, LIMITS.content) + "\n\n[Cut here: the full answer is in the agent's task history.]"
      : m.content
    const tools = m.tools?.slice(0, LIMITS.toolsPerMessage)
    const files: Array<AppFileRef & { path: string }> = []
    for (const d of declared) {
      if (files.length >= LIMITS.filesPerMessage) break
      const path = d.filename.trim()
      const type = artifactType(path)
      if (!type || !path || path.length > ARTIFACT_LIMITS.pathChars || path.includes("\0")) continue
      const name = (path.split(/[\\/]/).pop() || path).slice(0, 120)
      files.push({ id: randomBytes(16).toString("hex"), name, mime: type.mime, kind: type.kind, path })
    }
    const refs: AppFileRef[] = files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, kind: f.kind }))
    const row = this.db.prepare(`INSERT INTO app_chat_messages (conversation_id, role, content, status, error, ui, tools, files, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, m.role, content, m.status ?? null, m.error?.slice(0, 500) ?? null,
        m.ui ? JSON.stringify(m.ui) : null, tools?.length ? JSON.stringify(tools) : null, refs.length ? JSON.stringify(refs) : null, m.at)
    const insert = this.db.prepare(`INSERT INTO app_chat_files (id, conversation_id, message_id, path, name, mime, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const f of files) insert.run(f.id, id, Number(row.lastInsertRowid), f.path, f.name, f.mime, f.kind, m.at)
    this.db.prepare(`DELETE FROM app_chat_messages WHERE conversation_id = ? AND id NOT IN
      (SELECT id FROM app_chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?)`)
      .run(id, id, LIMITS.messagesPerConversation)
    // A file goes with the message that declared it.
    this.db.prepare(`DELETE FROM app_chat_files WHERE conversation_id = ? AND message_id NOT IN
      (SELECT id FROM app_chat_messages WHERE conversation_id = ?)`).run(id, id)
    this.db.prepare("UPDATE app_chat_conversations SET updated_at = ? WHERE id = ?").run(m.at, id)
    return refs
  }

  /** A declared file, only if its conversation belongs to `deviceId`. */
  getFile(deviceId: string, fileId: string): AppFileRecord | null {
    if (!FILE_ID_RE.test(fileId)) return null
    const r = this.db.prepare(`SELECT f.*, c.node, c.agent FROM app_chat_files f
      JOIN app_chat_conversations c ON c.id = f.conversation_id WHERE f.id = ? AND c.device_id = ?`).get(fileId, deviceId) as any
    if (!r) return null
    return { id: r.id, name: r.name, mime: r.mime, kind: r.kind, path: r.path, conversationId: r.conversation_id, node: r.node, agent: r.agent }
  }

  /** Keeps the newest conversations of one phone. */
  private pruneDevice(deviceId: string): void {
    const old = this.db.prepare(`SELECT id FROM app_chat_conversations WHERE device_id = ?
      ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?`).all(deviceId, LIMITS.conversationsPerDevice) as Array<{ id: string }>
    for (const { id } of old) {
      this.db.prepare("DELETE FROM app_chat_files WHERE conversation_id = ?").run(id)
      this.db.prepare("DELETE FROM app_chat_messages WHERE conversation_id = ?").run(id)
      this.db.prepare("DELETE FROM app_chat_conversations WHERE id = ?").run(id)
    }
  }
}

function toConversation(r: any): Omit<AppConversation, "messages"> {
  return {
    id: r.id, title: r.title, node: r.node, nodeName: r.node_name, agent: r.agent,
    ...(r.agent_name ? { agentName: r.agent_name } : {}),
    ...(r.color ? { color: r.color } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function toMessage(r: any): AppChatMessage {
  const parse = (s: string | null) => { if (!s) return undefined; try { return JSON.parse(s) } catch { return undefined } }
  const ui = parse(r.ui)
  const tools = parse(r.tools)
  const files = parse(r.files)
  return {
    role: r.role, content: r.content, at: r.at,
    ...(r.status ? { status: r.status } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(ui ? { ui } : {}),
    ...(tools ? { tools } : {}),
    ...(files ? { files } : {}),
  }
}

/** First words of the question, so the history list reads like what you asked. */
function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim()
  return (t.length > 60 ? t.slice(0, 59) + "…" : t) || "Untitled"
}
