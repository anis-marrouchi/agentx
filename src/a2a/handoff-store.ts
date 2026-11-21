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
// The old file is no longer written (#1961). A node that still has one (it
// ran a release that wrote it, or an older daemon wrote it after a
// rollback) imports it by id once at start (importDelegationLog): what is
// in it is merged, running the import twice changes nothing, and the file
// is then renamed to `delegations.jsonl.imported` and never read again.
//
// Every call is one small synchronous statement. The caller logs and
// ignores a failed write, as it did for the file.

import type Database from "better-sqlite3"
import { existsSync, readFileSync, renameSync, unlinkSync } from "fs"
import type { DelegationRecord, DelegationResult, DelegationStatus } from "./delegation"
import { ensureColumns } from "@/storage/sqlite"

/** The suffix a delegation log gets once it is imported (#1961). */
export const IMPORTED_SUFFIX = ".imported"

/**
 * At start, before the DelegationManager reads the table: merge a leftover
 * old delegation log into it, then rename the file to `<path>.imported`
 * so it is never read again. No file: nothing to do. A failed import
 * leaves the file in place for the next start. When the rename fails the
 * file is removed instead; when that fails too, a warning is logged and the
 * start goes on (the next start merges it again, which is harmless until
 * its rows are pruned).
 */
export function importDelegationLog(store: HandoffStore, path: string, log: (msg: string) => void): void {
  if (!existsSync(path)) return
  try {
    const r = store.importFile(path)
    log(`[delegation] ${r.lines} line(s) of ${path} merged into the handoffs table${r.skipped ? `, ${r.skipped} unreadable skipped` : ""}`)
  } catch (e: any) {
    log(`[delegation] could not import ${path} into the handoffs table: ${e?.message ?? e}; tried again at the next start`)
    return
  }
  try {
    renameSync(path, path + IMPORTED_SUFFIX)
    log(`[delegation] ${path} renamed to ${path + IMPORTED_SUFFIX}; it is not read again`)
    return
  } catch (e: any) {
    log(`[delegation] could not rename ${path} after its import: ${e?.message ?? e}; removing it instead`)
  }
  // A file imported at every start would, once its rows are pruned after
  // requests.retentionDays, bring them back as open hand-offs and send late
  // "lost" notices. Its lines are in the table now: remove it.
  try {
    unlinkSync(path)
    log(`[delegation] ${path} removed after its import; it is not read again`)
  } catch (e: any) {
    log(`[delegation] WARNING: ${path} was imported but could not be renamed or removed (${e?.message ?? e}); it will be re-imported each start — fix permissions`)
  }
}

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

/** The most of a callee's answer a row keeps (#2007): the clip the
 *  pending callback already uses (RESULT_CLIP in delegation.ts). */
export const RESULT_TEXT_CAP = 12_000

/**
 * Columns added for #2007 (piece 1). `join_key` is written by start()
 * (piece 3); `way_home` is 'deliver' for an async /mesh/task (piece 4b).
 *   join_key      what makes two sends the same work; unique while open
 *   way_home      how the answer goes home; NULL is a callback, as every
 *                 older row is; 'deliver' sends the raw answer to the chat
 *                 the request named (/mesh/task async:true)
 *   result_text   the callee's answer, or the timeout or error text, as the
 *                 hand-off ended, capped at RESULT_TEXT_CAP. For a local run
 *                 it repeats task_traces.final_response; it is the only copy
 *                 of a peer's answer, and it holds the outcome of a run that
 *                 never answered. It lives as long as the row (pruned with
 *                 requests.retentionDays).
 *   waiting_json  for a "waiting" end: { kind, on, dueAt? }. `kind` is
 *                 "waiting" (waits on something) or "continue" (the callee
 *                 carries on through a job wake): a later piece frees the
 *                 key of the first and not of the second.
 */
export const HANDOFF_JOURNAL_COLUMNS: Array<[string, string]> = [
  ["join_key", "TEXT"],
  ["way_home", "TEXT"],
  ["result_text", "TEXT"],
  ["waiting_json", "TEXT"],
]

/** A hand-off as GET /a2a/delegations lists it: ids, agents and status,
 *  never the request or the answer. */
export interface HandoffSummary {
  id: string
  caller: string
  callee: string
  peer?: string
  status: DelegationStatus | "running"
  startedAt: string
  endedAt?: string
}

