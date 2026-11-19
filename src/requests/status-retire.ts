import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type Database from "better-sqlite3"

// --- Retire the request status tables (#1950) ---
//
// Request status (#383) was removed; the Jobs page replaces it. Its three
// tables are read by nothing any more. At start the daemon takes them out
// of the database, without losing a row:
//   - empty tables are dropped;
//   - otherwise the rows are written to .agentx/request-status-export-<time>.json
//     first, and dropped only once that file is written;
//   - a node that cannot write the file keeps the tables and says why.
// After the first start that drops them there is nothing left to do.

/** Children first: request_status is the parent of the other two. */
export const STATUS_TABLES = ["request_status_waits", "request_status_refs", "request_status"] as const

export type RetireOutcome = "none" | "dropped" | "exported" | "kept"

export function retireStatusTables(db: Database.Database, agentxDir: string, log: (msg: string) => void, now = Date.now()): RetireOutcome {
  const present = STATUS_TABLES.filter((t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
  if (present.length === 0) return "none"

  const rows: Record<string, unknown[]> = {}
  for (const t of STATUS_TABLES) rows[t] = present.includes(t) ? db.prepare(`SELECT * FROM ${t}`).all() : []
  const total = Object.values(rows).reduce((n, r) => n + r.length, 0)

  let file = ""
  if (total > 0) {
    file = join(agentxDir, `request-status-export-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`)
    try {
      mkdirSync(agentxDir, { recursive: true })
      // "wx": never overwrite an earlier export.
      writeFileSync(file, JSON.stringify({ exportedAt: new Date(now).toISOString(), reason: "request status was removed (#1950)", tables: rows }, null, 2) + "\n", { flag: "wx" })
    } catch (e: any) {
      log(`  Request status tables: kept, ${total} row(s) could not be exported to ${agentxDir} (${e?.message ?? e})`)
      return "kept"
    }
  }

  try {
    db.transaction(() => { for (const t of present) db.exec(`DROP TABLE IF EXISTS ${t}`) })()
  } catch (e: any) {
    log(`  Request status tables: kept, could not drop them (${e?.message ?? e})${file ? `; rows exported to ${file}` : ""}`)
    return "kept"
  }
  log(file
    ? `  Request status tables: removed; ${total} row(s) exported to ${file}`
    : "  Request status tables: removed (they were empty)")
  return file ? "exported" : "dropped"
}
