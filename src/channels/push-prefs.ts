import type Database from "better-sqlite3"

// --- Per-phone notification switches (SQLite) ---
//
// The one per-device settings store for the phone app: one row per
// (phone, switch). The dashboard writes them from the Alerts tab
// (POST /api/app/push/prefs); the daemon and dashboard read them before
// they send. Same .agentx/db.sqlite as push-store.ts, created the same way
// (IF NOT EXISTS, no numbered migration).
//
// A switch with no row takes its default, so a phone paired before a
// switch existed gets the default without a migration. A new kind of
// notification adds a name to PUSH_PREFS, not a table.

/** Every switch, with its default and the field name the app API uses. */
export const PUSH_PREFS = {
  /** A chat answer finished in a conversation the phone isn't viewing (#265). */
  finish: { field: "chatFinish", default: true },
  /** A mesh announcement (#268). */
  announce: { field: "announce", default: true },
} as const

export type PushPrefName = keyof typeof PUSH_PREFS

export class PushPrefs {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_prefs (
      device_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (device_id, name));`)
  }

  /** The phone's setting, or the switch's default when it never set one. */
  on(deviceId: string, name: PushPrefName): boolean {
    const row = this.db.prepare("SELECT value FROM push_prefs WHERE device_id = ? AND name = ?").get(deviceId, name) as
      | { value: number }
      | undefined
    return row ? row.value === 1 : PUSH_PREFS[name].default
  }

  set(deviceId: string, name: PushPrefName, on: boolean, now = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO push_prefs (device_id, name, value, updated_at) VALUES (?, ?, ?, ?)")
      .run(deviceId, name, on ? 1 : 0, now)
  }

  /** Every switch for one phone, keyed by its API field name. */
  all(deviceId: string): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    for (const name of Object.keys(PUSH_PREFS) as PushPrefName[]) out[PUSH_PREFS[name].field] = this.on(deviceId, name)
    return out
  }
}
