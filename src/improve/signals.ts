// --- Failure signals: stage 1 of self-improvement (#1783) ---
//
// The failures the owner notices (a request they reopen, a close that did
// not do what they asked, a hand-off refused or lost, two sessions on the
// same work) happen in separate parts of AgentX, and nothing counted them.
// Each is recorded here as one row, with no model call: kind, agent, a
// reference (request, delegation or task id), a short detail, the time.
// Later stages rank the recurring ones and hand the worst to the retro.
//
// Recording never throws and never blocks the caller: a signal that cannot
// be written is dropped. The same kind and reference within DEDUPE_MS is
// one row. Rows older than RETENTION_DAYS are deleted.

import type Database from "better-sqlite3"

export const SIGNAL_KINDS = [
  "owner_reopened",
  "owner_check_mismatch",
  "request_stalled",
  "handoff_refused",
  "delegation_failed",
  "callback_repeat_skipped",
  "same_work_waited",
] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

/** What each kind means, for the CLI and the docs. */
export const SIGNAL_MEANING: Record<SignalKind, string> = {
  owner_reopened: "the owner reopened a closed request",
  owner_check_mismatch: "a close did not do what the owner asked (owner-words check)",
  request_stalled: "a request needs attention: failed, timed out, cut off or quiet",
  handoff_refused: "a hand-off was refused (budget, cycle or permissions)",
  delegation_failed: "a hand-off ended in error, timeout or lost",
  callback_repeat_skipped: "a helper's end repeated what it had already written",
  same_work_waited: "a run waited for another run of the same agent on the same request",
}

export const DEDUPE_MS = 10 * 60_000
export const RETENTION_DAYS = 90
const DETAIL_MAX = 300
const PRUNE_EVERY_MS = 3_600_000

export interface Signal {
  kind: SignalKind
  agentId?: string | null
  ref?: string | null
  detail?: string | null
}

export interface SignalRow { id: number; at: number; kind: SignalKind; agentId: string | null; ref: string | null; detail: string | null }

const ready = new WeakSet<Database.Database>()
const prunedAt = new WeakMap<Database.Database, number>()

function ensureTable(db: Database.Database): void {
  if (ready.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS improve_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT,
    ref TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_improve_signals_kind_at ON improve_signals(kind, at);
  CREATE INDEX IF NOT EXISTS idx_improve_signals_agent_at ON improve_signals(agent_id, at);`)
  ready.add(db)
}

/** Record one signal in `db`. True when a row was written (false for a
 *  repeat inside DEDUPE_MS, or any failure). */
export function recordSignal(db: Database.Database, s: Signal, now = Date.now()): boolean {
  try {
    ensureTable(db)
    const ref = s.ref ?? null
    const agent = s.agentId ?? null
    if (ref) {
      const dup = db.prepare(
        "SELECT 1 FROM improve_signals WHERE kind = ? AND ref = ? AND agent_id IS ? AND at >= ? LIMIT 1",
      ).get(s.kind, ref, agent, now - DEDUPE_MS)
      if (dup) return false
    }
    const detail = s.detail ? s.detail.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX) : null
    db.prepare("INSERT INTO improve_signals (at, kind, agent_id, ref, detail) VALUES (?, ?, ?, ?, ?)").run(now, s.kind, agent, ref, detail)
    if (now - (prunedAt.get(db) ?? 0) > PRUNE_EVERY_MS) {
      prunedAt.set(db, now)
      db.prepare("DELETE FROM improve_signals WHERE at < ?").run(now - RETENTION_DAYS * 86_400_000)
    }
    return true
  } catch {
    return false
  }
}

// The daemon registers its database once at start; code without a handle
// on it (delegations, the work lane, the delegation gate) emits through it.
let sinkDb: Database.Database | null = null

export function setSignalDb(db: Database.Database | null): void {
  sinkDb = db
}

/** Record through the daemon's database. A no-op when none is set. */
export function emitSignal(s: Signal, now = Date.now()): boolean {
  return sinkDb ? recordSignal(sinkDb, s, now) : false
}

export interface SignalSummary {
  since: number
  total: number
  byKind: Array<{ kind: SignalKind; count: number }>
  byAgent: Array<{ agentId: string; count: number; kinds: Partial<Record<SignalKind, number>> }>
  /** The details seen most often per kind: what keeps happening. */
  top: Array<{ kind: SignalKind; agentId: string | null; detail: string; count: number }>
}

export function readSignals(db: Database.Database, since: number, limit = 500): SignalRow[] {
  ensureTable(db)
  return db.prepare(
    "SELECT id, at, kind, agent_id AS agentId, ref, detail FROM improve_signals WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?",
  ).all(since, limit) as SignalRow[]
}

export function summarizeSignals(db: Database.Database, since: number, topN = 10): SignalSummary {
  ensureTable(db)
  const byKind = db.prepare(
    "SELECT kind, COUNT(*) AS count FROM improve_signals WHERE at >= ? GROUP BY kind ORDER BY count DESC, kind",
  ).all(since) as Array<{ kind: SignalKind; count: number }>
  const rows = db.prepare(
    "SELECT COALESCE(agent_id, '-') AS agentId, kind, COUNT(*) AS count FROM improve_signals WHERE at >= ? GROUP BY agent_id, kind",
  ).all(since) as Array<{ agentId: string; kind: SignalKind; count: number }>
  const agents = new Map<string, { agentId: string; count: number; kinds: Partial<Record<SignalKind, number>> }>()
  for (const r of rows) {
    const a = agents.get(r.agentId) ?? { agentId: r.agentId, count: 0, kinds: {} }
    a.count += r.count
    a.kinds[r.kind] = r.count
    agents.set(r.agentId, a)
  }
  const top = db.prepare(
    `SELECT kind, agent_id AS agentId, detail, COUNT(*) AS count FROM improve_signals
     WHERE at >= ? AND detail IS NOT NULL GROUP BY kind, agent_id, detail HAVING COUNT(*) > 1 ORDER BY count DESC LIMIT ?`,
  ).all(since, topN) as SignalSummary["top"]
  return {
    since,
    total: byKind.reduce((n, k) => n + k.count, 0),
    byKind,
    byAgent: [...agents.values()].sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId)),
    top,
  }
}