/** What a callee said it waits for, as a row keeps it. */
export interface StoredWaiting {
  kind: "waiting" | "continue"
  on: string
  dueAt?: string
}

/** A hand-off read by its id: the summary plus the answer. */
export interface HandoffView extends HandoffSummary {
  text?: string
  waiting?: StoredWaiting
  /** Set when the answer does not come back as a callback: "deliver". */
  wayHome?: "deliver"
}

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
  ensureColumns(db, "handoffs", HANDOFF_JOURNAL_COLUMNS)
  // One open row per key. Rows with no key (every row before piece 3, the
  // #1962 import's stubs) never clash: NULLs are distinct in SQLite. An
  // insert that clashes is ignored by INSERT OR IGNORE, like an id clash.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_join ON handoffs(join_key) WHERE status IS NULL")
  // The newest row for a key, open or ended (#2007 piece 3, Q6): a
  // "continue" row keeps its key for a while after it ended.
  db.exec("CREATE INDEX IF NOT EXISTS idx_handoffs_join_newest ON handoffs(join_key, started_at) WHERE join_key IS NOT NULL")
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
  result_text?: string | null
  waiting_json?: string | null
  way_home?: string | null
}

const iso = (ms: number) => new Date(ms).toISOString()

function waitingJson(result: DelegationResult | undefined): string | null {
  if (!result || result.status !== "waiting" || !result.waiting) return null
  return JSON.stringify({
    kind: result.state?.state === "continue" ? "continue" : "waiting",
    on: result.waiting.on,
    ...(result.waiting.dueAt ? { dueAt: result.waiting.dueAt } : {}),
  })
}

