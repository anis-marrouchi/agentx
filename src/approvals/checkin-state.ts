import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { approvalsDir } from "./cards"

// --- What the check-ins remember ---
//
// The last pass that ran (so a pass runs once per slot), and what each
// open reminder led to: a card, "doesn't need the operator", or a failed
// attempt. One small JSON file beside the cards, written atomically.

export type ItemStatus =
  /** A card was raised; it is the card's status that counts now. */
  | "carded"
  /** The agent said it doesn't need the operator. Asked again next day. */
  | "skipped"
  /** Composing failed; tried once more at the next pass, then at the next daily pass. */
  | "failed"

export interface ItemRecord {
  status: ItemStatus
  owner: string
  /** ISO time of the last change. */
  at: string
  card?: string
  why?: string
  /** Failed attempts on the day of `at`. */
  tries?: number
}

export interface CheckinState {
  /** "YYYY-MM-DD HH:MM" of the last slot that ran. */
  lastSlot?: string
  /** Local date of the last daily pass. */
  lastDaily?: string
  items: Record<string, ItemRecord>
}

export function checkinFile(root: string): string {
  // "_" keeps it out of listCards, like _state.json.
  return resolve(approvalsDir(root), "_checkin.json")
}

export function readCheckinState(root: string): CheckinState {
  try {
    const raw = JSON.parse(readFileSync(checkinFile(root), "utf-8"))
    return {
      ...(typeof raw?.lastSlot === "string" ? { lastSlot: raw.lastSlot } : {}),
      ...(typeof raw?.lastDaily === "string" ? { lastDaily: raw.lastDaily } : {}),
      items: raw?.items && typeof raw.items === "object" && !Array.isArray(raw.items) ? raw.items : {},
    }
  } catch {
    return { items: {} }
  }
}

export function writeCheckinState(root: string, state: CheckinState): void {
  const path = checkinFile(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  renameSync(tmp, path)
}

/** Forget reminders that are no longer open and haven't changed in two weeks. */
export function pruneItems(items: CheckinState["items"], open: Set<string>, now: number): CheckinState["items"] {
  const cutoff = now - 14 * 86_400_000
  const out: CheckinState["items"] = {}
  for (const [id, rec] of Object.entries(items)) if (open.has(id) || Date.parse(rec.at) >= cutoff) out[id] = rec
  return out
}
