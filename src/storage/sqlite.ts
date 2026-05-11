import type Database from "better-sqlite3"
import { createRequire } from "module"
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

type DatabaseConstructor = typeof Database

const require = createRequire(import.meta.url)
let _db: Database.Database | undefined
let _Database: DatabaseConstructor | undefined

function betterSqlite3Fix(error: any): string {
  const msg = String(error?.message ?? error)
  const abi = process.versions.modules
  const node = process.version
  const hint = `Run "pnpm rebuild better-sqlite3" with the same Node used by the daemon (${node}, modules ${abi}).`
  if (/NODE_MODULE_VERSION|was compiled against|Module version mismatch|invalid ELF|mach-o/i.test(msg)) {
    return `${msg} ${hint}`
  }
  return `${msg} ${hint}`
}

function loadDatabaseCtor(): DatabaseConstructor | null {
  if (_Database) return _Database
  try {
    _Database = require("better-sqlite3") as DatabaseConstructor
    return _Database
  } catch (e: any) {
    console.error(`[storage/sqlite] better-sqlite3 native binding failed to load: ${betterSqlite3Fix(e)}`)
    return null
  }
}

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
  const Database = loadDatabaseCtor()
  if (!Database) return null
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
    // Native binding missing, file unwritable, etc. Surface always — the
    // alternative was a silent no-op, which makes the "SQLite not opened"
    // message in the daemon log impossible to debug.
    console.error(`[storage/sqlite] openDb failed at ${path}: ${betterSqlite3Fix(e)}`)
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
    {
      // Move A — tier-2 token buckets on usage_daily. The per-request tier
      // split is decided at record time by TokenTracker (it's a function of
      // the live cumulative input, not the row totals), so we cannot
      // reconstruct it on read. Adding columns is additive and idempotent;
      // existing rows default to 0.
      v: 5,
      sql: `
        ALTER TABLE usage_daily ADD COLUMN tier2_input_tokens        INTEGER DEFAULT 0;
        ALTER TABLE usage_daily ADD COLUMN tier2_output_tokens       INTEGER DEFAULT 0;
        ALTER TABLE usage_daily ADD COLUMN tier2_cache_read_tokens   INTEGER DEFAULT 0;
        ALTER TABLE usage_daily ADD COLUMN tier2_cache_create_tokens INTEGER DEFAULT 0;
      `,
    },
    {
      // task_traces — per-execution observability surface (improvement plan
      // #2). One row per executeTask invocation, keyed by a ULID task_id so
      // it's URL-safe + monotonically sortable. Workflow context columns let
      // pattern queries group runs by workflow ("agent-managed workflow as
      // the program" framing); intent_event_id cross-links into the rescue
      // plan's intent ledger so a dispatch decision joins to the execution
      // it produced. Tokens snapshot the final usage at finish time.
      v: 6,
      sql: `
        CREATE TABLE task_traces (
          task_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          channel TEXT,
          chat_id TEXT,
          workflow_run_id TEXT,
          workflow_id TEXT,
          workflow_node_id TEXT,
          intent_event_id TEXT,
          intent_decided_by TEXT,
          resume_session_id TEXT,
          final_session_id TEXT,
          model TEXT,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          duration_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_create_tokens INTEGER,
          error TEXT,
          message_preview TEXT
        );
        CREATE INDEX idx_traces_agent_started   ON task_traces(agent_id, started_at);
        CREATE INDEX idx_traces_workflow_run    ON task_traces(workflow_run_id);
        CREATE INDEX idx_traces_intent_event    ON task_traces(intent_event_id);
        CREATE INDEX idx_traces_status_started  ON task_traces(status, started_at);
      `,
    },
    {
      // task_trace_steps — append-only step ledger inside one task. Sequence
      // numbers are 0-based and unique per task_id; ON DELETE CASCADE so
      // pruning task_traces removes children atomically. The (input|output)_
      // summary columns are TEXT — callers cap byte-size at the call site,
      // not in the schema, because the right cap depends on the step kind
      // (a tool_use's args vs a tool_result's stdout have very different
      // typical sizes).
      v: 7,
      sql: `
        CREATE TABLE task_trace_steps (
          task_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          name TEXT NOT NULL,
          action TEXT,
          status TEXT,
          input_summary TEXT,
          output_summary TEXT,
          error TEXT,
          ms INTEGER,
          started_at INTEGER NOT NULL,
          PRIMARY KEY (task_id, seq),
          FOREIGN KEY (task_id) REFERENCES task_traces(task_id) ON DELETE CASCADE
        );
        CREATE INDEX idx_trace_steps_name ON task_trace_steps(name, started_at);
      `,
    },
    {
      // task replay support (handoff item #11). Capture the full original
      // user message AND the agent's final response so 'agentx trace replay
      // <taskId> --diff' can show side-by-side without reconstructing from
      // the step ledger. message_preview stays for cheap listing UX (200
      // chars); original_message holds the untruncated input. final_response
      // mirrors the agent's reply text. Both NULLABLE — old rows have NULL
      // and the replay command falls back to the preview gracefully.
      v: 8,
      sql: `
        ALTER TABLE task_traces ADD COLUMN original_message TEXT;
        ALTER TABLE task_traces ADD COLUMN final_response   TEXT;
      `,
    },
    {
      // task_queue — persistent chat-initiated work queue (Phase 2).
      // Each row represents a task an agent queued during a /chat turn.
      // status: 'active' = currently running; 'queued' = waiting;
      //         'done' = completed; 'error' = failed.
      // position is 1-based rank among queued rows (null when active/done/error).
      v: 9,
      sql: `
        CREATE TABLE task_queue (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          position INTEGER,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        CREATE INDEX idx_task_queue_status    ON task_queue(status, created_at);
        CREATE INDEX idx_task_queue_convo     ON task_queue(conversation_id, created_at);
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

// --- task_queue helpers (Phase 2 chat-initiated work queue) ---

export interface TaskQueueEntry {
  id: string
  conversationId: string
  agentId: string
  summary: string
  status: "active" | "queued" | "done" | "error"
  position: number | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface InsertTaskQueueResult {
  id: string
  status: "active" | "queued"
  position: number | null
}

/**
 * Insert a new task into the queue. Respects maxConcurrent — if the number
 * of 'active' rows is below the limit the new task is inserted as 'active';
 * otherwise it is 'queued' with a 1-based position.
 */
export function insertTaskQueue(
  db: Database.Database,
  entry: { id: string; conversationId: string; agentId: string; summary: string },
  maxConcurrent: number,
): InsertTaskQueueResult {
  const now = Date.now()
  const activeCount = (db
    .prepare("SELECT COUNT(*) AS n FROM task_queue WHERE status = 'active'")
    .get() as { n: number }).n

  const isActive = activeCount < maxConcurrent
  let position: number | null = null
  if (!isActive) {
    const queuedCount = (db
      .prepare("SELECT COUNT(*) AS n FROM task_queue WHERE status = 'queued'")
      .get() as { n: number }).n
    position = queuedCount + 1
  }

  db.prepare(`
    INSERT INTO task_queue (id, conversation_id, agent_id, summary, status, position, created_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.conversationId,
    entry.agentId,
    entry.summary,
    isActive ? "active" : "queued",
    position,
    now,
    isActive ? now : null,
  )

  return { id: entry.id, status: isActive ? "active" : "queued", position }
}

