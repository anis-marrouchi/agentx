import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"
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
//   - a node that cannot write the file keeps the tables and says why;
//   - an export of the same rows already there (a drop that failed on an
//     earlier start) is reused, so retries do not pile up files.
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
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    file = earlierExport(agentxDir, digest) ?? join(agentxDir, `request-status-export-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`)
    try {
      if (!existsSync(file)) {
        mkdirSync(agentxDir, { recursive: true })
        // "wx": never overwrite an earlier export.
        writeFileSync(file, JSON.stringify({ exportedAt: new Date(now).toISOString(), reason: "request status was removed (#1950)", digest, tables: rows }, null, 2) + "\n", { flag: "wx" })
      }
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

/** An export already written for exactly these rows, if any. */
function earlierExport(agentxDir: string, digest: string): string | null {
  let names: string[]
  try { names = readdirSync(agentxDir) } catch { return null }
  for (const name of names.filter((n) => n.startsWith("request-status-export-") && n.endsWith(".json")).sort()) {
    const path = join(agentxDir, name)
    try { if (JSON.parse(readFileSync(path, "utf-8")).digest === digest) return path } catch { /* not ours, or unreadable */ }
  }
  return null
}
