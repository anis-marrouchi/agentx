import type Database from "better-sqlite3"
import { IMPLICIT_OWNER, type Person } from "@/people/people"
import { RECENT_DAYS, whereLabel, type LinkFor } from "./work"

// --- The agents a teammate uses, and what each is doing now (#443) ---
//
// Read from the runs the node already records (task_traces). A card says
// who started the agent's current or last turn: "you", "owner" or "other".
// The text and the place of a turn are given only when it is the
// member's own; of anyone else's turn the member learns only that the
// agent is busy and since when.

export type AgentStateName = "working" | "free" | "blocked"
export type StartedBy = "you" | "owner" | "other"

export interface AgentCard {
  agentId: string
  state: AgentStateName
  /** Who started the turn the card is about; null when the agent never ran. */
  by: StartedBy | null
  /** When the turn started (working) or ended (free, blocked). */
  at: number | null
  /** The member's own turn only. */
  text: string | null
  fullText: string | null
  where: { label: string; url: string | null } | null
}

const FULL_MAX = 4000

/** The agents shown: the person's own list when the owner set one, else
 *  the agents they talked to in the last days. */
export function agentIdsFor(db: Database.Database, person: Pick<Person, "id" | "agents">, now: number): string[] {
  if (person.agents?.length) return [...person.agents]
  const rows = db.prepare(
    `SELECT agent_id, MAX(started_at) AS last FROM task_traces
      WHERE person = ? AND started_at >= ? AND (channel IS NULL OR channel != 'a2a')
      GROUP BY agent_id ORDER BY last DESC LIMIT 12`,
  ).all(person.id, now - RECENT_DAYS * 86_400_000) as Array<{ agent_id: string }>
  return rows.map((r) => r.agent_id)
}

export function agentsOf(
  db: Database.Database,
  personId: string,
  agentIds: string[],
  opts: { people: Person[]; linkFor?: LinkFor },
): AgentCard[] {
  const owners = new Set(opts.people.filter((p) => p.role === "owner").map((p) => p.id))
  owners.add(IMPLICIT_OWNER)
  const byOf = (person: string | null): StartedBy => person === personId ? "you" : person && owners.has(person) ? "owner" : "other"
  const running = db.prepare(
    `SELECT * FROM task_traces WHERE agent_id = ? AND status = 'in-flight' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  )
  const last = db.prepare(
    `SELECT * FROM task_traces WHERE agent_id = ? AND status != 'in-flight' ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  )
  return agentIds.map((agentId) => {
    const live = running.get(agentId) as any
    const row = live ?? (last.get(agentId) as any)
    if (!row) return { agentId, state: "free", by: null, at: null, text: null, fullText: null, where: null }
    const by = byOf(row.person ?? null)
    const failed = row.status === "error" || row.status === "timeout"
    const state: AgentStateName = live ? "working" : failed && by === "you" ? "blocked" : "free"
    const mine = by === "you"
    const thread = mine && row.channel && row.channel !== "a2a"
    return {
      agentId, state, by,
      at: live ? row.started_at : (row.finished_at ?? row.started_at),
      text: mine ? row.message_preview ?? null : null,
      fullText: mine && live ? String(row.original_message ?? row.message_preview ?? "").slice(0, FULL_MAX) || null : null,
      where: thread ? { label: whereLabel(row.channel, row.chat_id ?? ""), url: opts.linkFor?.(row.channel, row.chat_id ?? "") ?? null } : null,
    }
  })
}
