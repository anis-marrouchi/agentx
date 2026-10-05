import type Database from "better-sqlite3"
import { listQueuedMessages } from "@/storage/queued-messages"
import { whereLabel, type LinkFor } from "./work"

// --- The line behind the agents a teammate uses (#443) ---
//
// Read from the mirror the daemon keeps of its message queue
// (storage/queued-messages.ts). A teammate learns how many messages wait
// on each of their agents and how many are ahead of their own; of anyone
// else's message they get the count alone, never the text or the sender.

export interface QueueView {
  /** Messages waiting on this agent, from anyone. */
  waiting: number
  /** Among them, the person's own. */
  yours: number
  /** Messages ahead of the person's first one in its line, or null when
   *  none of theirs waits. The turn running now is not counted: the card
   *  already shows it. */
  ahead: number | null
}

/** One of the person's own messages, waiting in line. */
export interface QueuedItem {
  agentId: string
  channel: string
  chatId: string
  queuedAt: number
  messagePreview: string | null
  where: { label: string; url: string | null }
  /** Messages ahead of it in its line. */
  ahead: number
}

export const NO_QUEUE: QueueView = { waiting: 0, yours: 0, ahead: null }

export function queueOf(
  db: Database.Database,
  personId: string,
  opts: { linkFor?: LinkFor } = {},
): { byAgent: Map<string, QueueView>; mine: QueuedItem[] } {
  const rows = listQueuedMessages(db)
  const byAgent = new Map<string, QueueView>()
  const mine: QueuedItem[] = []
  const lineOf = new Map<string, number>()
  for (const r of rows) {
    const line = `${r.agentId}\u0000${r.channel}\u0000${r.chatId}`
    const ahead = lineOf.get(line) ?? 0
    lineOf.set(line, ahead + 1)
    const view = byAgent.get(r.agentId) ?? { waiting: 0, yours: 0, ahead: null }
    view.waiting++
    if (r.person === personId) {
      view.yours++
      if (view.ahead === null) view.ahead = ahead
      mine.push({
        agentId: r.agentId, channel: r.channel, chatId: r.chatId, queuedAt: r.queuedAt, messagePreview: r.messagePreview,
        where: { label: whereLabel(r.channel, r.chatId), url: opts.linkFor?.(r.channel, r.chatId) ?? null },
        ahead,
      })
    }
    byAgent.set(r.agentId, view)
  }
  return { byAgent, mine }
}
