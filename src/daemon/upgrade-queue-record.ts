import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

// --- What the old daemon's queue did at an upgrade switch (#2360) ---
//
// The old daemon closes its admission queue on the way down; the upgrade
// job, running past that, reads the counts into last.json `drain`. Written
// only when a start hold was on at close, so a plain restart leaves none.

export const QUEUE_AT_CLOSE_FILE = "queue-at-close.json"

export interface QueueAtClose {
  at: string
  /** Chat messages kept for replay on boot. */
  kept: number
  /** Other waiting runs answered "the daemon is restarting". */
  refused: number
}

export function writeQueueAtClose(agentxDir: string, rec: QueueAtClose): void {
  const dir = resolve(agentxDir, "upgrade")
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, QUEUE_AT_CLOSE_FILE), JSON.stringify(rec) + "\n")
}

/** The record written at or after `sinceIso`, else null. */
export function readQueueAtClose(agentxDir: string, sinceIso: string): QueueAtClose | null {
  const path = resolve(agentxDir, "upgrade", QUEUE_AT_CLOSE_FILE)
  if (!existsSync(path)) return null
  try {
    const rec = JSON.parse(readFileSync(path, "utf-8")) as QueueAtClose
    if (typeof rec.kept !== "number" || typeof rec.refused !== "number") return null
    return Date.parse(rec.at) >= Date.parse(sinceIso) ? rec : null
  } catch {
    return null
  }
}
