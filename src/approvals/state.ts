import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import { approvalsDir } from "./cards"

// --- Inbox view state: "later" and the digest date ---
//
// Not a decision store. Every decision stays with its source (the card
// file, the schedule in agentx.json, the memory fact, the wiki proposal).
// This file only remembers which inbox items the operator put off until
// when, and the last day a digest went out.

export interface InboxState {
  /** Inbox key → ISO time it comes back. */
  snoozed: Record<string, string>
  /** Local date (YYYY-MM-DD) of the last digest sent. */
  lastDigest?: string
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