function summaryOf(r: Row): HandoffSummary {
  return {
    id: r.id,
    caller: r.caller ?? "",
    callee: r.callee ?? "",
    ...(r.peer ? { peer: r.peer } : {}),
    status: (r.status as DelegationStatus | null) ?? "running",
    startedAt: iso(r.started_at ?? 0),
    ...(r.ended_at ? { endedAt: iso(r.ended_at) } : {}),
  }
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

  /** A hand-off goes out. A row already there (imported) is kept, and so
   *  is an open row with the same join key (#2007 piece 3): false when
   *  nothing was inserted. */
  insert(rec: DelegationRecord, at: number, source: "db" | "file" = "db"): boolean {
    return this.sql(`
      INSERT OR IGNORE INTO handoffs (id, caller, callee, peer, kind, depth, home, task_type, request, origin_json, root_json, started_at, source, updated_at, join_key, way_home)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.id, rec.caller, rec.callee, rec.peer ?? null, rec.kind ?? null, rec.depth ?? null, rec.home ?? null,
      rec.taskType ?? null, rec.request, JSON.stringify(rec.origin), JSON.stringify(rec.root ?? null), rec.startedAt, source, at,
      rec.joinKey ?? null, rec.wayHome ?? null,
    ).changes > 0
  }

  /** The open hand-off with this join key, or null. */
  openByJoin(key: string): string | null {
    const row = this.sql("SELECT id FROM handoffs WHERE join_key = ? AND status IS NULL").get(key) as { id: string } | undefined
    return row?.id ?? null
  }

  /** The newest hand-off with this join key, open or ended. */
  newestByJoin(key: string): { id: string; status: DelegationStatus | null; endedAt: number | null; waiting: { kind: string; dueAt?: number } | null } | null {
    const r = this.sql(`
      SELECT id, status, ended_at, waiting_json FROM handoffs WHERE join_key = ?
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(key) as Pick<Row, "id" | "status" | "ended_at" | "waiting_json"> | undefined
    if (!r) return null
    let waiting: { kind: string; dueAt?: number } | null = null
    if (r.waiting_json) {
      try {
        const w = JSON.parse(r.waiting_json)
        waiting = { kind: String(w.kind ?? "waiting"), ...(Number(w.dueAt) > 0 ? { dueAt: Number(w.dueAt) } : {}) }
      } catch { /* unreadable: no wait kind */ }
    }
    return { id: r.id, status: (r.status as DelegationStatus | null) ?? null, endedAt: r.ended_at ?? null, waiting }
  }

  /** Other open hand-offs with the same text, caller, callee and home,
   *  from another chat of the caller (B2): `pattern` is the LIKE form of
   *  the key with its chat part left open. */
  openSameText(pattern: string, except: string): Array<{ id: string; origin: string }> {
    const rows = this.sql(`
      SELECT id, origin_json FROM handoffs WHERE status IS NULL AND join_key LIKE ? AND join_key != ?
    `).all(pattern, except) as Array<{ id: string; origin_json: string | null }>
    return rows.map((r) => {
      let origin = "?"
      try {
        const o = JSON.parse(r.origin_json ?? "null")
        if (o?.channel) origin = `${o.channel}:${o.chatId}`
      } catch { /* unreadable: shown as ? */ }
      return { id: r.id, origin }
    })
  }

  /**
   * End a hand-off: the first outcome wins. "taken": another process (or
   * an earlier start) ended it already, so nobody else calls back.
   * "missing": no row (its insert failed), so the caller goes on as if the
   * table were not there. `pending` marks the answer for one re-run should
   * the daemon stop before its callback turn starts; in the same statement,
   * so a crash cannot fall between the two. `result` is the outcome the
   * row keeps (#2007): its text, capped, and what a waiting callee waits
   * for; in the same statement, so the first outcome's text wins.
   */
  end(id: string, status: DelegationStatus, at: number, pending?: PendingCallback, result?: DelegationResult): "ended" | "taken" | "missing" {
    const json = pending ? JSON.stringify({ result: pending.result, ...(pending.wrote ? { wrote: true } : {}) }) : null
    const text = result ? result.text.slice(0, RESULT_TEXT_CAP) : null
    const changed = this.sql(`
      UPDATE handoffs SET status = ?, ended_at = ?, updated_at = ?, result_text = ?, waiting_json = ?,
        relay_json    = CASE WHEN ? IS NOT NULL AND relay_attempt IS NULL THEN ? ELSE relay_json END,
        relay_at      = CASE WHEN ? IS NOT NULL AND relay_attempt IS NULL THEN ? ELSE relay_at END,
        relay_attempt = CASE WHEN ? IS NOT NULL AND relay_attempt IS NULL THEN ${PENDING_ATTEMPT} ELSE relay_attempt END
      WHERE id = ? AND status IS NULL
    `).run(status, at, at, text, waitingJson(result), json, json, json, at, json, id).changes
    if (changed) return "ended"
    return this.sql("SELECT 1 FROM handoffs WHERE id = ?").get(id) ? "taken" : "missing"
  }

  /** How a hand-off ended; null while it is out or when there is no row. */
  statusOf(id: string): DelegationStatus | null {
    const row = this.sql("SELECT status FROM handoffs WHERE id = ?").get(id) as { status: string | null } | undefined
    return (row?.status as DelegationStatus | null) ?? null
  }

  /** One hand-off by its id, with its answer; null when there is no row
   *  or it is an import stub (no caller, no start). Bounded: the answer is
   *  capped at RESULT_TEXT_CAP when it is written. */
  read(id: string): HandoffView | null {
    const r = this.sql("SELECT * FROM handoffs WHERE id = ?").get(id) as Row | undefined
    if (!r || !r.caller || !r.callee || r.started_at === null) return null
    let waiting: StoredWaiting | undefined
    if (r.waiting_json) {
      try {
        const w = JSON.parse(r.waiting_json)
        waiting = { kind: w.kind === "continue" ? "continue" : "waiting", on: String(w.on ?? ""), ...(Number(w.dueAt) > 0 ? { dueAt: iso(Number(w.dueAt)) } : {}) }
      } catch { /* unreadable: left out */ }
    }
    return {
      ...summaryOf(r), ...(r.result_text ? { text: r.result_text } : {}), ...(waiting ? { waiting } : {}),
      ...(r.way_home === "deliver" ? { wayHome: "deliver" as const } : {}),
    }
  }

  /** The newest hand-offs, newest first: ids, agents and status only.
   *  Import stubs (no start, no callee) are left out (review C8). */
  list(limit: number): HandoffSummary[] {
    const rows = this.sql(`
      SELECT id, caller, callee, peer, status, started_at, ended_at FROM handoffs
      WHERE started_at IS NOT NULL AND callee IS NOT NULL
      ORDER BY started_at DESC, rowid DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, Math.floor(limit) || 50))) as Row[]
    return rows.map(summaryOf)
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
  hold(rec: DelegationRecord, held: { result: DelegationResult; reply?: boolean; wrote?: boolean }, attempt: number, at: number): void {
    this.withRecord(rec, at, "db")
    this.setRelay(rec.id, held, attempt, at)
  }

  /** The relay columns of a held callback. Only the end of a run ends the
   *  hand-off with it: a held reply is a progress note from a callee that
   *  may still be working, so its hand-off stays out (review of #1962). */
  private setRelay(id: string, held: { result: DelegationResult; reply?: boolean; wrote?: boolean }, attempt: number, at: number): void {
    const json = JSON.stringify({ result: held.result, ...(held.reply ? { reply: true } : {}), ...(held.wrote ? { wrote: true } : {}) })
    if (held.reply) {
      this.sql("UPDATE handoffs SET relay_json = ?, relay_attempt = ?, relay_at = ?, updated_at = ? WHERE id = ?").run(json, attempt, at, at, id)
    } else {
      this.sql("UPDATE handoffs SET relay_json = ?, relay_attempt = ?, relay_at = ?, updated_at = ?, status = COALESCE(status, ?), ended_at = COALESCE(ended_at, ?) WHERE id = ?")
        .run(json, attempt, at, at, held.result.status ?? "done", at, id)
    }
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
   * A held reply never ends its hand-off. A held callback the file's
   * compaction dropped is released (see the end of the loop).
   * Bad lines are skipped, as the old reader skipped them.
   */
  importFile(path: string): { lines: number; skipped: number } {
    if (!existsSync(path)) return { lines: 0, skipped: 0 }
    let lines = 0
    let skipped = 0
    const text = readFileSync(path, "utf-8")
    const relayAtOf = this.sql("SELECT relay_at, relay_attempt FROM handoffs WHERE id = ?")
    /** Per id: the newest `done` and `relay` line in the file. */
    const lastDone = new Map<string, number>()
    const lastRelay = new Map<string, number>()
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
          lastDone.set(line.id, Math.max(lastDone.get(line.id) ?? 0, ts))
          const status = typeof line.status === "string" ? line.status : "done"
          const ended = this.sql("UPDATE handoffs SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status IS NULL").run(status, ts, ts, line.id).changes
          if (!ended) {
            this.sql("INSERT OR IGNORE INTO handoffs (id, status, ended_at, source, updated_at) VALUES (?, ?, ?, 'file', ?)").run(line.id, status, ts, ts)
          }
        } else if (line.type === "relay" && line.record && line.result) {
          lastRelay.set(line.id, Math.max(lastRelay.get(line.id) ?? 0, ts))
          const row = relayAtOf.get(line.id) as { relay_at: number | null } | undefined
          if (row && row.relay_at !== null && ts <= row.relay_at) continue
          if (typeof line.record.caller === "string" && line.record.origin) this.withRecord(line.record as DelegationRecord, ts, "file")
          else if (!row) { skipped++; continue }
          this.setRelay(line.id, { result: line.result, ...(line.reply === true ? { reply: true } : {}) }, Number(line.attempt) || 1, ts)
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
      // A callback held in the table that an older daemon passed on, then
      // compacted away. Its compaction keeps the starts still out, the done
      // ids (rewritten with the compaction's time) and the relays it still
      // holds, so the `relayed` line is gone and only a done line newer
      // than the hold is left. The release that wrote both the table and the
      // file (#1962) never wrote such a file: every held relay is in its
      // file at the hold's time (append) or later (its own compaction
      // rewrites held relays). Releases since write no file at all (#1961),
      // and a file is imported once, then renamed, so a file an older daemon
      // writes after a rollback starts empty and only names its own
      // hand-offs. So: a done line newer than the hold, and no relay line at
      // or after it, means the writer no longer held it. An answer pending
      // in the table is left alone: the file never knew it.
      for (const [id, doneTs] of lastDone) {
        const row = relayAtOf.get(id) as { relay_at: number | null; relay_attempt: number | null } | undefined
        if (!row || row.relay_attempt === null || row.relay_attempt < 1 || row.relay_at === null) continue
        if (doneTs <= row.relay_at || (lastRelay.get(id) ?? -1) >= row.relay_at) continue
        this.sql("UPDATE handoffs SET relay_json = NULL, relay_attempt = NULL, relay_at = ?, updated_at = ? WHERE id = ?").run(doneTs, doneTs, id)
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
      ...(r.way_home === "deliver" ? { wayHome: "deliver" as const } : {}),
    }
  }
}
