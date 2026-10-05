import type Database from "better-sqlite3"
import { randomBytes } from "crypto"

// --- Places, place reminders and place events (SQLite) (#676) ---
//
// A place is a named circle (centre and radius) the owner saved from the
// phone app, the dashboard or `agentx places`. The Android shell registers
// each one as an OS geofence and reports only "entered" or "left" for a
// place id, never a raw position. A place reminder says what happens on
// that event: a notification with its text, or a turn for an agent whose
// answer becomes the notification.
//
// Same .agentx/db.sqlite as the push tables, created the same way
// (IF NOT EXISTS, no numbered migration; see push-store.ts).

export type PlaceTransition = "enter" | "exit"

export interface Place {
  id: string
  name: string
  lat: number
  lon: number
  radiusMeters: number
  createdAt: number
  updatedAt: number
}

export interface PlaceReminder {
  id: string
  placeId: string
  on: PlaceTransition
  text: string
  /** Agent that gets the reminder as a turn; null sends the text as it is. */
  agent: string | null
  /** Fire every time; false fires once, then the reminder is done. */
  repeat: boolean
  /** Only events from this phone fire it; null means any paired phone. */
  deviceId: string | null
  createdAt: number
  lastFiredAt: number | null
  done: boolean
}

export interface PlaceEvent {
  id: string
  placeId: string
  placeName: string
  deviceId: string
  transition: PlaceTransition
  /** When the phone saw it (from the phone's clock). */
  at: number
  receivedAt: number
  /** Reminders it fired; 0 for a duplicate, a stale event or none set. */
  fired: number
  note: string | null
}

export interface PlaceInput {
  name: string
  lat: number
  lon: number
  radiusMeters: number
}

export interface ReminderInput {
  placeId: string
  on: PlaceTransition
  text: string
  agent?: string | null
  repeat?: boolean
  deviceId?: string | null
}

