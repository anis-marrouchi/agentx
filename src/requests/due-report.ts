import type Database from "better-sqlite3"
import { correctionFactors, type AgentFactor } from "./estimates"
import { readQueue, readSlots } from "./slot-store"
import { schedule } from "./slots"

// --- Due times, measured (#1909) ---
//
// For `agentx requests contract`: each agent's correction factor, and what
// the shadow rows say: how far the times agents wrote are from the times
// the daemon would have given, and how many calls the refusal would have
// stopped. This is the report the owner reads before the refusal is on.
// Read only.

export interface AgentDueReport {
  agentId: string
  factor: AgentFactor
  /** Slot rows in the window. */
  rows: number
  /** Rows where the agent wrote a time. */
  written: number
  /** Median of (agent's time − daemon's time), minutes; null with none written. */
  medianGapMinutes: number | null
  /** Rows the refusal would have stopped: no source, does not fit. */
  noSource: number
  doesNotFit: number
}

export interface DueReport {
  agents: AgentDueReport[]
  rows: number
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** One agent's queue, for the dashboard's Jobs page: one line each. */
export interface QueueLine {
  agentId: string
  /** Open jobs that take a place in the queue. */
  jobs: number
  /** Their minutes, the factor applied. */
  minutes: number
  /** When the first of them ends, and when the last does. */
  nextEndAt: number
  clearsAt: number
  factor: number
}

/** The node's queue as the daemon computes it, one line per agent, the
 *  busiest first. Read only. */
export function queueLines(db: Database.Database, opts: {
  now: number; capacity: number; lanes: (agentId: string) => number; defaultMinutes: number; factorDays: number; factorMinRows: number
}): QueueLine[] {
  const items = readQueue(db)
  if (!items.length) return []
  const factors = new Map(correctionFactors(db, { now: opts.now, days: opts.factorDays, minRows: opts.factorMinRows }).map((f) => [f.agentId, f.factor]))
  const factor = (a: string) => factors.get(a) ?? 1
  const plan = schedule(items, { now: opts.now, capacity: opts.capacity, lanes: opts.lanes, factor, defaultMinutes: () => opts.defaultMinutes })
  const by = new Map<string, QueueLine>()
  for (const p of plan.values()) {
    const line = by.get(p.agentId) ?? { agentId: p.agentId, jobs: 0, minutes: 0, nextEndAt: p.endAt, clearsAt: p.endAt, factor: factor(p.agentId) }
    line.jobs++
    line.minutes += p.minutes
    line.nextEndAt = Math.min(line.nextEndAt, p.endAt)
    line.clearsAt = Math.max(line.clearsAt, p.endAt)
    by.set(p.agentId, line)
  }
  return [...by.values()].sort((a, b) => b.clearsAt - a.clearsAt || a.agentId.localeCompare(b.agentId))
}

export function dueReport(db: Database.Database, opts: { since: number; now: number; agent?: string; factorDays: number; factorMinRows: number }): DueReport {
  const rows = readSlots(db, opts.since, opts.agent)
  const factors = correctionFactors(db, { now: opts.now, days: opts.factorDays, minRows: opts.factorMinRows, agentId: opts.agent })
  const ids = [...new Set([...factors.map((f) => f.agentId), ...rows.map((r) => r.agentId)])].sort()
  const agents = ids.map((agentId) => {
    const mine = rows.filter((r) => r.agentId === agentId)
    const gaps = mine.filter((r) => r.agentDue !== null && r.computedDue !== null).map((r) => (r.agentDue! - r.computedDue!) / 60_000)
    const m = median(gaps)
    return {
      agentId,
      factor: factors.find((f) => f.agentId === agentId) ?? { agentId, factor: 1, rows: 0, measured: false },
      rows: mine.length,
      written: gaps.length,
      medianGapMinutes: m === null ? null : Math.round(m),
      noSource: mine.filter((r) => r.wouldRefuse === "no source").length,
      doesNotFit: mine.filter((r) => r.wouldRefuse === "does not fit").length,
    }
  })
  return { agents, rows: rows.length }
}
