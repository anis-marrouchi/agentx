import type Database from "better-sqlite3"
import { hasRequestTables } from "./store"

// --- An agent's estimates against the real time (#1909) ---
//
// The correction factor: how long an agent's work really took against the
// minutes it said, read from its own closed rows. A factor of 1.5 means
// its work takes half again as long as it says; the daemon multiplies the
// next estimate by it before it places the work in the queue.
//
// The real time of a row is the time its linked runs took. A row with no
// run kept here does not count: the time from its start to its close
// holds nights, waits and the owner's replies, and would pin every agent
// at the top of the range. Fewer such rows than `minRows`: the factor is
// 1. Read only: nothing here writes.

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** A factor is not trusted outside these. */
export const FACTOR_MIN = 0.25
export const FACTOR_MAX = 8

export interface EstimateOptions {
  now: number
  /** How far back rows are read. */
  days: number
  /** Fewer rows than this: the factor is 1. */
  minRows: number
  /** At most this many of the latest rows count. */
  maxRows?: number
  /** At most this many of the latest closed rows are read (the query runs
   *  on the daemon's main loop). */
  scanRows?: number
}

export const DEFAULT_ESTIMATE_OPTIONS: Omit<EstimateOptions, "now"> = { days: 30, minRows: 3, maxRows: 20 }

export interface EstimateRow {
  id: string
  agentId: string
  work: string | null
  estimateMinutes: number
  realMinutes: number
  closedAt: number
}

export interface AgentFactor {
  agentId: string
  /** Real time over estimate, the median of its rows, within FACTOR_MIN..MAX. */
  factor: number
  /** Rows it was read from. */
  rows: number
  /** True when there were enough rows to trust it; else factor is 1. */
  measured: boolean
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** Closed rows with an estimate and run time kept, newest first, with
 *  their real time. Reads at most `scanRows` of the latest closed rows. */
export function estimateRows(db: Database.Database, opts: EstimateOptions & { agentId?: string }): EstimateRow[] {
  if (!hasRequestTables(db) || !hasTable(db, "task_traces")) return []
  const since = opts.now - opts.days * DAY
  const rows = db.prepare(
    `SELECT * FROM (
       SELECT r.id, r.agent_id, r.work, COALESCE(r.first_estimate_minutes, r.estimate_minutes) AS est, r.closed_at,
              (SELECT SUM(t.finished_at - t.started_at) FROM request_links l JOIN task_traces t ON t.task_id = l.ref
                WHERE l.request_id = r.id AND l.kind IN ('run', 'step_run') AND t.finished_at IS NOT NULL AND t.started_at IS NOT NULL
                  AND t.finished_at > t.started_at) AS run_ms
         FROM requests r
        WHERE r.state = 'done' AND r.closed_at IS NOT NULL AND r.closed_at >= ? AND COALESCE(r.first_estimate_minutes, r.estimate_minutes) > 0
          ${opts.agentId ? "AND r.agent_id = ?" : ""}
        ORDER BY r.closed_at DESC LIMIT ?
     ) WHERE run_ms > 0`,
  ).all(...(opts.agentId ? [since, opts.agentId] : [since]), opts.scanRows ?? (opts.agentId ? 200 : 2000)) as any[]
  return rows.map((r) => ({ id: r.id, agentId: r.agent_id, work: r.work ?? null, estimateMinutes: r.est, realMinutes: r.run_ms / MIN, closedAt: r.closed_at }))
}

/** How long read rows are kept between calls. */
export const ESTIMATES_TTL_MS = 60_000

/** Estimate rows kept for a minute (#1920). Owned by whoever outlives the
 *  calls (the daemon, the dashboard), so a context built per call still
 *  reads the database at most once a minute per agent (or for all). */
export class EstimateCache {
  private kept = new Map<string, { at: number; rows: EstimateRow[] }>()
  constructor(private readonly ttlMs = ESTIMATES_TTL_MS) {}

  rows(db: Database.Database, opts: EstimateOptions & { agentId?: string }): EstimateRow[] {
    const key = `${opts.agentId ?? "*"}|${opts.days}|${opts.scanRows ?? ""}`
    const k = this.kept.get(key)
    if (k && opts.now - k.at >= 0 && opts.now - k.at < this.ttlMs) return k.rows
    const rows = estimateRows(db, opts)
    if (this.kept.size > 500) this.kept.clear()
    this.kept.set(key, { at: opts.now, rows })
    return rows
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** The factor from one agent's rows (newest first). */
export function factorOf(agentId: string, rows: EstimateRow[], opts: Pick<EstimateOptions, "minRows" | "maxRows">): AgentFactor {
  const mine = rows.filter((r) => r.agentId === agentId).slice(0, opts.maxRows ?? DEFAULT_ESTIMATE_OPTIONS.maxRows)
  if (mine.length < Math.max(1, opts.minRows)) return { agentId, factor: 1, rows: mine.length, measured: false }
  const f = median(mine.map((r) => r.realMinutes / r.estimateMinutes))
  return { agentId, factor: round2(Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f))), rows: mine.length, measured: true }
}

/** Every agent's factor, for `agentx requests contract`. */
export function correctionFactors(db: Database.Database, opts: EstimateOptions & { agentId?: string }): AgentFactor[] {
  const rows = estimateRows(db, opts)
  const agents = [...new Set(rows.map((r) => r.agentId))].sort()
  return agents.map((a) => factorOf(a, rows, opts))
}

/** One agent's factor. */
export function correctionFor(db: Database.Database, agentId: string, opts: EstimateOptions): AgentFactor {
  return factorOf(agentId, estimateRows(db, { ...opts, agentId }), opts)
}

/** The usual real minutes of work of this kind in one agent's rows, or
 *  null when there are fewer rows than `minRows`. */
export function usualOf(rows: EstimateRow[], work: string | null, opts: Pick<EstimateOptions, "minRows" | "maxRows">): number | null {
  if (!work) return null
  const mine = rows.filter((r) => r.work === work).slice(0, opts.maxRows ?? DEFAULT_ESTIMATE_OPTIONS.maxRows)
  if (mine.length < Math.max(1, opts.minRows)) return null
  return Math.max(1, Math.round(median(mine.map((r) => r.realMinutes))))
}

/** The usual real minutes of this agent's work of this kind, or null
 *  when there are fewer rows than `minRows`. */
export function usualMinutes(db: Database.Database, agentId: string, work: string | null, opts: EstimateOptions): number | null {
  if (!work) return null
  return usualOf(estimateRows(db, { ...opts, agentId }), work, opts)
}
