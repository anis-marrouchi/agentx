import type Database from "better-sqlite3"
import { numberView } from "./daemon-api"
import { NumberStore } from "./store"
import { parseFunnel, type FunnelSpec } from "./funnel"

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
//
// `funnels` (#1826 N4): the funnels of this machine's agentx.json
// (`numbers.funnels`), each with its id; one that does not parse is left out.

export const NUMBERS_HUB_PATH = "/api/admin/numbers"

/** Readings sent per number: enough for the trend and the detail table. */
export const HUB_READINGS = 12

export function hasNumbersTable(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'numbers'").get()
}

/** The funnels set up, by id, in config order; bad ones left out. */
export function funnelsOf(raw: Record<string, unknown> | undefined): Array<FunnelSpec & { id: string }> {
  const out: Array<FunnelSpec & { id: string }> = []
  for (const [id, f] of Object.entries(raw ?? {})) {
    const parsed = parseFunnel(f)
    if (!("error" in parsed)) out.push({ id, ...parsed })
  }
  return out
}

export function numbersHubReply(db: Database.Database | null, now: number, funnels?: Record<string, unknown>) {
  const fs = funnelsOf(funnels)
  if (!db || !hasNumbersTable(db)) return { count: 0, numbers: [], funnels: fs }
  const store = new NumberStore(db)
  const numbers = store.list().map((n) => numberView(store, n, now, HUB_READINGS))
  return { count: numbers.length, numbers, funnels: fs }
}
