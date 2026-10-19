import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { NativePriority, NativeTasks } from "@/native"
import { summarize } from "@/requests/card-view"
import type { RequestRecord } from "@/requests/store"
import { CARD_LIMITS, type DecisionCard } from "./cards"

// --- The Reminders mirror (#1062 step 5) ---
//
// Each pending decision card, and each request waiting on the owner,
// becomes one task in the OS task app (Apple Reminders on a Mac) with a due
// time. Calendar shows it, and the system alert comes back when it falls
// due. Answering stays on the Desk, the Approvals page or the CLI: a task
// cannot carry choices or a draft.
//
// Runs once a minute beside the approvals sweep, on the node that holds the
// cards (forwarded cards live on the owner's node, so that is where they
// are mirrored). Off by default.
//
// Rules:
//   - one task per card or request, created once;
//   - the card is answered, expires or is closed, or the request stops
//     waiting on the owner: the task is completed;
//   - the owner ticks the task off or deletes it while the item still
//     waits: the item stays on the Desk and is never mirrored again.
//     Ticking a task is not an answer;
//   - three failed adds for one item: the owner is told once and that
//     item is not tried again;
//   - every task ends with `agentx: card=<id>` or `agentx: request=<id>`,
//     which check-ins and the reminders hand-back skip, so a mirrored
//     task never turns back into a card or an agent's job.
//
// State lives in its own file, written only by the daemon, not in the card
// files that the CLI and the dashboard also write.

export interface MirrorSettings {
  enabled: boolean
  list: string
  dueAfterMinutes: number
  include: ("card" | "request")[]
  /** Where the owner answers. Unset: the local dashboard's Approvals page. */
  answerUrl?: string
}

export type MirrorState = "open" | "completed" | "dismissed" | "failed"

export interface MirrorEntry {
  /** The task's id in the OS task app, once added. */
  id?: string
  list: string
  state: MirrorState
  /** ISO time of the last change. */
  at: string
  failures: number
  lastError?: string
}

export interface MirrorFile {
  /** Keyed `card:<id>` or `request:<id>`, the inbox's keys. */
  items: Record<string, MirrorEntry>
  /** The latest pass's last error, for doctor. */
  lastError?: { at: string; message: string }
}

export const MAX_ADD_FAILURES = 3
/** Closed entries are kept this long, then forgotten. */
const KEEP_CLOSED_MS = 30 * 24 * 3_600_000

export function mirrorPath(root: string): string {
  return resolve(root, ".agentx", "native-mirror.json")
}

export function readMirror(root: string): MirrorFile {
  try {
    const parsed = JSON.parse(readFileSync(mirrorPath(root), "utf-8"))
    return { items: parsed?.items && typeof parsed.items === "object" ? parsed.items : {}, ...(parsed?.lastError ? { lastError: parsed.lastError } : {}) }
  } catch {
    return { items: {} }
  }
}

function writeMirror(root: string, file: MirrorFile): void {
  const path = mirrorPath(root)
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n")
  renameSync(tmp, path)
}

/** True when this card has an open task: the Mac popup leaves it alone. */
export function cardMirrored(root: string, cardId: string): boolean {
  return readMirror(root).items[`card:${cardId}`]?.state === "open"
}

/** What one task says. */
export interface MirrorItem {
  key: string
  title: string
  notes: string
  due: Date
  priority: NativePriority
}

const DAY_MS = 24 * 3_600_000

function dueFor(now: number, settings: MirrorSettings, limit?: number): Date {
  const due = now + settings.dueAfterMinutes * 60_000
  return new Date(limit !== undefined && Number.isFinite(limit) ? Math.max(now, Math.min(due, limit)) : due)
}

export function cardItem(card: DecisionCard, settings: MirrorSettings, answerUrl: string, now: number): MirrorItem {
  const expires = Date.parse(card.expires)
  const lines = [summarize(card.ask, CARD_LIMITS.ask)]
  if (card.choices?.length) lines.push(...card.choices.map((c, i) => `${i + 1}. ${c}`))
  if (card.recommend) lines.push(`Recommended: ${summarize(card.recommend, CARD_LIMITS.recommend)}`)
  lines.push(`Answer: ${answerUrl}`, `agentx: card=${card.id}`)
  return {
    key: `card:${card.id}`,
    title: summarize(card.title, CARD_LIMITS.title),
    notes: lines.join("\n"),
    due: dueFor(now, settings, expires),
    priority: Number.isFinite(expires) && expires - now <= DAY_MS ? "high" : "none",
  }
}

export function requestItem(r: RequestRecord, settings: MirrorSettings, answerUrl: string, now: number): MirrorItem {
  const lines = [summarize(r.question || r.text, CARD_LIMITS.ask), `Asked of ${r.agentId}.`, `Answer: ${answerUrl}`, `agentx: request=${r.id}`]
  const dueAt = r.dueAt ?? undefined
  return {
    key: `request:${r.id}`,
    title: summarize(r.text, CARD_LIMITS.title),
    notes: lines.join("\n"),
    due: dueFor(now, settings, dueAt),
    priority: dueAt !== undefined && dueAt - now <= DAY_MS ? "high" : "none",
  }
}

