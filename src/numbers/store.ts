import type Database from "better-sqlite3"
import { READING_NOTE_MAX, statusOf, type Direction, type NumberStatus, type NumberTarget, type Reading, type Rhythm } from "./model"
import { readSource, type NumberSource } from "./sources"

// --- The numbers and their readings, in .agentx/db.sqlite (#1826) ---
//
// Two tables. `numbers` holds the record; its tags are a JSON list in a
// TEXT column. `number_readings` holds one row per number and window: a
// new read of the same window replaces the old one, except that a failed
// read never wipes a value already there. Both tables are made on open,
// empty: a node with no numbers set up sees no change.

/** Where the record was set up: agentx.json, an agent, or the CLI. */
export type NumberOrigin = "config" | "agent" | "cli"

export interface NumberRecord {
  id: string
  name: string
  ownerAgent: string | null
  unit: string | null
  target: NumberTarget | null
  rhythm: Rhythm
  source: NumberSource
  tags: string[]
  origin: NumberOrigin
  /** Last read attempt by the daemon, and its error when it failed. */
  lastReadAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
  /** Set when it is no longer tracked. Its readings stay. */
  archivedAt: number | null
}

export interface NumberInput {
  id: string
  name: string
  ownerAgent?: string | null
  unit?: string | null
  target?: NumberTarget | null
  rhythm?: Rhythm
  source?: NumberSource
  tags?: string[]
  origin: NumberOrigin
}

function toNumber(r: any): NumberRecord {
  let tags: string[] = []
  try {
    const t = JSON.parse(r.tags ?? "[]")
    if (Array.isArray(t)) tags = t.filter((x) => typeof x === "string")
  } catch { /* a broken row reads as no tags */ }
  return {
    id: r.id, name: r.name, ownerAgent: r.owner_agent ?? null, unit: r.unit ?? null,
    target: r.target === null || r.target === undefined ? null : { value: r.target, direction: (r.direction === "down" ? "down" : "up") as Direction },
    rhythm: r.rhythm, source: readSource(r.source_spec), tags, origin: r.origin,
    lastReadAt: r.last_read_at ?? null, lastError: r.last_error ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at ?? null,
  }
}

function toReading(r: any): Reading {
  return {
    numberId: r.number_id, value: r.value ?? null, error: r.error ?? null, readAt: r.read_at,
    periodStart: r.period_start, periodEnd: r.period_end, by: r.by, note: r.note ?? null,
  }
}

