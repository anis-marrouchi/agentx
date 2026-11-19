// --- The hand-off journal in the jobs database (#1861) ---
//
// Every delegation this node handed out is one row of `handoffs`: where it
// went, and the way its answer goes home. It replaces the reads of
// `.agentx/a2a/delegations.jsonl`. The DelegationManager keeps its maps in
// memory as the working state and writes each change here; at start it
// reads back what was still out and what callback was held.
//
// The table is made by name on every start, like the job columns, not by a
// migration number. It has no foreign key to the job row (`job-<id>` in
// `requests`): that row exists only while jobs are on and is pruned with
// them, and a hand-off's way home must outlive both.
//
// For one release the old file is still written beside the table, so a
// daemon rolled back to a version before this one reads a file that agrees
// with it. At every start the file is imported by id (importFile): what an
// older daemon wrote there in between is merged, and running it twice
// changes nothing.
//
// Every call is one small synchronous statement. The caller logs and
// ignores a failed write, as it did for the file.

import type Database from "better-sqlite3"
import { existsSync, readFileSync } from "fs"
import type { DelegationRecord, DelegationResult, DelegationStatus } from "./delegation"

/** A callback held for one re-run, as read back at start. */
export interface StoredRelay {
  record: DelegationRecord
  result: DelegationResult
  /** 1: re-run once at this start. 2: its re-run began and was stopped
   *  too: the short notice instead. */
  attempt: number
  /** It passed on a message the callee wrote (relayReply), not its end. */
  reply?: boolean
  /** The end of a run that already wrote to the caller. */
  wrote?: boolean
  /** The answer was back but its callback turn never started (#1861):
   *  re-run once like a held callback. */
  pending?: boolean
}

/** An answer whose callback turn has not started yet. */
export interface PendingCallback {
  result: DelegationResult
  wrote?: boolean
}

/** `relay_attempt` of an answer whose callback turn has not started. The
 *  file never sees it: an older daemon reads such a hand-off as done, as
 *  it always did. 1 and 2 are a held callback's attempts, as in the file. */
const PENDING_ATTEMPT = 0

