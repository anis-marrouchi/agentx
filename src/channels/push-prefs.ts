import type Database from "better-sqlite3"

// --- Per-phone notification preferences (SQLite) ---
//
// One row per (phone, preference): which kinds of notification a paired
// phone wants. The dashboard writes them from the phone app; the daemon
// reads them before it sends. Same .agentx/db.sqlite as push-store.ts.
//
// A preference with no row falls back to the default the caller passes,
// so a phone paired before a preference existed gets that default without
// a migration. Names are short keys ("announce" for mesh announcements);
// another kind of notification adds its own name, not a new table.

export class PushPrefs {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_prefs (
      device_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (device_id, name));`)
  }

  get(deviceId: string, name: string, fallback: boolean): boolean {
    const row = this.db.prepare("SELECT value FROM push_prefs WHERE device_id = ? AND name = ?").get(deviceId, name) as
      | { value: number }
      | undefined
    return row ? row.value === 1 : fallback
  }

  set(deviceId: string, name: string, on: boolean, now = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO push_prefs (device_id, name, value, updated_at) VALUES (?, ?, ?, ?)")
      .run(deviceId, name, on ? 1 : 0, now)
  }
}
