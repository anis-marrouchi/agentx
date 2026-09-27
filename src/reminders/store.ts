import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- What the poller has done with each reminder ---
//
// One small JSON file, written atomically. A reminder is claimed here
// BEFORE its task is dispatched, so a restart or a slow run never hands it
// over twice: a claimed reminder that is still open only gets ticked off.

export type ClaimStatus =
  /** Handed to the agent (or about to be); ticking it off is what's left. */
  | "claimed"
  /** Ticked off in Reminders. */
  | "done"
  /** Dispatch was refused; try again at `nextAt`. */
  | "retry"
  /** Overdue past the lookback window; the agent was told, nothing ran. */
  | "reported"

export interface ClaimRecord {
  agent: string
  status: ClaimStatus
  /** ISO time of the last change. */
  at: string
  attempts?: number
  /** ISO time of the next retry. */
  nextAt?: string
  error?: string
}

export type ClaimState = Record<string, ClaimRecord>

export function claimFile(root: string): string {
  return resolve(root, ".agentx", "reminders", "claims.json")
}

export function readClaims(path: string): ClaimState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

export function writeClaims(path: string, state: ClaimState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  renameSync(tmp, path)
}

/** Keep records for reminders still open, and anything touched in the last `keepDays`. */
export function pruneClaims(state: ClaimState, openIds: Set<string>, now: number, keepDays = 7): ClaimState {
  const cutoff = now - keepDays * 86_400_000
  const out: ClaimState = {}
  for (const [id, rec] of Object.entries(state)) {
    if (openIds.has(id) || Date.parse(rec.at) >= cutoff) out[id] = rec
  }
  return out
}
