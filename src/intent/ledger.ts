import Database from "better-sqlite3"
import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"

// Intent ledger — Phase 1 of the architectural rescue.
//
// Append-only SQLite store that becomes the single source of truth for
// dispatch decisions across all sources (channel router, workflow
// dispatcher, gitlab handler, cron, mesh). This commit only opens the db
// and runs the schema migrations. The read/write API arrives in commit 2;
// the `decideAndCommit` skeleton in commit 3.
//
// Lives in its own database file (`.agentx/intent/ledger.sqlite`) rather
// than sharing the existing observability db at `.agentx/db.sqlite`:
//   - Different lifecycle: dispatch is hotter than observability, no point
//     making fsync compete.
//   - Different durability story: the ledger is canonical state; the
//     observability tables are derived. Different backup/retention policies.
//   - Cleaner schema separation — ledger migrations don't entangle with the
//     observability ones.
//
// WAL mode + synchronous=NORMAL — same balance the observability db uses.

export interface OpenLedgerOptions {
  /** Resolved relative to cwd. Default: .agentx/intent/ledger.sqlite */
  path?: string
}

/**
 * IntentLedger handle. One instance per database file. Tests open per-test
 * tmp instances; the daemon opens one process-global instance (added in a
 * later commit when daemon wiring lands).
 */
export class IntentLedger {
  readonly db: Database.Database
  readonly path: string

  constructor(opts: OpenLedgerOptions = {}) {
    this.path = resolve(process.cwd(), opts.path ?? ".agentx/intent/ledger.sqlite")
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new Database(this.path)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("synchronous = NORMAL")
    this.db.pragma("foreign_keys = ON")
    runMigrations(this.db)
  }

  /** Test-only — production never closes. */
  close(): void {
    this.db.close()
  }

  /** Current schema version. New migrations append to the runMigrations
   *  list and bump the version. Useful for tests + diagnostics. */
  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(v) AS v FROM schema_version").get() as { v: number | null }
    return row.v ?? 0
  }
}

/**
 * Per-version schema steps. New tables / columns go in a new migration
 * function — never mutate an old one. Each step is idempotent so re-running
 * on an already-current db is safe.
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

  if (current < 1) migrationV1(db)
}

function migrationV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_events (
      -- TEXT PRIMARY KEY isn't auto-NOT-NULL in SQLite; spell it out so the
      -- ULID invariant is enforced at the schema level rather than relying on
      -- the application layer.
      id              TEXT NOT NULL PRIMARY KEY,
      ts              INTEGER NOT NULL,
      source          TEXT NOT NULL,
      source_event_id TEXT,
      project         TEXT,
      subject         TEXT,
      intent          TEXT,
      raw_json        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intent_events_subject
      ON intent_events (project, subject);
    CREATE INDEX IF NOT EXISTS idx_intent_events_source_event_id
      ON intent_events (source, source_event_id);
    CREATE INDEX IF NOT EXISTS idx_intent_events_ts
      ON intent_events (ts);

    CREATE TABLE IF NOT EXISTS intent_decisions (
      event_id    TEXT NOT NULL REFERENCES intent_events(id),
      decided_at  INTEGER NOT NULL,
      decided_by  TEXT NOT NULL,
      agent_id    TEXT,
      outcome     TEXT NOT NULL,
      reason      TEXT,
      PRIMARY KEY (event_id, decided_by)
    );

    CREATE INDEX IF NOT EXISTS idx_intent_decisions_agent
      ON intent_decisions (agent_id, decided_at);
    CREATE INDEX IF NOT EXISTS idx_intent_decisions_outcome
      ON intent_decisions (outcome, decided_at);

    CREATE TABLE IF NOT EXISTS intent_resolutions (
      decision_event_id    TEXT NOT NULL,
      decision_decided_by  TEXT NOT NULL,
      resolved_at          INTEGER NOT NULL,
      status               TEXT NOT NULL,
      duration_ms          INTEGER,
      result_summary       TEXT,
      PRIMARY KEY (decision_event_id, decision_decided_by),
      FOREIGN KEY (decision_event_id, decision_decided_by)
        REFERENCES intent_decisions(event_id, decided_by)
    );

    CREATE INDEX IF NOT EXISTS idx_intent_resolutions_status
      ON intent_resolutions (status, resolved_at);
  `)
  db.prepare("INSERT INTO schema_version (v) VALUES (1)").run()
}

// existsSync is imported for symmetry with src/storage/sqlite.ts; the
// ledger constructor doesn't currently branch on file presence (the
// migration is idempotent regardless), but keeping the import documents
// the intent should later code need to distinguish first-open from re-open.
void existsSync
