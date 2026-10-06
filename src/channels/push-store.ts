import type Database from "better-sqlite3"
import { PushPrefs } from "./push-prefs"

// --- Web Push subscriptions and recent pushes (SQLite) ---
//
// Shared by two processes on the node that hosts the phone app: the
// dashboard writes subscriptions when a phone turns notifications on
// (/api/app/push/*), and the daemon's PushAdapter reads them to deliver,
// prunes the ones the push service reports gone, and logs what it sent for
// the app's Alerts tab. Both open the same .agentx/db.sqlite; WAL lets one
// write while the other reads.
//
// Tables are created here with IF NOT EXISTS rather than as a numbered
// migration, so a branch that claims the same migration number elsewhere
// can't make a database skip them.

export interface PushSubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
  /** Token id of the paired phone (TokenRecord.id). */
  deviceId: string
  deviceName: string
  /** VAPID public key the browser subscribed with. After
   *  `agentx app push-keys --force` older rows can never be delivered. */
  publicKey: string
  createdAt: number
}

export interface PushLogRow {
  id: number
  at: number
  title: string
  body: string
  url: string | null
  /** Phones the push service accepted it for. */
  delivered: number
  /** Set when the push was addressed to one phone; null for every phone. */
  deviceId: string | null
}

export class PushStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      device_id TEXT NOT NULL, device_name TEXT NOT NULL, public_key TEXT NOT NULL,
      created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS push_subscriptions_device ON push_subscriptions(device_id);
      CREATE TABLE IF NOT EXISTS push_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, url TEXT, delivered INTEGER NOT NULL, device_id TEXT);`)
    this.prefs = new PushPrefs(db)
  }

  /** Per-phone switches for each kind of notification (push-prefs.ts). */
  readonly prefs: PushPrefs

  /** Whether this phone is told when a chat answer finishes while it looks
   *  elsewhere (#265). On unless the phone turned it off. */
  chatFinishOn(deviceId: string): boolean {
    return this.prefs.on(deviceId, "finish")
  }

  setChatFinish(deviceId: string, on: boolean, now = Date.now()): void {
    this.prefs.set(deviceId, "finish", on, now)
  }

  /** Adds or refreshes a subscription. A browser that re-subscribes keeps
   *  its endpoint, so the row is replaced, not duplicated. */
  subscribe(row: Omit<PushSubscriptionRow, "createdAt">, now = Date.now()): void {
    this.db.prepare(`INSERT OR REPLACE INTO push_subscriptions
      (endpoint, p256dh, auth, device_id, device_name, public_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.endpoint, row.p256dh, row.auth, row.deviceId, row.deviceName, row.publicKey, now)
  }

  /** Removes one subscription, only if it belongs to `deviceId` when given. */
  unsubscribe(endpoint: string, deviceId?: string): boolean {
    const r = deviceId === undefined
      ? this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint)
      : this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id = ?").run(endpoint, deviceId)
    return r.changes > 0
  }

  list(deviceId?: string): PushSubscriptionRow[] {
    const rows = (deviceId === undefined
      ? this.db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY created_at").all(deviceId)) as any[]
    return rows.map((r) => ({
      endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth,
      deviceId: r.device_id, deviceName: r.device_name, publicKey: r.public_key, createdAt: r.created_at,
    }))
  }

  /** Removes the subscriptions of phones paired with relaying node
   *  `origin` whose token id isn't in `active` (revoked, expired or
   *  removed there). Returns how many rows went. */
  pruneOrigin(origin: string, active: Iterable<string>): number {
    const keep = new Set([...active].map((id) => `${origin}:${id}`))
    let removed = 0
    for (const s of this.list()) {
      if (s.deviceId.startsWith(`${origin}:`) && !keep.has(s.deviceId)) {
        if (this.unsubscribe(s.endpoint)) removed++
      }
    }
    return removed
  }

  /** Removes every subscription of one device id. Returns how many went. */
  forgetDevice(deviceId: string): number {
    return this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId).changes
  }

  /** Records a sent push and keeps only the newest `keep` rows. */
  log(entry: Omit<PushLogRow, "id" | "at">, keep: number, now = Date.now()): void {
    this.db.prepare("INSERT INTO push_log (at, title, body, url, delivered, device_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now, entry.title, entry.body, entry.url, entry.delivered, entry.deviceId)
    this.db.prepare("DELETE FROM push_log WHERE id NOT IN (SELECT id FROM push_log ORDER BY id DESC LIMIT ?)").run(Math.max(0, keep))
  }

  /** Newest first. With `deviceId`, only pushes sent to every phone or to
   *  that one, so one phone never sees another's messages. */
  recent(limit: number, deviceId?: string): PushLogRow[] {
    const cols = "id, at, title, body, url, delivered, device_id AS deviceId"
    return (deviceId === undefined
      ? this.db.prepare(`SELECT ${cols} FROM push_log ORDER BY id DESC LIMIT ?`).all(Math.max(0, limit))
      : this.db.prepare(`SELECT ${cols} FROM push_log WHERE device_id IS NULL OR device_id = ? ORDER BY id DESC LIMIT ?`)
        .all(deviceId, Math.max(0, limit))) as PushLogRow[]
  }
}
