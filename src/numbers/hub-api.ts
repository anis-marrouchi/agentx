import type Database from "better-sqlite3"
import { numberView } from "./daemon-api"
import { NumberStore } from "./store"

// --- The Hub's read of the numbers (#1826 N2) ---
//
//   GET /api/admin/numbers   every tracked number on this machine, each with
//                            its status, newest reading and its last
//                            HUB_READINGS readings for the trend
//
// Served by the dashboard after its admin token gate; another machine's
// numbers come through the dashboard's peer proxy. Sources are masked by
// numberView exactly as the agents' /numbers masks them: header values,
// query values and command text never leave the machine.
//
// A machine with no numbers set up has no `numbers` table: the reply is an
// empty list and the dashboard writes nothing.

export const NUMBERS_HUB_PATH = "/api/admin/numbers"

/** Readings sent per number: enough for the trend and the detail table. */
export const HUB_READINGS = 12

export function hasNumbersTable(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'numbers'").get()
}

export function numbersHubReply(db: Database.Database | null, now: number) {
  if (!db || !hasNumbersTable(db)) return { count: 0, numbers: [] }
  const store = new NumberStore(db)
  const numbers = store.list().map((n) => numberView(store, n, now, HUB_READINGS))
  return { count: numbers.length, numbers }
}
