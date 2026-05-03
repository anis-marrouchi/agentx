import Database from "better-sqlite3"
import { existsSync, mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { newEventId } from "./ulid"
import type {
  IntentDecision,
  IntentDivergence,
  IntentEvent,
  IntentEventInput,
  IntentResolution,
  IntentSource,
} from "./types"

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

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Append an event. Idempotent on `(source, sourceEventId)` — a re-delivery
   * with the same external id returns the previously-stored row without
   * inserting a duplicate. Events with `sourceEventId === null` (cron tics,
   * ad-hoc internal events) are NOT deduplicated; each call writes a new row.
   *
   * Returns the canonical (existing or new) event row including its id.
   */
  recordEvent(input: IntentEventInput): IntentEvent {
    if (input.sourceEventId !== null) {
      const existing = this.findEventBySourceId(input.source, input.sourceEventId)
      if (existing) return existing
    }
    const event: IntentEvent = {
      id: input.id ?? newEventId(input.ts),
      ts: input.ts,
      source: input.source,
      sourceEventId: input.sourceEventId,
      project: input.project,
      subject: input.subject,
      intent: input.intent,
      rawJson: input.rawJson,
    }
    this.db
      .prepare(
        `INSERT INTO intent_events (id, ts, source, source_event_id, project, subject, intent, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.ts,
        event.source,
        event.sourceEventId,
        event.project,
        event.subject,
        event.intent,
        event.rawJson,
      )
    return event
  }

  /** Idempotency probe — used by `recordEvent` and by external callers that
   *  want to check existence before constructing a full event payload. */
  findEventBySourceId(source: IntentSource, sourceEventId: string): IntentEvent | null {
    const row = this.db
      .prepare(
        `SELECT id, ts, source, source_event_id, project, subject, intent, raw_json
         FROM intent_events WHERE source = ? AND source_event_id = ?`,
      )
      .get(source, sourceEventId) as EventRow | undefined
    return row ? rowToEvent(row) : null
  }

  /** Lookup by primary key. Returns null when not found. */
  getEventById(id: string): IntentEvent | null {
    const row = this.db
      .prepare(
        `SELECT id, ts, source, source_event_id, project, subject, intent, raw_json
         FROM intent_events WHERE id = ?`,
      )
      .get(id) as EventRow | undefined
    return row ? rowToEvent(row) : null
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * Append a decision. Throws on `(eventId, decidedBy)` conflict — decisions
   * are once-and-only-once per decider. Idempotency for the *event* is the
   * caller's responsibility (use `recordEvent` for that); decisions
   * intentionally do not retry-coalesce so a buggy caller surfaces loudly
   * instead of silently overwriting prior judgement.
   */
  recordDecision(decision: IntentDecision): void {
    this.db
      .prepare(
        `INSERT INTO intent_decisions (event_id, decided_at, decided_by, agent_id, outcome, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.eventId,
        decision.decidedAt,
        decision.decidedBy,
        decision.agentId,
        decision.outcome,
        decision.reason,
      )
  }

  /** All decisions for one event, oldest first. The chain (channel-router →
   *  pm-gate → workflow) reads naturally in insertion order. */
  getDecisionsForEvent(eventId: string): IntentDecision[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, decided_at, decided_by, agent_id, outcome, reason
         FROM intent_decisions WHERE event_id = ? ORDER BY decided_at ASC`,
      )
      .all(eventId) as DecisionRow[]
    return rows.map(rowToDecision)
  }

  /**
   * The active-task-safety check. Returns the most recent `dispatched`
   * decision for `(project, subject)` that has not yet been resolved
   * (no row in `intent_resolutions`). `decideAndCommit` (commit 3) consults
   * this to enforce the at-most-one-in-flight invariant.
   *
   * Returns null when project or subject is null — the active-task concept
   * is meaningless without both axes pinned.
   */
  getActiveDecisionForSubject(project: string | null, subject: string | null): IntentDecision | null {
    if (project === null || subject === null) return null
    const row = this.db
      .prepare(
        `SELECT d.event_id, d.decided_at, d.decided_by, d.agent_id, d.outcome, d.reason
         FROM intent_decisions d
         JOIN intent_events e ON e.id = d.event_id
         LEFT JOIN intent_resolutions r
           ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
         WHERE e.project = ? AND e.subject = ?
           AND d.outcome = 'dispatched'
           AND r.decision_event_id IS NULL
         ORDER BY d.decided_at DESC
         LIMIT 1`,
      )
      .get(project, subject) as DecisionRow | undefined
    return row ? rowToDecision(row) : null
  }

  // -------------------------------------------------------------------------
  // Resolutions
  // -------------------------------------------------------------------------

  /**
   * Append a resolution. Throws if a resolution already exists for the
   * decision — the ledger is append-only, so revising an outcome is a new
   * event, not an overwrite. The FK to `intent_decisions` ensures the
   * decision exists.
   */
  recordResolution(resolution: IntentResolution): void {
    this.db
      .prepare(
        `INSERT INTO intent_resolutions (decision_event_id, decision_decided_by, resolved_at, status, duration_ms, result_summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        resolution.decisionEventId,
        resolution.decisionDecidedBy,
        resolution.resolvedAt,
        resolution.status,
        resolution.durationMs,
        resolution.resultSummary,
      )
  }

  /**
   * Close every dispatched-and-unresolved decision by writing a
   * resolution with status "canceled" and the given reason. Used at
   * daemon startup to clean up dispatches whose agent execution died
   * with the previous process — without this, those decisions sit
   * in-flight forever and Inv-ActiveTaskSafety blocks legitimate
   * re-dispatches on the same slot.
   *
   * Returns the count of resolutions written. Idempotent — repeated
   * calls write 0 the second time because nothing remains in-flight.
   */
  cleanupOrphanedDispatches(reason: string = "daemon-restart", now: () => number = Date.now): number {
    const rows = this.db
      .prepare(`
        SELECT d.event_id, d.decided_by FROM intent_decisions d
        LEFT JOIN intent_resolutions r
          ON r.decision_event_id = d.event_id AND r.decision_decided_by = d.decided_by
        WHERE d.outcome = 'dispatched' AND r.decision_event_id IS NULL
      `)
      .all() as Array<{ event_id: string; decided_by: string }>
    const ts = now()
    let count = 0
    for (const row of rows) {
      try {
        this.recordResolution({
          decisionEventId: row.event_id,
          decisionDecidedBy: row.decided_by,
          resolvedAt: ts,
          status: "canceled",
          durationMs: null,
          resultSummary: reason,
        })
        count++
      } catch {
        // Skip — resolution already exists (race with normal completion).
      }
    }
    return count
  }

  /** Returns the resolution for a decision, or null if still in-flight. */
  getResolution(eventId: string, decidedBy: string): IntentResolution | null {
    const row = this.db
      .prepare(
        `SELECT decision_event_id, decision_decided_by, resolved_at, status, duration_ms, result_summary
         FROM intent_resolutions WHERE decision_event_id = ? AND decision_decided_by = ?`,
      )
      .get(eventId, decidedBy) as ResolutionRow | undefined
    return row ? rowToResolution(row) : null
  }

  // -------------------------------------------------------------------------
  // Divergences (shadow-mode soak surface)
  // -------------------------------------------------------------------------

  /**
   * Append a divergence record. Throws on duplicate `id`. The composite FK
   * to `intent_decisions` (`event_id`, `decided_by`) enforces that a
   * divergence cannot exist without its ledger-side decision — so callers
   * must record the decision before reporting the divergence.
   */
  recordDivergence(divergence: IntentDivergence): void {
    this.db
      .prepare(
        `INSERT INTO intent_divergences (
           id, ts, source, event_id, decided_by,
           ledger_agent_id, ledger_outcome, ledger_reason,
           legacy_agent_id, legacy_outcome, legacy_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        divergence.id,
        divergence.ts,
        divergence.source,
        divergence.eventId,
        divergence.decidedBy,
        divergence.ledgerAgentId,
        divergence.ledgerOutcome,
        divergence.ledgerReason,
        divergence.legacyAgentId,
        divergence.legacyOutcome,
        divergence.legacyReason,
      )
  }

  /**
   * Recent divergences, newest first. Filters compose: `source` narrows to
   * one dispatch source, `since` to a recency window, `limit` to top-N.
   * The intended consumer is the soak dashboard (commit 8) and `agentx
   * audit --divergence` queries; per-record introspection is rare so we
   * don't expose a single-id getter.
   */
  getDivergences(opts: {
    source?: IntentSource
    since?: number
    limit?: number
  } = {}): IntentDivergence[] {
    const wheres: string[] = []
    const params: Array<string | number> = []
    if (opts.source !== undefined) {
      wheres.push("source = ?")
      params.push(opts.source)
    }
    if (opts.since !== undefined) {
      wheres.push("ts >= ?")
      params.push(opts.since)
    }
    const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : ""
    const limitSql = opts.limit !== undefined ? "LIMIT ?" : ""
    if (opts.limit !== undefined) params.push(opts.limit)

    const rows = this.db
      .prepare(
        `SELECT id, ts, source, event_id, decided_by,
                ledger_agent_id, ledger_outcome, ledger_reason,
                legacy_agent_id, legacy_outcome, legacy_reason
         FROM intent_divergences
         ${whereSql}
         ORDER BY ts DESC
         ${limitSql}`,
      )
      .all(...params) as DivergenceRow[]
    return rows.map(rowToDivergence)
  }
}

// --- Row → typed-object adapters --------------------------------------------
//
// SQLite returns snake_case rows; the typed surface uses camelCase. Mapping
// once here keeps every consumer in TS-ergonomic shape and makes column
// renames a single-file refactor.

interface EventRow {
  id: string
  ts: number
  source: string
  source_event_id: string | null
  project: string | null
  subject: string | null
  intent: string | null
  raw_json: string
}

interface DecisionRow {
  event_id: string
  decided_at: number
  decided_by: string
  agent_id: string | null
  outcome: string
  reason: string | null
}

interface ResolutionRow {
  decision_event_id: string
  decision_decided_by: string
  resolved_at: number
  status: string
  duration_ms: number | null
  result_summary: string | null
}

interface DivergenceRow {
  id: string
  ts: number
  source: string
  event_id: string
  decided_by: string
  ledger_agent_id: string | null
  ledger_outcome: string
  ledger_reason: string | null
  legacy_agent_id: string | null
  legacy_outcome: string
  legacy_reason: string | null
}

function rowToEvent(row: EventRow): IntentEvent {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source as IntentSource,
    sourceEventId: row.source_event_id,
    project: row.project,
    subject: row.subject,
    intent: row.intent,
    rawJson: row.raw_json,
  }
}

function rowToDecision(row: DecisionRow): IntentDecision {
  return {
    eventId: row.event_id,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    agentId: row.agent_id,
    outcome: row.outcome as IntentDecision["outcome"],
    reason: row.reason,
  }
}

function rowToResolution(row: ResolutionRow): IntentResolution {
  return {
    decisionEventId: row.decision_event_id,
    decisionDecidedBy: row.decision_decided_by,
    resolvedAt: row.resolved_at,
    status: row.status as IntentResolution["status"],
    durationMs: row.duration_ms,
    resultSummary: row.result_summary,
  }
}

function rowToDivergence(row: DivergenceRow): IntentDivergence {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source as IntentSource,
    eventId: row.event_id,
    decidedBy: row.decided_by,
    ledgerAgentId: row.ledger_agent_id,
    ledgerOutcome: row.ledger_outcome as IntentDivergence["ledgerOutcome"],
    ledgerReason: row.ledger_reason,
    legacyAgentId: row.legacy_agent_id,
    legacyOutcome: row.legacy_outcome as IntentDivergence["legacyOutcome"],
    legacyReason: row.legacy_reason,
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
  if (current < 2) migrationV2(db)
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

function migrationV2(db: Database.Database): void {
  // Phase 1 commit 5 — divergence reporter surface. Each row records one
  // observed mismatch between the ledger's decision and the legacy path's
  // outcome during shadow-mode operation. The composite FK to
  // intent_decisions ensures a divergence cannot exist without its
  // ledger-side decision row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_divergences (
      id                TEXT NOT NULL PRIMARY KEY,
      ts                INTEGER NOT NULL,
      source            TEXT NOT NULL,
      event_id          TEXT NOT NULL,
      decided_by        TEXT NOT NULL,
      ledger_agent_id   TEXT,
      ledger_outcome    TEXT NOT NULL,
      ledger_reason     TEXT,
      legacy_agent_id   TEXT,
      legacy_outcome    TEXT NOT NULL,
      legacy_reason     TEXT,
      FOREIGN KEY (event_id, decided_by)
        REFERENCES intent_decisions(event_id, decided_by)
    );

    -- "show me recent divergences from gitlab" — the soak's primary query
    CREATE INDEX IF NOT EXISTS idx_intent_divergences_source_ts
      ON intent_divergences (source, ts);
    -- "are any deciders consistently wrong" — per-decider analysis
    CREATE INDEX IF NOT EXISTS idx_intent_divergences_decided_by
      ON intent_divergences (decided_by, ts);
  `)
  db.prepare("INSERT INTO schema_version (v) VALUES (2)").run()
}

// existsSync is imported for symmetry with src/storage/sqlite.ts; the
// ledger constructor doesn't currently branch on file presence (the
// migration is idempotent regardless), but keeping the import documents
// the intent should later code need to distinguish first-open from re-open.
void existsSync
