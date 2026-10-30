import type Database from "better-sqlite3"
import { PresenceStore, ReachMarks } from "@/notify/reach"

// --- Phone app: presence and read marks (#1138 step B) ---
//
// The phone app is served by the dashboard, which shares the daemon's
// SQLite file, so its marks go straight into the told record and the
// presence table (notify/reach.ts):
//
//   any paired call        the owner is on the phone app
//   GET /api/app/desk      on the Desk: the requests it shows are seen
//   POST /api/app/desk/reply      that request is answered
//   POST /api/app/alerts/read     the pushes he marked read are seen
//
// Every function here logs and swallows its own failure: a mark that
// could not be written must never fail the page.

export interface AppReachDeps {
  touch(surface: "phone" | "desk"): void
  pushRead(items: Array<{ at: number; title: string }>): number
  /** The Desk showed these card keys ("request:<id>", "card:<id>"). */
  deskSeen(keys: string[]): void
  deskAnswered(requestId: string): void
}

export interface AppReachSources {
  db: () => Database.Database | null
  /** The request a decision card belongs to, if any. */
  requestOfCard: (cardId: string) => string | null
  log: (msg: string) => void
  /** The clock marks and presence are stamped with (tests pin it). */
  now?: () => number
}

export function appReachDeps(src: AppReachSources): AppReachDeps {
  const now = src.now ?? Date.now
  let cached: { db: Database.Database; presence: PresenceStore; marks: ReachMarks } | null = null
  const parts = () => {
    const db = src.db()
    if (!db) return null
    if (cached?.db !== db) cached = { db, presence: new PresenceStore(db, now), marks: new ReachMarks(db, now) }
    return cached
  }
  const guard = <T>(what: string, fallback: T, fn: (p: NonNullable<ReturnType<typeof parts>>) => T): T => {
    try {
      const p = parts()
      return p ? fn(p) : fallback
    } catch (e: any) {
      src.log(`[reach] ${what} not recorded: ${e?.message ?? e}`)
      return fallback
    }
  }
  return {
    touch: (surface) => guard(`${surface} presence`, undefined, (p) => p.presence.touch(surface)),
    pushRead: (items) => guard("push read mark", 0, (p) => p.marks.seenPush(items, "phone")),
    deskSeen: (keys) => guard("desk seen", undefined, (p) => {
      p.presence.touch("desk")
      const ids = new Set<string>()
      for (const k of keys) {
        if (k.startsWith("request:")) ids.add(k.slice("request:".length))
        else if (k.startsWith("card:")) {
          const r = src.requestOfCard(k.slice("card:".length))
          if (r) ids.add(r)
        }
      }
      p.marks.seenByRequest([...ids], "desk")
    }),
    deskAnswered: (id) => guard("desk answer", undefined, (p) => { p.marks.answeredByRequest([id], "desk") }),
  }
}
