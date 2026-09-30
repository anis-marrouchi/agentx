import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import { approvalsDir } from "./cards"

// --- Inbox view state: "later" and the digest date ---
//
// Not a decision store. Every decision stays with its source (the card
// file, the schedule in agentx.json, the memory fact, the wiki proposal).
// This file only remembers which inbox items the operator put off until
// when, the last day a digest went out, and which cards the Mac popup
// has already shown.

export interface InboxState {
  /** Inbox key → ISO time it comes back. */
  snoozed: Record<string, string>
  /** Local date (YYYY-MM-DD) of the last digest sent. */
  lastDigest?: string
  /** Inbox key → ISO time the Mac popup showed it. Shown once, not every minute. */
  popped?: Record<string, string>
}

function stateFile(root: string): string {
  return resolve(approvalsDir(root), "_state.json")
}

export function readInboxState(root: string): InboxState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(root), "utf-8"))
    return {
      snoozed: raw && typeof raw.snoozed === "object" && raw.snoozed ? raw.snoozed : {},
      ...(typeof raw?.lastDigest === "string" ? { lastDigest: raw.lastDigest } : {}),
      ...(raw?.popped && typeof raw.popped === "object" ? { popped: raw.popped } : {}),
    }
  } catch {
    return { snoozed: {} }
  }
}

export function writeInboxState(root: string, state: InboxState): void {
  mkdirSync(approvalsDir(root), { recursive: true })
  const path = stateFile(root)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  renameSync(tmp, path)
}

/** Put an item off until `until`. Drops snoozes that have run out. */
export function snooze(root: string, key: string, until: Date, now: number = Date.now()): void {
  const state = readInboxState(root)
  const snoozed: Record<string, string> = {}
  for (const [k, v] of Object.entries(state.snoozed)) if (Date.parse(v) > now) snoozed[k] = v
  snoozed[key] = until.toISOString()
  writeInboxState(root, { ...state, snoozed })
}

export function recordDigest(root: string, localDate: string): void {
  writeInboxState(root, { ...readInboxState(root), lastDigest: localDate })
}

/** Record that the popup showed `key`. Forgets keys no longer waiting,
 *  so the file stays as small as the inbox. */
export function recordPopped(root: string, key: string, waiting: string[], now: number = Date.now()): void {
  const state = readInboxState(root)
  const keep = new Set(waiting)
  const popped: Record<string, string> = {}
  for (const [k, v] of Object.entries(state.popped ?? {})) if (keep.has(k)) popped[k] = v
  popped[key] = new Date(now).toISOString()
  writeInboxState(root, { ...state, popped })
}
