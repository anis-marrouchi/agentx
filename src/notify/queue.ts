import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { dirname, resolve } from "path"

// Notifications that arrived while the person was in Focus.
//
// A queue rather than a drop, because the two failure modes are not
// symmetrical: an interruption during Focus costs a moment's attention,
// while a silently discarded message costs the thing it was about. The
// agent that sent it has already moved on and will not send it again.
//
// A plain JSON file, matching how cron keeps its own history. The volume
// is a handful of entries at most — this is a shoulder tap, not a log —
// and a file can be read, edited and deleted by a person who wants to know
// what is waiting for them.

export interface PendingNotification {
  id: string
  at: string
  /** Who asked for the notification. */
  from: string
  title: string
  message: string
  /** 1 (min) … 5 (max), matching ntfy. */
  priority?: number
  /** Why it waited, for the digest that eventually delivers it. */
  heldBecause: string
}

const DEFAULT_PATH = ".agentx/notifications/pending.json"

export class NotificationQueue {
  readonly path: string

  constructor(path = DEFAULT_PATH) {
    this.path = resolve(process.cwd(), path)
  }

  list(): PendingNotification[] {
    if (!existsSync(this.path)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8"))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      // A corrupt queue must not take down the caller. Losing a held
      // notification is bad; refusing to send any new one is worse.
      return []
    }
  }

  add(entry: PendingNotification): void {
    const all = this.list()
    all.push(entry)
    this.write(all)
  }

  /** Take everything waiting and clear the queue, atomically enough. */
  drain(): PendingNotification[] {
    const all = this.list()
    if (all.length) this.write([])
    return all
  }

  private write(entries: PendingNotification[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(entries, null, 2) + "\n")
  }
}

/**
 * Fold held notifications into one message.
 *
 * Delivering four separate pings the moment Focus ends recreates exactly
 * the interruption Focus existed to prevent — the person gets the whole
 * backlog at once, in the least considered way possible. One message that
 * says what happened while they were away is the point of having waited.
 */
export function digest(entries: PendingNotification[]): { title: string; message: string } | null {
  if (entries.length === 0) return null
  if (entries.length === 1) {
    const only = entries[0]
    return { title: only.title, message: only.message }
  }

  const lines = entries.map((e) => {
    const when = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    return `• ${when} ${e.from}: ${e.message}`
  })
  return {
    title: `${entries.length} while you were away`,
    message: lines.join("\n"),
  }
}
