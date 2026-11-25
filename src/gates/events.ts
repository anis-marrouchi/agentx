/**
 * The gate log (#2085 §4): one append-only row per thing a Rules Registry
 * gate refused, fixed, would have refused, or could not check. One query
 * covers all three gates, so the owner sees each gate working.
 *
 * Reason and tool name only: never the tool arguments or the command.
 */
import type Database from "better-sqlite3"
import { openDb } from "@/storage/sqlite"

export type GateOutcome =
  | "allow"
  | "refused"
  | "would-refuse"
  | "fixed"
  | "unchecked"
  | "reported"
  | "not-fixed"
  | "covered-by-plan"
  | "asked"
  | "would-ask"
  | "corrected"
  | "untied"

export interface GateEvent {
  gate: string
  ruleId: string
  outcome: GateOutcome
  agent?: string
  ref?: string
  reason?: string
  at?: number
}

export function ensureGateEventsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_events (
      at INTEGER NOT NULL,
      gate TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      agent TEXT,
      ref TEXT,
      outcome TEXT NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gate_events_gate ON gate_events(gate, at);
  `)
}

/** Write one row. Never throws: a log that fails must not stop the gate. */
export function recordGateEvent(e: GateEvent, db: Database.Database | null = openDb({ quiet: true })): void {
  if (!db) return
  try {
    ensureGateEventsTable(db)
    db.prepare(
      "INSERT INTO gate_events (at, gate, rule_id, agent, ref, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      e.at ?? Date.now(),
      e.gate,
      e.ruleId,
      e.agent?.slice(0, 120) ?? null,
      e.ref?.slice(0, 200) ?? null,
      e.outcome,
      e.reason?.slice(0, 500) ?? null,
    )
  } catch (err: any) {
    console.error(`[gates] gate_events write failed (${e.gate}/${e.outcome}): ${err?.message ?? err}`)
  }
}

export interface GateEventRow {
  at: number
  gate: string
  ruleId: string
  agent: string | null
  ref: string | null
  outcome: GateOutcome
  reason: string | null
}

/** Rows of one gate since a time, newest first. */
export function gateEventsSince(db: Database.Database, gate: string, since: number): GateEventRow[] {
  ensureGateEventsTable(db)
  return db.prepare(
    `SELECT at, gate, rule_id AS ruleId, agent, ref, outcome, reason FROM gate_events
     WHERE gate = ? AND at >= ? ORDER BY at DESC`,
  ).all(gate, since) as GateEventRow[]
}
