import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { DeskCard } from "./board"
import type { OwnerList } from "./owner-list"

// --- Where a new item on the owner's list goes (#1138 step C) ---
//
// The owner has three settings, and no more:
//
//   notifications.desk.phone      what reaches the phone the moment it appears
//   notifications.desk.computer   what reaches this computer the moment it appears
//   approvals.digest              when the daily digest comes (sweep.ts)
//
// The first two take "all", "urgent" or "off". Urgent is an item that
// expires within a day: after that its default applies without the owner.
// Everything else waits on the Desk and in the digest. Changing a setting
// changes where the next item goes; nothing is re-sent for items that were
// already routed under the old one.
//
// How each surface shows it is not decided here:
//   phone     the daemon's one way to tell the owner (the told gate: one
//             tell per item key on any owner channel; held in Focus),
//             without the local banner: that is the computer's. An item
//             that expires within a day goes at a higher priority, not as
//             an urgent tell: it does not break Focus
//   computer  the Mac card when approvals.popup is on (popup-runner.ts asks
//             `reaches` before it shows one), else a banner through the
//             native adapter. Held in Focus, and tried again after.
//
// Each item is routed once, by its key. The state file is written only by
// the daemon. On the first run the items already waiting are recorded
// without being sent, so switching this on never replays a backlog.

export type DeskReach = "all" | "urgent" | "off"
export const DESK_REACH: readonly DeskReach[] = ["all", "urgent", "off"]

export interface DeskRouting {
  phone: DeskReach
  computer: DeskReach
}

/** An item that expires within this long is urgent. */
export const DESK_URGENT_MS = 24 * 3_600_000
/** An item asked longer ago than this is not sent anywhere when first seen. */
export const DESK_ROUTE_MAX_AGE_MS = 24 * 3_600_000
/** A routed key is forgotten this long after it left the list. */
const KEEP_MS = 30 * 24 * 3_600_000

const valid = (v: unknown): v is DeskReach => DESK_REACH.includes(v as DeskReach)

/** The two settings with their defaults: the phone off, the computer as
 *  the popup switch had it (on: every card, off: nothing). */
export function deskRouting(input: { desk?: { phone?: unknown; computer?: unknown }; popupEnabled: boolean }): DeskRouting {
  const phone = input.desk?.phone
  const computer = input.desk?.computer
  return {
    phone: valid(phone) ? phone : "off",
    computer: valid(computer) ? computer : input.popupEnabled ? "all" : "off",
  }
}

export function isUrgent(item: { expires?: string }, now: number): boolean {
  const at = item.expires ? Date.parse(item.expires) : NaN
  return Number.isFinite(at) && at - now <= DESK_URGENT_MS
}

/** True when a surface set to `level` takes this item. */
export function reaches(level: DeskReach, item: { expires?: string }, now: number): boolean {
  return level === "all" || (level === "urgent" && isUrgent(item, now))
}

interface RoutedEntry {
  /** ISO time it was first seen on the list. */
  at: string
  /** ISO time it was last seen on the list. */
  seen: string
  /** The computer wanted it but was held (Focus): tried again. */
  computerHeld?: true
}

interface RoutedFile {
  items: Record<string, RoutedEntry>
}

export function deskRoutedPath(root: string): string {
  return resolve(root, ".agentx", "desk-routed.json")
}

function readRouted(root: string): RoutedFile | null {
  const path = deskRoutedPath(root)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    return parsed && typeof parsed.items === "object" ? parsed : { items: {} }
  } catch {
    // A broken file is read like a first run: better a missed push than
    // the whole list sent again.
    return null
  }
}

function writeRouted(root: string, file: RoutedFile): void {
  const path = deskRoutedPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2))
  renameSync(tmp, path)
}

export interface DeskRouteDeps {
  root: string
  now: number
  list: OwnerList
  routing: DeskRouting
  /** Tell the phone. `urgent`: it expires within a day. */
  phone(item: DeskCard, urgent: boolean): Promise<void>
  /** Show it on this computer. False: held (Focus), try again next time.
   *  Unset: the computer has its own reader (the Mac card) or nothing. */
  computer?: (item: DeskCard) => Promise<boolean>
  log: (msg: string) => void
}

export interface DeskRouteResult {
  primed: boolean
  phone: string[]
  computer: string[]
}

export async function routeDesk(deps: DeskRouteDeps): Promise<DeskRouteResult> {
  const { root, now, list, routing, log } = deps
  const result: DeskRouteResult = { primed: false, phone: [], computer: [] }
  const nowIso = new Date(now).toISOString()
  const file = readRouted(root)
  if (!file) {
    // First run, or a file that could not be read: what waits now was
    // there before this ran, and is on the Desk already.
    const items: RoutedFile["items"] = {}
    for (const c of list.items) items[c.key] = { at: nowIso, seen: nowIso }
    writeRouted(root, { items })
    result.primed = true
    return result
  }

  const fresh: DeskCard[] = []
  const retry: DeskCard[] = []
  for (const c of list.items) {
    const entry = file.items[c.key]
    if (entry) {
      entry.seen = nowIso
      // Held past the age limit: it is on the Desk, no longer news.
      if (entry.computerHeld && now - Date.parse(entry.at) > DESK_ROUTE_MAX_AGE_MS) delete entry.computerHeld
      if (entry.computerHeld) retry.push(c)
      continue
    }
    file.items[c.key] = { at: nowIso, seen: nowIso }
    const asked = c.askedAt ? Date.parse(c.askedAt) : now
    if (now - asked <= DESK_ROUTE_MAX_AGE_MS) fresh.push(c)
  }
  for (const [key, e] of Object.entries(file.items)) {
    if (now - Date.parse(e.seen) > KEEP_MS) delete file.items[key]
  }
  // Recorded before anything is sent: a send that hangs or crashes must
  // not send it again next minute.
  writeRouted(root, file)

  for (const c of fresh) {
    if (reaches(routing.phone, c, now)) {
      try {
        await deps.phone(c, isUrgent(c, now))
        result.phone.push(c.key)
      } catch (e: any) {
        log(`[desk] ${c.key}: not sent to the phone: ${e?.message ?? e}`)
      }
    }
  }
  if (deps.computer) {
    let changed = false
    for (const c of [...retry, ...fresh]) {
      const entry = file.items[c.key]
      if (!reaches(routing.computer, c, now)) {
        if (entry.computerHeld) { delete entry.computerHeld; changed = true }
        continue
      }
      try {
        const shown = await deps.computer(c)
        if (shown) result.computer.push(c.key)
        if (shown && entry.computerHeld) { delete entry.computerHeld; changed = true }
        if (!shown && !entry.computerHeld) { entry.computerHeld = true; changed = true }
      } catch (e: any) {
        log(`[desk] ${c.key}: not shown on this computer: ${e?.message ?? e}`)
        if (entry.computerHeld) { delete entry.computerHeld; changed = true }
      }
    }
    if (changed) writeRouted(root, file)
  }
  if (result.phone.length || result.computer.length) {
    log(`[desk] routed: ${result.phone.length} to the phone, ${result.computer.length} to this computer`)
  }
  return result
}

/** The push or banner text for one item: its title, and what it asks. */
export function deskNotice(item: DeskCard): { title: string; message: string } {
  const what = item.ask ?? item.need ?? item.facts ?? "It waits for you."
  return { title: item.title, message: `${what}\nAnswer it on the Desk.` }
}
