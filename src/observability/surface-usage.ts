import { existsSync } from "fs"
import { resolve } from "path"
import { openDb } from "@/storage/sqlite"

// --- Which operator surfaces actually get used ---
//
// `task_history` answers "which agents ran". It says nothing about which of
// the ~46 CLI commands or 16 dashboard pages anyone ever opens — and those are
// the two biggest surfaces by count, so they are exactly what the
// surface-reduction work needs evidence for.
//
// See docs/architecture/surface-reduction.md for the bar a surface has to
// clear to survive. This module is the missing measurement.
//
// Three rules, all of them about being unobtrusive:
//
//   1. Names only. `agentx guard log --limit 5` records "guard log". A page
//      view records "/live". Never arguments, never query strings, never
//      payloads. This counts which door was opened, not what went through it.
//   2. Never create state. If there is no `.agentx` here, we are being run
//      from someone's home directory or a random repo — recording would
//      litter a stray database. Do nothing instead.
//   3. Never throw, never block. A telemetry bug must not break the CLI or a
//      dashboard request. Every failure is swallowed.

/** Where the install lives, or null when we're not inside one. Never creates
 *  anything — the check IS the guard against writing stray databases. */
function installRoot(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, ".agentx")) || existsSync(resolve(dir, "agentx.json"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return null
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export type SurfaceKind = "cli" | "page"

/**
 * Record one use of a surface. Silent no-op when we're outside an install,
 * when SQLite is unavailable, or on any error.
 */
export function recordSurfaceUse(kind: SurfaceKind, name: string, now = new Date()): void {
  try {
    if (!name) return
    if (!installRoot()) return
    const db = openDb({ quiet: true })
    if (!db) return
    db.prepare(
      `INSERT INTO surface_usage (kind, name, day, count, last_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(kind, name, day)
       DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    ).run(kind, name, today(now), now.toISOString())
  } catch {
    /* telemetry must never break the thing it measures */
  }
}

export interface SurfaceRow {
  kind: string
  name: string
  count: number
  days: number
  last_at: string | null
}

/** Usage totals over a window, busiest first. Powers `agentx usage surfaces`. */
export function listSurfaceUse(opts: { kind?: SurfaceKind; sinceDays?: number } = {}): SurfaceRow[] {
  try {
    const db = openDb({ quiet: true })
    if (!db) return []
    const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const where = ["day >= ?"]
    const params: unknown[] = [since]
    if (opts.kind) {
      where.push("kind = ?")
      params.push(opts.kind)
    }
    return db
      .prepare(
        `SELECT kind, name, SUM(count) AS count, COUNT(DISTINCT day) AS days, MAX(last_at) AS last_at
         FROM surface_usage
         WHERE ${where.join(" AND ")}
         GROUP BY kind, name
         ORDER BY count DESC`,
      )
      .all(...params) as SurfaceRow[]
  } catch {
    return []
  }
}

/**
 * The command path a commander invocation resolved to — "guard log", not
 * "guard log --limit 5". Walks up from the deepest matched subcommand so
 * nesting is preserved without ever touching argv.
 */
export function commandPath(cmd: { name(): string; parent?: unknown } | null | undefined): string {
  const parts: string[] = []
  let node: any = cmd
  while (node && typeof node.name === "function") {
    const n = node.name()
    // The root program is "agentx" itself — not a surface worth counting.
    if (node.parent) parts.unshift(n)
    node = node.parent
  }
  return parts.join(" ")
}

/** Hook entrypoints fire per tool call, not per human decision. Counting them
 *  would swamp the table and tell us nothing about operator behaviour. */
const NOT_A_SURFACE = new Set(["guard check", "completion", "serve"])

export function shouldRecordCommand(path: string): boolean {
  return Boolean(path) && !NOT_A_SURFACE.has(path)
}