/**
 * Mark a task done/error and promote the next queued task (if any) to active.
 */
export function completeTaskQueue(
  db: Database.Database,
  id: string,
  status: "done" | "error" = "done",
): void {
  const now = Date.now()
  db.prepare(`
    UPDATE task_queue SET status = ?, finished_at = ?, position = NULL WHERE id = ?
  `).run(status, now, id)

  // Promote oldest queued task to active
  const next = db.prepare(`
    SELECT id FROM task_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
  `).get() as { id: string } | undefined
  if (next) {
    db.prepare(`
      UPDATE task_queue SET status = 'active', position = NULL, started_at = ? WHERE id = ?
    `).run(now, next.id)
    // Resequence remaining queued positions
    const remaining = db.prepare(`
      SELECT id FROM task_queue WHERE status = 'queued' ORDER BY created_at ASC
    `).all() as Array<{ id: string }>
    const upd = db.prepare("UPDATE task_queue SET position = ? WHERE id = ?")
    for (let i = 0; i < remaining.length; i++) {
      upd.run(i + 1, remaining[i].id)
    }
  }
}

/** Look up a single task_queue row. */
export function getTaskQueue(
  db: Database.Database,
  id: string,
): TaskQueueEntry | null {
  const row = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    agentId: row.agent_id as string,
    summary: row.summary as string,
    status: row.status as TaskQueueEntry["status"],
    position: row.position as number | null,
    createdAt: row.created_at as number,
    startedAt: row.started_at as number | null,
    finishedAt: row.finished_at as number | null,
  }
}

/** List task_queue rows for a conversation, newest first. */
export function listTaskQueueByConversation(
  db: Database.Database,
  conversationId: string,
  limit = 20,
): TaskQueueEntry[] {
  const rows = db.prepare(`
    SELECT * FROM task_queue WHERE conversation_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(conversationId, limit) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.id as string,
    conversationId: row.conversation_id as string,
    agentId: row.agent_id as string,
    summary: row.summary as string,
    status: row.status as TaskQueueEntry["status"],
    position: row.position as number | null,
    createdAt: row.created_at as number,
    startedAt: row.started_at as number | null,
    finishedAt: row.finished_at as number | null,
  }))
}

export interface PruneResult {
  taskHistory: number
  rotations: number
  routeTraces: number
  taskTraces: number
}

/**
 * Drop rows older than `retentionDays` from the operational tables that grow
 * unbounded over time. `usage_daily` is bounded by (agent, model, day) and
 * doesn't need pruning; the caller decides whether to keep aggregates beyond
 * the retention window.
 *
 * Mirrors the file-based `pruneTaskHistory` sweep that runs at daemon
 * startup. Cheap — three indexed deletes plus an incremental_vacuum.
 */
export function pruneSqliteTables(
  db: Database.Database,
  retentionDays: number,
): PruneResult {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()

  const taskHistory = (db
    .prepare(`DELETE FROM task_history WHERE started_at < ?`)
    .run(cutoffIso).changes ?? 0) as number
  const rotations = (db
    .prepare(`DELETE FROM rotations WHERE rotated_at < ?`)
    .run(cutoffIso).changes ?? 0) as number
  const routeTraces = (db
    .prepare(`DELETE FROM route_traces WHERE at < ?`)
    .run(cutoffIso).changes ?? 0) as number
  // task_traces uses ms-epoch INTEGERs (not ISO strings) on started_at.
  // task_trace_steps cascades automatically via ON DELETE CASCADE.
  const taskTraces = (db
    .prepare(`DELETE FROM task_traces WHERE started_at < ?`)
    .run(cutoffMs).changes ?? 0) as number

  // Reclaim the freelist pages so the file shrinks. WAL writes still
  // checkpoint independently.
  if (taskHistory + rotations + routeTraces + taskTraces > 0) {
    try { db.pragma("incremental_vacuum") } catch { /* best-effort */ }
  }

  return { taskHistory, rotations, routeTraces, taskTraces }
}
