import Database from "better-sqlite3"
import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"

// --- SQLite storage layer ---
//
// Move 2 of the architectural review (docs/architecture/hexabot-vs-agentx.md).
// SQLite for the operational tables — task_history, usage, dedup, sessions —
// where queryable, indexed access has user-visible value (dashboards,
// retention, analytics). Workflow definitions, wiki, agent-memory, and
// references stay as files: they're git-diffable, human-readable, and don't
// need queries.
//
// Approach: subscribe to the event bus (src/events/bus.ts) and write to
// SQLite from the subscribers. Existing JSON writes are not touched —
// SQLite runs alongside as a parallel pipeline. Once we have a query API
// the dashboard depends on, we can deprecate the JSON path. Until then,
// SQLite is observability-grade only.
//
// Synchronous API: better-sqlite3 is sync, no callbacks. The daemon's
// event loop is the single writer; multiple readers (dashboard) use WAL
// mode for concurrent read while we write.

let _db: Database.Database | undefined

export interface OpenOptions {
  /** Resolved relative to cwd. Default: .agentx/db.sqlite */
  path?: string
  /** When true, SQLite writes are skipped (used by tests + opt-out). */
  disabled?: boolean
}

/**
 * Open the per-process SQLite database. Idempotent — repeated calls
 * return the same handle. The file is created on first open; the schema
 * is migrated forward to the latest version.
 *
 * Returns null when disabled — every subscriber should check for null
 * before issuing a write so the daemon stays runnable without SQLite if
 * someone's environment can't compile the native binding.
 */
export function openDb(opts: OpenOptions = {}): Database.Database | null {
  if (opts.disabled) return null
  if (_db) return _db
  const path = resolve(process.cwd(), opts.path ?? ".agentx/db.sqlite")
  try {
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    // WAL keeps readers (dashboard) unblocked while the daemon writes.
    // Synchronous=NORMAL is the SQLite-recommended balance for WAL: the
    // db is durable on power-loss, but a crash within the last few ms can
    // lose the most recent commit. For our use (observability), that's fine.
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous = NORMAL")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
    _db = db
    return _db
  } catch (e: any) {
    // Native binding missing, file unwritable, etc. Log and return null
    // so subscribers no-op.
    if (process.env.AGENTX_DEBUG) {
      console.error(`[storage/sqlite] openDb failed: ${e.message}`)
    }
    return null
  }
}

/** Close the global handle. Test-only — production never closes. */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = undefined
  }
}

/**
 * Per-version schema steps. New tables / columns go in a new migration —
 * never mutate an old one. Run on every open(); each step is idempotent
 * because it CREATE TABLE IF NOT EXISTS. SQLite has no concurrent
 * migration issue here (single writer process).
 */
function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      v INTEGER PRIMARY KEY
    );
  `)
  const current = (db
    .prepare("SELECT MAX(v) AS v FROM schema_version")
    .get() as { v: number | null }).v ?? 0

  const steps: Array<{ v: number; sql: string }> = [
    {
      v: 1,
      sql: `
        CREATE TABLE task_history (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          channel TEXT,
          chat_id TEXT,
          status TEXT NOT NULL,           -- 'ok' | 'error' | 'timeout'
          message_preview TEXT,
          error TEXT,
          duration_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_create_tokens INTEGER,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL
        );
        CREATE INDEX idx_task_history_agent_started
          ON task_history(agent_id, started_at);
        CREATE INDEX idx_task_history_status
          ON task_history(status, started_at);
      `,
    },
    {
      v: 2,
      sql: `
        CREATE TABLE usage_daily (
          agent_id TEXT NOT NULL,
          model TEXT NOT NULL,
          day TEXT NOT NULL,                  -- 'YYYY-MM-DD' UTC
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_create_tokens INTEGER DEFAULT 0,
          tasks INTEGER DEFAULT 0,
          PRIMARY KEY (agent_id, model, day)
        );
        CREATE INDEX idx_usage_day ON usage_daily(day);
      `,
    },
    {
      v: 3,
      sql: `
        CREATE TABLE rotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          reason TEXT NOT NULL,           -- 'stale' | 'tier-2' | 'max-turns'
          last_turn_input_tokens INTEGER,
          rotated_at TEXT NOT NULL
        );
        CREATE INDEX idx_rotations_agent_at
          ON rotations(agent_id, rotated_at);
      `,
    },
    {
      v: 4,
      sql: `
        CREATE TABLE route_traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          msg_id TEXT NOT NULL,
          account_id TEXT,
          kind TEXT NOT NULL,             -- 'match' | 'drop'
          deciding_stage TEXT,
          agent_id TEXT,
          reason TEXT,
          at TEXT NOT NULL
        );
        CREATE INDEX idx_route_traces_channel_at
          ON route_traces(channel, at);
      `,
    },
  ]

  const txn = db.transaction((step: { v: number; sql: string }) => {
    db.exec(step.sql)
    db.prepare("INSERT INTO schema_version (v) VALUES (?)").run(step.v)
  })

  for (const step of steps) {
    if (step.v > current) txn(step)
  }
}

/** Schema version check for tests. */
export function getSchemaVersion(db: Database.Database): number {
  return (db.prepare("SELECT MAX(v) AS v FROM schema_version").get() as { v: number | null }).v ?? 0
}
