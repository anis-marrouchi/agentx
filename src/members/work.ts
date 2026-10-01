import type Database from "better-sqlite3"
import { CLOSED_STATES, OPEN_STATES } from "@/requests/store"
import { runsOf, type PersonRun } from "@/people/activity"

// --- What one person sees on their work page (#386) ---
//
// Their own requests, open ones oldest first and the ones closed in the
// last days, plus the turns they started. Nothing of anyone else's: every
// query is keyed by the person stamped on the row.

export const RECENT_DAYS = 7

export interface WorkItem {
  id: string
  state: string
  agentId: string
  text: string
  channel: string
  chatId: string
  createdAt: number
  updatedAt: number
  closedAt: number | null
  question: string | null
  attentionReason: string | null
  evidence: string | null
  /** Where the request was made, as a label and, when known, a link. */
  where: { label: string; url: string | null }
}

export interface PersonWork {
  open: WorkItem[]
  recent: WorkItem[]
  runs: PersonRun[]
}

export type LinkFor = (channel: string, chatId: string) => string | null

const CHANNEL_LABELS: Record<string, string> = {
  gitlab: "GitLab", github: "GitHub", telegram: "Telegram", whatsapp: "WhatsApp", slack: "Slack", discord: "Discord",
  voice: "Voice", app: "Phone app", dashboard: "Dashboard", webrtc: "Call",
}

export function whereLabel(channel: string, chatId: string): string {
  const base = channel.toLowerCase().split("@")[0]
  const name = CHANNEL_LABELS[base] ?? channel
  const thread = /^(.+):(issue|merge_request|pull):(\d+)$/.exec(chatId)
  if (thread) {
    const kind = thread[2] === "issue" ? "issue" : thread[2] === "pull" ? "pull request" : "merge request"
    return `${name} ${kind} #${thread[3]} in ${thread[1]}`
  }
  return name
}

/** A link to a GitLab or GitHub thread, from how the channels name a chat
 *  (`group/project:issue:7`). Null for everything else. */
export function forgeLink(channel: string, chatId: string, hosts: { gitlab?: string; github?: string }): string | null {
  const base = channel.toLowerCase().split("@")[0]
  const thread = /^(.+):(issue|merge_request|pull):(\d+)$/.exec(chatId)
  if (!thread) return null
  const [, project, kind, n] = thread
  if (base === "gitlab") {
    const host = (hosts.gitlab || "https://gitlab.com").replace(/\/+$/, "")
    return `${host}/${project}/-/${kind === "issue" ? "issues" : "merge_requests"}/${n}`
  }
  if (base === "github") {
    const host = (hosts.github || "https://github.com").replace(/\/+$/, "")
    return `${host}/${project}/${kind === "issue" ? "issues" : "pull"}/${n}`
  }
  return null
}

export function workOf(db: Database.Database, personId: string, opts: { now?: number; linkFor?: LinkFor } = {}): PersonWork {
  const now = opts.now ?? Date.now()
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()
  const cols = has ? (db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>) : []
  const ready = cols.some((c) => c.name === "person")
  const toItem = (r: any): WorkItem => ({
    id: r.id, state: r.state, agentId: r.agent_id, text: r.text, channel: r.channel, chatId: r.chat_id,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at ?? null,
    question: r.question ?? null, attentionReason: r.attention_reason ?? null, evidence: r.evidence ?? null,
    where: { label: whereLabel(r.channel, r.chat_id), url: opts.linkFor?.(r.channel, r.chat_id) ?? null },
  })
  const open = ready ? (db.prepare(
    `SELECT * FROM requests WHERE person = ? AND state IN (${OPEN_STATES.map(() => "?").join(",")}) ORDER BY created_at, rowid`,
  ).all(personId, ...OPEN_STATES) as any[]).map(toItem) : []
  const recent = ready ? (db.prepare(
    `SELECT * FROM requests WHERE person = ? AND state IN (${CLOSED_STATES.map(() => "?").join(",")}) AND COALESCE(closed_at, updated_at) >= ?
      ORDER BY COALESCE(closed_at, updated_at) DESC LIMIT 50`,
  ).all(personId, ...CLOSED_STATES, now - RECENT_DAYS * 86_400_000) as any[]).map(toItem) : []
  let runs: PersonRun[] = []
  try { runs = runsOf(db, personId, 10) } catch { /* no task_traces yet */ }
  return { open, recent, runs }
}