export function ensureHandoffTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id            TEXT PRIMARY KEY,
      caller        TEXT,
      callee        TEXT,
      peer          TEXT,
      kind          TEXT,
      depth         INTEGER,
      home          TEXT,
      task_type     TEXT,
      request       TEXT,
      origin_json   TEXT,
      root_json     TEXT,
      started_at    INTEGER,
      status        TEXT,
      ended_at      INTEGER,
      relay_json    TEXT,
      relay_attempt INTEGER,
      relay_at      INTEGER,
      source        TEXT NOT NULL DEFAULT 'db',
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_open    ON handoffs(started_at) WHERE status IS NULL;
    CREATE INDEX IF NOT EXISTS idx_handoffs_relay   ON handoffs(relay_at)   WHERE relay_attempt IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_handoffs_ended   ON handoffs(ended_at)   WHERE ended_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_handoffs_started ON handoffs(started_at);
  `)
}

/** The hand-off store for this node's database, or null with a loud
 *  warning: without the database, hand-offs live in memory only, and a
 *  restart forgets every one still out and every held answer. */
export function handoffStoreFor(db: Database.Database | null, log: (msg: string) => void): HandoffStore | null {
  const warn = (why: string) => log(
    `[delegation] WARNING: ${why}: hand-offs are kept in memory only. A restart forgets every hand-off still out and every answer on its way back: nobody is told they were lost.`,
  )
  if (!db) {
    warn("no database (SQLite did not open)")
    return null
  }
  try {
    return new HandoffStore(db, log)
  } catch (e: any) {
    warn(`no database (the handoffs table could not be made: ${e?.message ?? e})`)
    return null
  }
}

interface Row {
  id: string
  caller: string | null
  callee: string | null
  peer: string | null
  kind: string | null
  depth: number | null
  home: string | null
  task_type: string | null
  request: string | null
  origin_json: string | null
  root_json: string | null
  started_at: number | null
  status: string | null
  ended_at: number | null
  relay_json: string | null
  relay_attempt: number | null
  relay_at: number | null
}

type FileLine = Record<string, any>

export class HandoffStore {
  private statements = new Map<string, Database.Statement>()

  constructor(private db: Database.Database, private log: (msg: string) => void = () => {}) {
    ensureHandoffTable(db)
  }

  /** Each statement prepared once: the import at start runs a few per line. */
  private sql(text: string): Database.Statement {
    let s = this.statements.get(text)
    if (!s) {
      s = this.db.prepare(text)
      this.statements.set(text, s)
    }
    return s
  }

  /** A hand-off goes out. A row already there (imported) is kept. */
  insert(rec: DelegationRecord, at: number, source: "db" | "file" = "db"): void {
    this.sql(`
      INSERT OR IGNORE INTO handoffs (id, caller, callee, peer, kind, depth, home, task_type, request, origin_json, root_json, started_at, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.id, rec.caller, rec.callee, rec.peer ?? null, rec.kind ?? null, rec.depth ?? null, rec.home ?? null,
      rec.taskType ?? null, rec.request, JSON.stringify(rec.origin), JSON.stringify(rec.root ?? null), rec.startedAt, source, at,
    )
  }

  /**
   * End a hand-off: the first outcome wins. "taken": another process (or
   * an earlier start) ended it already, so nobody else calls back.
   * "missing": no row (its insert failed), so the caller goes on as if the
   * table were not there. `pending` marks the answer for one re-run should
   * the daemon stop before its callback turn starts; in the same statement,
   * so a crash cannot fall between the two.
   */
  end(id: string, status: DelegationStatus, at: number, pending?: PendingCallback): "ended" | "taken" | "missing" {
    const json = pending ? JSON.stringify({ result: pending.result, ...(pending.wrote ? { wrote: true } : {}) }) : null
    const changed = this.sql(`
      UPDATE handoffs SET status = ?, ended_at = ?, updated_at = ?,
        relay_json    = CASE WHEN ? IS NOT NULL AND relay_attempt IS NULL THEN ? ELSE relay_json END,
        relay_at      = CASE WHEN ? IS NOT NULL AND relay_attempt IS NULL THEN ? ELSE relay_at END,
        relay_attempt = CASE WHEN ? IS NOT NULL AND relay_attempt IS NULL THEN ${PENDING_ATTEMPT} ELSE relay_attempt END
      WHERE id = ? AND status IS NULL
    `).run(status, at, at, json, json, json, at, json, id).changes
    if (changed) return "ended"
    return this.sql("SELECT 1 FROM handoffs WHERE id = ?").get(id) ? "taken" : "missing"
  }

  /** How a hand-off ended; null while it is out or when there is no row. */
  statusOf(id: string): DelegationStatus | null {
    const row = this.sql("SELECT status FROM handoffs WHERE id = ?").get(id) as { status: string | null } | undefined
    return (row?.status as DelegationStatus | null) ?? null
  }

  /** A row with its record: inserted, or filled in when it is a done-only
   *  row imported from a compacted file. */
  private withRecord(rec: DelegationRecord, at: number, source: "db" | "file"): void {
    this.insert(rec, at, source)
    this.sql(`
      UPDATE handoffs SET caller = ?, callee = ?, peer = ?, kind = ?, depth = ?, home = ?, task_type = ?, request = ?, origin_json = ?, root_json = ?, started_at = ?
      WHERE id = ? AND caller IS NULL
    `).run(
      rec.caller, rec.callee, rec.peer ?? null, rec.kind ?? null, rec.depth ?? null, rec.home ?? null, rec.taskType ?? null,
      rec.request, JSON.stringify(rec.origin), JSON.stringify(rec.root ?? null), rec.startedAt, rec.id,
    )
  }

  /** Hold a callback a restart stopped (attempt 1), or its re-run (2). */
  hold(rec: DelegationRecord, held: { result: DelegationResult; reply?: boolean }, attempt: number, at: number): void {
    this.withRecord(rec, at, "db")
    this.sql("UPDATE handoffs SET relay_json = ?, relay_attempt = ?, relay_at = ?, updated_at = ?, status = COALESCE(status, ?), ended_at = COALESCE(ended_at, ?) WHERE id = ?")
      .run(JSON.stringify({ result: held.result, ...(held.reply ? { reply: true } : {}) }), attempt, at, at, held.result.status, at, rec.id)
  }

  /** Write the one re-run down before it starts. False when it is already
   *  written (a second process on this database took it). */
  claimRerun(id: string, at: number): boolean {
    return this.sql("UPDATE handoffs SET relay_attempt = 2, relay_at = ?, updated_at = ? WHERE id = ? AND relay_attempt < 2")
      .run(at, at, id).changes > 0
  }

  /** The held callback was passed on (or its notice sent). */
  release(id: string, at: number): void {
    this.sql("UPDATE handoffs SET relay_json = NULL, relay_attempt = NULL, relay_at = ?, updated_at = ? WHERE id = ? AND relay_attempt IS NOT NULL")
      .run(at, at, id)
  }

  /** The callback turn for these answers started: no re-run needed. */
  clearPending(ids: string[], at: number): void {
    const stmt = this.sql(`UPDATE handoffs SET relay_json = NULL, relay_attempt = NULL, relay_at = ?, updated_at = ? WHERE id = ? AND relay_attempt = ${PENDING_ATTEMPT}`)
    this.db.transaction(() => { for (const id of ids) stmt.run(at, at, id) })()
  }

  /** Hand-offs still out, oldest first. */
  open(): DelegationRecord[] {
    const rows = this.sql("SELECT * FROM handoffs WHERE status IS NULL ORDER BY started_at, rowid").all() as Row[]
    return rows.map((r) => this.recordOf(r)).filter((r): r is DelegationRecord => r !== null)
  }

  /** Callbacks held for a re-run, and answers whose callback never started. */
  held(): StoredRelay[] {
    const rows = this.sql("SELECT * FROM handoffs WHERE relay_attempt IS NOT NULL ORDER BY relay_at, rowid").all() as Row[]
    const out: StoredRelay[] = []
    for (const r of rows) {
      const record = this.recordOf(r)
      if (!record) continue
      let relay: { result?: DelegationResult; reply?: boolean; wrote?: boolean }
      try { relay = JSON.parse(r.relay_json ?? "") } catch { relay = {} }
      if (!relay?.result || typeof relay.result.text !== "string") {
        this.log(`[delegation ${r.id}] held answer unreadable in the handoffs table; skipped`)
        continue
      }
      const pending = r.relay_attempt === PENDING_ATTEMPT
      out.push({
        record, result: relay.result, attempt: pending ? 1 : Number(r.relay_attempt) || 1,
        ...(relay.reply ? { reply: true } : {}), ...(relay.wrote ? { wrote: true } : {}), ...(pending ? { pending: true } : {}),
      })
    }
    return out
  }

  /** The last `limit` finished ids and how they ended, oldest first. Only
   *  the old file's compaction still wants them. */
  recentDone(limit: number): Array<[string, DelegationStatus]> {
    const rows = this.sql("SELECT id, status FROM handoffs WHERE status IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT ?").all(limit) as Array<{ id: string; status: DelegationStatus }>
    return rows.reverse().map((r) => [r.id, r.status])
  }

  /** Who each hand-off went to: id → callee, `callee@peer` for a peer's. */
  agents(): Map<string, string> {
    const rows = this.sql("SELECT id, callee, peer FROM handoffs WHERE callee IS NOT NULL").all() as Array<{ id: string; callee: string; peer: string | null }>
    return new Map(rows.map((r) => [r.id, r.peer ? `${r.callee}@${r.peer}` : r.callee]))
  }

  /** Delete hand-offs that ended before `before`. One with a held or
   *  pending callback is kept: its re-run ends it. */
  prune(before: number): number {
    return this.sql("DELETE FROM handoffs WHERE ended_at < ? AND relay_attempt IS NULL").run(before).changes
  }

  /**
   * Merge the old delegation log into the table, by id, in one
   * transaction. Idempotent:
   *   start    a row when there is none (never overwrites one)
   *   done     ends a row still out; a done-only row for an id with none
   *   relay    held, when the line is newer than the row's last relay word
   *   relayed  passed on, when the line is at least as new
   * Bad lines are skipped, as the old reader skipped them.
   */
  importFile(path: string): { lines: number; skipped: number } {
    if (!existsSync(path)) return { lines: 0, skipped: 0 }
    let lines = 0
    let skipped = 0
    const text = readFileSync(path, "utf-8")
    const relayAtOf = this.sql("SELECT relay_at, relay_attempt FROM handoffs WHERE id = ?")
    this.db.transaction(() => {
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue
        let line: FileLine
        try { line = JSON.parse(raw) } catch { skipped++; continue }
        if (!line || typeof line.id !== "string") { skipped++; continue }
        const ts = Number(line.ts) || 0
        lines++
        if (line.type === "start") {
          const { type: _t, ts: _ts, ...rec } = line
          if (typeof rec.caller !== "string" || typeof rec.callee !== "string" || !rec.origin) { skipped++; continue }
          this.insert(rec as DelegationRecord, ts, "file")
        } else if (line.type === "done") {
          const status = typeof line.status === "string" ? line.status : "done"
          const ended = this.sql("UPDATE handoffs SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status IS NULL").run(status, ts, ts, line.id).changes
          if (!ended) {
            this.sql("INSERT OR IGNORE INTO handoffs (id, status, ended_at, source, updated_at) VALUES (?, ?, ?, 'file', ?)").run(line.id, status, ts, ts)
          }
        } else if (line.type === "relay" && line.record && line.result) {
          const row = relayAtOf.get(line.id) as { relay_at: number | null } | undefined
          if (row && row.relay_at !== null && ts <= row.relay_at) continue
          if (typeof line.record.caller === "string" && line.record.origin) this.withRecord(line.record as DelegationRecord, ts, "file")
          else if (!row) { skipped++; continue }
          this.sql("UPDATE handoffs SET relay_json = ?, relay_attempt = ?, relay_at = ?, updated_at = ?, status = COALESCE(status, ?), ended_at = COALESCE(ended_at, ?) WHERE id = ?")
            .run(JSON.stringify({ result: line.result, ...(line.reply === true ? { reply: true } : {}) }), Number(line.attempt) || 1, ts, ts, line.result.status ?? "done", ts, line.id)
        } else if (line.type === "relayed") {
          // Never clears an answer pending in the table: the file does not
          // know about those.
          this.sql("UPDATE handoffs SET relay_json = NULL, relay_attempt = NULL, relay_at = ?, updated_at = ? WHERE id = ? AND relay_attempt >= 1 AND relay_at <= ?")
            .run(ts, ts, line.id, ts)
        } else {
          lines--
          skipped++
        }
      }
    })()
    return { lines, skipped }
  }

  private recordOf(r: Row): DelegationRecord | null {
    if (!r.caller || !r.callee) return null
    let origin: DelegationRecord["origin"]
    let root: DelegationRecord["root"]
    try {
      origin = JSON.parse(r.origin_json ?? "")
      root = JSON.parse(r.root_json ?? "null")
      if (!origin || typeof origin.channel !== "string" || typeof origin.chatId !== "string") throw new Error("no channel or chat")
    } catch (e: any) {
      this.log(`[delegation ${r.id}] way home unreadable in the handoffs table (${e?.message ?? e}); skipped`)
      return null
    }
    return {
      id: r.id,
      caller: r.caller,
      callee: r.callee,
      ...(r.peer ? { peer: r.peer } : {}),
      request: r.request ?? "",
      origin,
      root,
      startedAt: r.started_at ?? 0,
      ...(r.task_type ? { taskType: r.task_type } : {}),
      ...(r.kind === "send" ? { kind: "send" as const } : {}),
      ...(r.depth ? { depth: r.depth } : {}),
      ...(r.home ? { home: r.home } : {}),
    }
  }
}