export interface MirrorDeps {
  root: string
  settings: MirrorSettings
  tasks: NativeTasks
  /** Pending cards on this node. */
  cards: () => DecisionCard[]
  /** Requests in waiting_owner. */
  requests: () => RequestRecord[]
  answerUrl: string
  /** Tell the owner, through the usual notification. */
  notify: (title: string, message: string) => Promise<void>
  log: (msg: string) => void
  now?: number
}

export interface MirrorResult {
  created: number
  completed: number
  dismissed: number
  failed: number
}

/** One pass of the mirror. Never throws. */
export async function runMirror(deps: MirrorDeps): Promise<MirrorResult> {
  const { root, settings, tasks, log } = deps
  const now = deps.now ?? Date.now()
  const at = new Date(now).toISOString()
  const result: MirrorResult = { created: 0, completed: 0, dismissed: 0, failed: 0 }
  const file = readMirror(root)
  // lastError says how the latest pass went: a clean pass clears it.
  delete file.lastError
  const fail = (message: string) => { file.lastError = { at, message } }

  const waiting = new Map<string, MirrorItem>()
  try {
    if (settings.include.includes("card")) {
      for (const c of deps.cards()) if (c.status === "pending" && Date.parse(c.expires) > now) waiting.set(`card:${c.id}`, cardItem(c, settings, deps.answerUrl, now))
    }
    if (settings.include.includes("request")) {
      for (const r of deps.requests()) if (r.state === "waiting_owner") waiting.set(`request:${r.id}`, requestItem(r, settings, deps.answerUrl, now))
    }
  } catch (e: any) {
    log(`[mirror] could not read what is waiting: ${e?.message ?? e}`)
    fail(String(e?.message ?? e))
    writeMirror(root, file)
    return result
  }

  // Close or notice dismissal for what is already mirrored. The open list
  // is read once per list; when it can't be read, nothing is closed or
  // dismissed this pass, so a hiccup never loses a task.
  const openIds = new Map<string, Set<string> | null>()
  const openIn = async (list: string): Promise<Set<string> | null> => {
    if (!openIds.has(list)) {
      try {
        openIds.set(list, new Set((await tasks.listOpen(list)).map((t) => t.id)))
      } catch (e: any) {
        log(`[mirror] could not read list "${list}": ${e?.message ?? e}`)
        fail(String(e?.message ?? e))
        openIds.set(list, null)
      }
    }
    return openIds.get(list)!
  }

  for (const [key, entry] of Object.entries(file.items)) {
    if (entry.state !== "open" || !entry.id) continue
    const open = await openIn(entry.list)
    if (!open) continue
    if (!waiting.has(key)) {
      if (open.has(entry.id)) {
        try {
          await tasks.complete(entry.id)
        } catch (e: any) {
          log(`[mirror] ${key}: could not complete its task: ${e?.message ?? e}`)
          fail(String(e?.message ?? e))
          continue
        }
      }
      file.items[key] = { ...entry, state: "completed", at }
      result.completed++
    } else if (!open.has(entry.id)) {
      file.items[key] = { ...entry, state: "dismissed", at }
      result.dismissed++
      log(`[mirror] ${key}: its task was ticked off or deleted; it stays on the Desk and is not mirrored again`)
    }
  }

  let listReady: boolean | null = null
  for (const [key, item] of waiting) {
    const entry = file.items[key]
    if (entry && (entry.state === "open" || entry.state === "dismissed")) continue
    if (entry?.state === "failed" && entry.failures >= MAX_ADD_FAILURES) continue
    // The list is made on the first add of a pass, when it is missing.
    if (listReady === null) {
      try {
        await tasks.ensureList(settings.list)
        listReady = true
      } catch (e: any) {
        log(`[mirror] could not make list "${settings.list}": ${e?.message ?? e}`)
        fail(String(e?.message ?? e))
        listReady = false
      }
    }
    const failures = entry?.state === "failed" ? entry.failures : 0
    try {
      const { id } = await tasks.add({ list: settings.list, title: item.title, notes: item.notes, due: item.due, priority: item.priority })
      file.items[key] = { id, list: settings.list, state: "open", at, failures: 0 }
      result.created++
    } catch (e: any) {
      const message = String(e?.message ?? e)
      const n = failures + 1
      file.items[key] = { list: settings.list, state: "failed", at, failures: n, lastError: message }
      fail(message)
      result.failed++
      log(`[mirror] ${key}: could not add to Reminders (${n}/${MAX_ADD_FAILURES}): ${message}`)
      if (n === MAX_ADD_FAILURES) {
        try {
          await deps.notify("Could not add to Reminders", `${item.title}: ${summarize(message, 200)}. It is still on the Desk.`)
        } catch (err: any) {
          log(`[mirror] ${key}: could not tell the owner: ${err?.message ?? err}`)
        }
      }
    }
  }

  for (const [key, entry] of Object.entries(file.items)) {
    if (entry.state !== "open" && !waiting.has(key) && now - Date.parse(entry.at) > KEEP_CLOSED_MS) delete file.items[key]
  }
  writeMirror(root, file)
  return result
}