export class NumberStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS numbers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_agent TEXT,
        unit TEXT,
        target REAL,
        direction TEXT NOT NULL DEFAULT 'up',
        rhythm TEXT NOT NULL DEFAULT 'weekly',
        source_spec TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        origin TEXT NOT NULL,
        last_read_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS number_readings (
        number_id TEXT NOT NULL,
        value REAL,
        error TEXT,
        read_at INTEGER NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        by TEXT NOT NULL,
        note TEXT,
        PRIMARY KEY (number_id, period_start, period_end)
      );
      CREATE INDEX IF NOT EXISTS idx_number_readings_end ON number_readings(number_id, period_end);
    `)
  }

  get(id: string): NumberRecord | null {
    const row = this.db.prepare("SELECT * FROM numbers WHERE id = ?").get(id)
    return row ? toNumber(row) : null
  }

  /** Tracked numbers by name; `archived` adds the ones no longer tracked.
   *  `tags`: only numbers that carry every one. */
  list(opts: { archived?: boolean; tags?: string[] } = {}): NumberRecord[] {
    const rows = (this.db.prepare(`SELECT * FROM numbers ${opts.archived ? "" : "WHERE archived_at IS NULL"} ORDER BY name COLLATE NOCASE, id`).all() as any[]).map(toNumber)
    const want = (opts.tags ?? []).map((t) => t.toLowerCase())
    return want.length ? rows.filter((n) => want.every((t) => n.tags.includes(t))) : rows
  }

  /** Make a number, or change one: the fields given replace the old ones.
   *  An archived number is tracked again. */
  upsert(input: NumberInput, now: number): NumberRecord {
    const had = this.get(input.id)
    const target = input.target !== undefined ? input.target : had?.target ?? null
    const row = {
      id: input.id,
      name: input.name || had?.name || input.id,
      owner: input.ownerAgent !== undefined ? input.ownerAgent : had?.ownerAgent ?? null,
      unit: input.unit !== undefined ? input.unit : had?.unit ?? null,
      target: target ? target.value : null,
      direction: target ? target.direction : "up",
      rhythm: input.rhythm ?? had?.rhythm ?? "weekly",
      source: JSON.stringify(input.source ?? had?.source ?? { kind: "manual" }),
      tags: JSON.stringify(input.tags ?? had?.tags ?? []),
      origin: input.origin,
    }
    this.db.prepare(`
      INSERT INTO numbers (id, name, owner_agent, unit, target, direction, rhythm, source_spec, tags, origin, created_at, updated_at)
      VALUES (@id, @name, @owner, @unit, @target, @direction, @rhythm, @source, @tags, @origin, @now, @now)
      ON CONFLICT(id) DO UPDATE SET name = @name, owner_agent = @owner, unit = @unit, target = @target, direction = @direction,
        rhythm = @rhythm, source_spec = @source, tags = @tags, origin = @origin, updated_at = @now, archived_at = NULL
    `).run({ ...row, now })
    return this.get(input.id)!
  }

  /** Stop tracking a number. Its readings stay. False when it was not tracked. */
  archive(id: string, now: number): boolean {
    return this.db.prepare("UPDATE numbers SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").run(now, now, id).changes > 0
  }

  /** Keep a reading. A value replaces what the same window held; a failed
   *  read (value null) only fills a window that has no value. */
  record(r: Omit<Reading, "note" | "error"> & { note?: string | null; error?: string | null }): void {
    this.db.prepare(`
      INSERT INTO number_readings (number_id, value, error, read_at, period_start, period_end, by, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(number_id, period_start, period_end) DO UPDATE SET
        value = excluded.value, error = excluded.error, read_at = excluded.read_at, by = excluded.by, note = excluded.note
      WHERE excluded.value IS NOT NULL OR number_readings.value IS NULL
    `).run(
      r.numberId, r.value, r.value === null ? (r.error ?? "the read failed").slice(0, READING_NOTE_MAX) : null,
      r.readAt, r.periodStart, r.periodEnd, r.by, r.note ? r.note.slice(0, READING_NOTE_MAX) : null,
    )
  }

  /** What the daemon's last read attempt gave. */
  markRead(id: string, error: string | null, now: number): void {
    this.db.prepare("UPDATE numbers SET last_read_at = ?, last_error = ? WHERE id = ?").run(now, error ? error.slice(0, READING_NOTE_MAX) : null, id)
  }

  /** Readings newest window first. */
  readings(id: string, limit = 50): Reading[] {
    return (this.db.prepare("SELECT * FROM number_readings WHERE number_id = ? ORDER BY period_end DESC, period_start DESC LIMIT ?").all(id, limit) as any[]).map(toReading)
  }

  /** The reading of exactly this window, if any. */
  readingOf(id: string, start: number, end: number): Reading | null {
    const row = this.db.prepare("SELECT * FROM number_readings WHERE number_id = ? AND period_start = ? AND period_end = ?").get(id, start, end)
    return row ? toReading(row) : null
  }

  /** The newest reading with a value. */
  latestValue(id: string): Reading | null {
    const row = this.db.prepare("SELECT * FROM number_readings WHERE number_id = ? AND value IS NOT NULL ORDER BY period_end DESC, period_start DESC LIMIT 1").get(id)
    return row ? toReading(row) : null
  }

  status(n: NumberRecord, now: number): NumberStatus {
    return statusOf(n, this.readings(n.id, 2), now)
  }
}
