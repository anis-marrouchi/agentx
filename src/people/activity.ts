import type Database from "better-sqlite3"
import { OPEN_STATES } from "@/requests/store"

// --- What a person asked for, across every channel (#384) ---
//
// Reads the `person` stamp on runs (task_traces) and on open requests.

export interface PersonRun {
  taskId: string
  agentId: string
  channel: string | null
  chatId: string | null
  status: string
  startedAt: number
  messagePreview: string | null
}

/** The latest turns a person started, newest first. Delegated hops are
 *  left out: they carry the same person but are the agents' own work. */
export function runsOf(db: Database.Database, personId: string, limit = 20): PersonRun[] {
  const rows = db.prepare(
    `SELECT task_id, agent_id, channel, chat_id, status, started_at, message_preview
       FROM task_traces
      WHERE person = ? AND (channel IS NULL OR channel != 'a2a')
      ORDER BY started_at DESC LIMIT ?`,
  ).all(personId, Math.max(1, Math.min(limit, 500))) as any[]
  return rows.map((r) => ({
    taskId: r.task_id, agentId: r.agent_id, channel: r.channel, chatId: r.chat_id,
    status: r.status, startedAt: r.started_at, messagePreview: r.message_preview,
  }))
}

export interface PersonRequest {
  id: string
  state: string
  channel: string
  agentId: string
  text: string
  createdAt: number
}

/** A person's requests that are still open (#356), oldest first. Empty
 *  when requests were never turned on. */
export function openRequestsOf(db: Database.Database, personId: string): PersonRequest[] {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()
  if (!has) return []
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === "person")) return []
  const rows = db.prepare(
    `SELECT id, state, channel, agent_id, text, created_at FROM requests
      WHERE person = ? AND state IN (${OPEN_STATES.map(() => "?").join(",")})
      ORDER BY created_at`,
  ).all(personId, ...OPEN_STATES) as any[]
  return rows.map((r) => ({ id: r.id, state: r.state, channel: r.channel, agentId: r.agent_id, text: r.text, createdAt: r.created_at }))
}
