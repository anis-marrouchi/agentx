import type Database from "better-sqlite3"
import { CLOSED_STATES, OPEN_STATES } from "@/requests/store"

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
      ORDER BY started_at DESC, rowid DESC LIMIT ?`,
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

/** Whether requests carry the person stamp. False when requests were
 *  never turned on. */
function requestsReady(db: Database.Database): boolean {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()
  if (!has) return false
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
  return cols.some((c) => c.name === "person")
}

function requestsIn(db: Database.Database, personId: string, states: readonly string[], tail: string, ...args: number[]): PersonRequest[] {
  if (!requestsReady(db)) return []
  const rows = db.prepare(
    `SELECT id, state, channel, agent_id, text, created_at FROM requests
      WHERE person = ? AND state IN (${states.map(() => "?").join(",")})
      ${tail}`,
  ).all(personId, ...states, ...args) as any[]
  return rows.map((r) => ({ id: r.id, state: r.state, channel: r.channel, agentId: r.agent_id, text: r.text, createdAt: r.created_at }))
}

/** A person's requests that are still open (#356), oldest first. Empty
 *  when requests were never turned on. */
export function openRequestsOf(db: Database.Database, personId: string): PersonRequest[] {
  return requestsIn(db, personId, OPEN_STATES, "ORDER BY created_at")
}

/** A person's requests, open and closed, each with the state it is in now,
 *  newest first. Candidates are left out: nothing confirmed them yet. */
export function requestsOf(db: Database.Database, personId: string, limit = 50): PersonRequest[] {
  return requestsIn(db, personId, [...OPEN_STATES, ...CLOSED_STATES], "ORDER BY created_at DESC, rowid DESC LIMIT ?", Math.max(1, Math.min(limit, 500)))
}
