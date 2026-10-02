import type Database from "better-sqlite3"

// --- Slow query log (#448) ---
//
// better-sqlite3 runs a query on the thread that called it. In a process
// that serves pages, one slow query stops every page until it returns, and
// nothing says which query it was. This times each query and reports the
// ones that held the process for `thresholdMs` or longer.

export const SLOW_QUERY_MS = 200

export interface QueryTiming {
  /** The statement as written: placeholders, never the values bound to them. */
  sql: string
  ms: number
}

const watched = new WeakSet<Database.Database>()

/** Time every statement prepared on `db` from now on. A database is watched once. */
export function watchSlowQueries(
  db: Database.Database,
  report: (q: QueryTiming) => void,
  opts: { thresholdMs?: number; now?: () => number } = {},
): void {
  if (watched.has(db)) return
  watched.add(db)
  const threshold = opts.thresholdMs ?? SLOW_QUERY_MS
  const now = opts.now ?? (() => performance.now())
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const statement = prepare(sql) as any
    for (const method of ["all", "get", "run"]) {
      const call = statement[method].bind(statement)
      statement[method] = (...args: unknown[]) => {
        const start = now()
        try {
          return call(...args)
        } finally {
          const ms = now() - start
          if (ms >= threshold) report({ sql, ms })
        }
      }
    }
    return statement
  }) as typeof db.prepare
}

/** A statement on one line, short enough for a log line. */
export function queryName(sql: string, max = 160): string {
  const line = sql.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Report slow queries on `db` to the process log, under `label`. */
export function logSlowQueries(db: Database.Database, label: string): void {
  watchSlowQueries(db, ({ sql, ms }) => console.error(`[${label}] slow query, ${Math.round(ms)} ms: ${queryName(sql)}`))
}