export class PlaceStore {
  constructor(private db: Database.Database, private now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
      radius_m INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS place_reminders (
      id TEXT PRIMARY KEY, place_id TEXT NOT NULL, on_event TEXT NOT NULL, text TEXT NOT NULL,
      agent TEXT, repeat INTEGER NOT NULL, device_id TEXT, created_at INTEGER NOT NULL,
      last_fired_at INTEGER, done INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS place_reminders_place ON place_reminders(place_id);
      CREATE TABLE IF NOT EXISTS place_events (
      id TEXT PRIMARY KEY, place_id TEXT NOT NULL, place_name TEXT NOT NULL, device_id TEXT NOT NULL,
      transition TEXT NOT NULL, at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      fired INTEGER NOT NULL, note TEXT);
      CREATE INDEX IF NOT EXISTS place_events_received ON place_events(received_at);`)
  }

  // --- places ---

  listPlaces(): Place[] {
    return (this.db.prepare("SELECT * FROM places ORDER BY name COLLATE NOCASE, id").all() as any[]).map(toPlace)
  }

  getPlace(id: string): Place | null {
    const row = this.db.prepare("SELECT * FROM places WHERE id = ?").get(id)
    return row ? toPlace(row) : null
  }

  /** Matches an id, or a name ignoring case. */
  findPlace(idOrName: string): Place | null {
    return this.getPlace(idOrName)
      ?? this.listPlaces().find((p) => p.name.toLowerCase() === idOrName.trim().toLowerCase())
      ?? null
  }

  addPlace(input: PlaceInput): Place {
    const now = this.now()
    const id = newId("pl")
    this.db.prepare("INSERT INTO places (id, name, lat, lon, radius_m, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.lat, input.lon, input.radiusMeters, now, now)
    return this.getPlace(id)!
  }

  updatePlace(id: string, patch: Partial<PlaceInput>): Place | null {
    const cur = this.getPlace(id)
    if (!cur) return null
    const next = { ...cur, ...patch }
    this.db.prepare("UPDATE places SET name = ?, lat = ?, lon = ?, radius_m = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.lat, next.lon, next.radiusMeters, this.now(), id)
    return this.getPlace(id)
  }

  /** Removes the place and its reminders. */
  removePlace(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM place_reminders WHERE place_id = ?").run(id)
      return this.db.prepare("DELETE FROM places WHERE id = ?").run(id).changes > 0
    })
    return tx()
  }

  /** Changes whenever a place is added, moved or removed, so the phone can
   *  tell its geofences are out of date without comparing every field. */
  version(): string {
    const row = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS m, COALESCE(GROUP_CONCAT(id), '') AS ids FROM (SELECT id, updated_at FROM places ORDER BY id)").get() as { n: number; m: number; ids: string }
    return `${row.n}-${row.m}-${hash(row.ids)}`
  }

  // --- reminders ---

  listReminders(opts: { placeId?: string; includeDone?: boolean } = {}): PlaceReminder[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.placeId) { where.push("place_id = ?"); args.push(opts.placeId) }
    if (!opts.includeDone) where.push("done = 0")
    const sql = `SELECT * FROM place_reminders${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`
    return (this.db.prepare(sql).all(...args) as any[]).map(toReminder)
  }

  addReminder(input: ReminderInput): PlaceReminder {
    const id = newId("pr")
    this.db.prepare(`INSERT INTO place_reminders (id, place_id, on_event, text, agent, repeat, device_id, created_at, done)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(id, input.placeId, input.on, input.text, input.agent ?? null, input.repeat ? 1 : 0, input.deviceId ?? null, this.now())
    return toReminder(this.db.prepare("SELECT * FROM place_reminders WHERE id = ?").get(id))
  }

  removeReminder(id: string): boolean {
    return this.db.prepare("DELETE FROM place_reminders WHERE id = ?").run(id).changes > 0
  }

  /** The open reminders an event fires, marked fired in the same
   *  transaction, so two copies of one event can't both claim a reminder. */
  claimReminders(placeId: string, on: PlaceTransition, deviceId: string): PlaceReminder[] {
    const tx = this.db.transaction(() => {
      const due = (this.db.prepare(`SELECT * FROM place_reminders WHERE place_id = ? AND on_event = ? AND done = 0
        AND (device_id IS NULL OR device_id = ?) ORDER BY created_at, id`).all(placeId, on, deviceId) as any[]).map(toReminder)
      const now = this.now()
      const mark = this.db.prepare("UPDATE place_reminders SET last_fired_at = ?, done = ? WHERE id = ?")
      for (const r of due) mark.run(now, r.repeat ? 0 : 1, r.id)
      return due
    })
    return tx()
  }

  // --- events ---

  hasEvent(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM place_events WHERE id = ?").get(id)
  }

  /** The newest event from this phone for this place and transition. */
  lastEvent(placeId: string, deviceId: string, transition: PlaceTransition): PlaceEvent | null {
    const row = this.db.prepare(`SELECT * FROM place_events WHERE place_id = ? AND device_id = ? AND transition = ?
      ORDER BY at DESC LIMIT 1`).get(placeId, deviceId, transition)
    return row ? toEvent(row) : null
  }

  logEvent(e: Omit<PlaceEvent, "receivedAt">, keep: number): PlaceEvent {
    const receivedAt = this.now()
    this.db.prepare(`INSERT OR IGNORE INTO place_events (id, place_id, place_name, device_id, transition, at, received_at, fired, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.id, e.placeId, e.placeName, e.deviceId, e.transition, e.at, receivedAt, e.fired, e.note)
    this.db.prepare(`DELETE FROM place_events WHERE id NOT IN (SELECT id FROM place_events ORDER BY received_at DESC, id LIMIT ?)`)
      .run(Math.max(keep, 1))
    return { ...e, receivedAt }
  }

  recentEvents(limit: number): PlaceEvent[] {
    return (this.db.prepare("SELECT * FROM place_events ORDER BY received_at DESC, id LIMIT ?").all(limit) as any[]).map(toEvent)
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`
}

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function toPlace(r: any): Place {
  return { id: r.id, name: r.name, lat: r.lat, lon: r.lon, radiusMeters: r.radius_m, createdAt: r.created_at, updatedAt: r.updated_at }
}

function toReminder(r: any): PlaceReminder {
  return {
    id: r.id, placeId: r.place_id, on: r.on_event, text: r.text, agent: r.agent ?? null, repeat: r.repeat === 1,
    deviceId: r.device_id ?? null, createdAt: r.created_at, lastFiredAt: r.last_fired_at ?? null, done: r.done === 1,
  }
}

function toEvent(r: any): PlaceEvent {
  return {
    id: r.id, placeId: r.place_id, placeName: r.place_name, deviceId: r.device_id, transition: r.transition,
    at: r.at, receivedAt: r.received_at, fired: r.fired, note: r.note ?? null,
  }
}
