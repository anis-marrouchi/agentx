import type Database from "better-sqlite3"
import { ensureToldTable, type TellSettings, type ToldLedger, type ToldRow } from "./told"

// --- Reach: where the owner is, and did it land (#1138 step B) ---
//
// Four small parts on top of the told-the-owner record (told.ts):
//
//   presence   when the owner was last seen on each surface: the phone
//              app, its Desk tab, a chat he wrote from. One row per
//              surface, shared by the daemon and the dashboard (the
//              phone app is served by the dashboard, same SQLite file).
//              The computer (idle time through the native adapter),
//              Focus and calls are read live, not stored.
//   marks      each told row moves sent → seen → answered. Seen: the
//              phone app's read mark on the push, the Desk showing its
//              request. Answered: a reply in the request's chat, a written
//              answer on the Desk, the request's card decided.
//   ladder     an urgent item goes where the owner was last seen. Unseen
//              after notifications.reach.escalateAfterMinutes, it goes
//              once to the next address on the ladder. Exactly once: the
//              row is claimed before anything is sent. Everything else is
//              left to the gate and the digest.
//   channels   a channel that says it is down (or was switched off) is
//              refused by the router with a reason, shows in /health, and
//              raises one notice per down spell (ChannelWatch).

export const OWNER = "owner"
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** An urgent row older than this is history, not something to chase. */
export const ESCALATE_MAX_AGE_MS = 24 * HOUR
/** A told row older than this is not marked by a reply any more. */
export const ANSWER_LOOKBACK_MS = 7 * 24 * HOUR
/** A push read mark matches a told row written at most this long before
 *  the push was logged (the row is written first, then sent). */
const PUSH_MATCH_MS = 2 * MINUTE

export interface ReachSettings {
  enabled: boolean
  escalateAfterMinutes: number
  /** Ordered owner addresses, "channel:chatId". Empty: the told channels
   *  (chat "default") and the told addresses, in that order. */
  ladder: string[]
}

export const DEFAULT_REACH_SETTINGS: ReachSettings = { enabled: false, escalateAfterMinutes: 10, ladder: [] }

// --- presence ---

export interface PresenceRow {
  surface: string
  at: number
}

export function ensurePresenceTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_presence (
      person TEXT NOT NULL,
      surface TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (person, surface)
    );
  `)
}

export class PresenceStore {
  /** Last write per surface, so a phone polling every few seconds writes
   *  at most once in `throttleMs`. */
  private written = new Map<string, number>()

  constructor(private db: Database.Database, private now: () => number = Date.now, private throttleMs = 30_000) {
    ensurePresenceTable(db)
  }

  /** The owner was just on `surface`. */
  touch(surface: string, person = OWNER): void {
    const at = this.now()
    const k = `${person}\n${surface}`
    if (at - (this.written.get(k) ?? -Infinity) < this.throttleMs) return
    this.written.set(k, at)
    this.db.prepare(
      `INSERT INTO owner_presence (person, surface, at) VALUES (?, ?, ?)
       ON CONFLICT(person, surface) DO UPDATE SET at = MAX(at, excluded.at)`,
    ).run(person, surface.slice(0, 200), at)
  }

  /** Newest first. */
  list(person = OWNER): PresenceRow[] {
    return this.db.prepare("SELECT surface, at FROM owner_presence WHERE person = ? ORDER BY at DESC").all(person) as PresenceRow[]
  }
}

/** The surface an owner turn shows him on: the phone app, the computer's
 *  own surfaces, or the chat he wrote from. */
export function turnSurface(channel: string, chatId: string): string {
  const ch = channel.toLowerCase().split("@")[0]
  if (ch === "app") return "phone"
  if (ch === "dashboard" || ch === "voice" || ch === "webrtc") return "computer"
  return `${ch}:${chatId}`
}

// --- marks: sent → seen → answered ---

export class ReachMarks {
  constructor(private db: Database.Database, private now: () => number = Date.now) {
    ensureToldTable(db)
  }

  /** Rows that went out and are not answered yet, with a request, newest
   *  first: the ones a reply or a decided card can answer. */
  openRequestRows(): Array<{ id: number; requestId: string; at: number }> {
    return this.db.prepare(
      `SELECT id, request_id AS requestId, at FROM owner_told
       WHERE request_id IS NOT NULL AND answered_at IS NULL AND outcome IN ('sent', 'held') AND at >= ?
       ORDER BY at DESC LIMIT 500`,
    ).all(this.now() - ANSWER_LOOKBACK_MS) as Array<{ id: number; requestId: string; at: number }>
  }

  /** The owner saw what was told about these requests. */
  seenByRequest(requestIds: string[], via: string): number {
    return this.byRequest(requestIds, (ids) => this.seen(ids, via))
  }

  /** The owner answered these requests: their rows are answered (and so
   *  seen), as of `at` (default now), if they were told before it. */
  answeredByRequest(requestIds: string[], via: string, at = this.now()): number {
    return this.byRequest(requestIds, (ids) => this.answered(ids, via, at), at)
  }

  /** The phone app marked these pushes read: the told rows they carried
   *  are seen. A push is matched by its title and time: the row is
   *  written just before the push is sent and logged. */
  seenPush(items: Array<{ at: number; title: string }>, via = "phone"): number {
    const ids: number[] = []
    const find = this.db.prepare(
      `SELECT id, title FROM owner_told WHERE channel = 'push' AND outcome IN ('sent', 'held') AND at BETWEEN ? AND ? ORDER BY at DESC`,
    )
    for (const it of items) {
      // Push titles are cut to 120 characters with an ellipsis.
      const head = it.title.endsWith("…") ? it.title.slice(0, -1) : it.title
      const rows = find.all(it.at - PUSH_MATCH_MS, it.at) as Array<{ id: number; title: string }>
      const hit = rows.find((r) => r.title === it.title || (head !== it.title && r.title.startsWith(head)))
      if (hit) ids.push(hit.id)
    }
    return this.seen(ids, via)
  }

  /** Marks rows seen, with the rows they carry on or that carry them on
   *  (an escalation is the same item). Returns how many changed. */
  seen(ids: number[], via: string, at = this.now()): number {
    if (!ids.length) return 0
    return this.db.prepare(
      `UPDATE owner_told SET seen_at = ?, seen_via = ?
       WHERE seen_at IS NULL AND (${family(ids)})`,
    ).run(at, via, ...ids, ...ids, ...ids).changes
  }

  answered(ids: number[], via: string, at = this.now()): number {
    if (!ids.length) return 0
    return this.db.prepare(
      `UPDATE owner_told SET answered_at = ?, answered_via = ?, seen_at = COALESCE(seen_at, ?), seen_via = COALESCE(seen_via, ?)
       WHERE answered_at IS NULL AND (${family(ids)})`,
    ).run(at, via, at, via, ...ids, ...ids, ...ids).changes
  }

  private byRequest(requestIds: string[], mark: (ids: number[]) => number, before = Infinity): number {
    const want = new Set(requestIds.filter(Boolean))
    if (!want.size) return 0
    const ids = this.openRequestRows().filter((r) => want.has(r.requestId) && r.at <= before).map((r) => r.id)
    return mark(ids)
  }
}

/** Rows `ids`, their escalations, and the rows they escalate. */
function family(ids: number[]): string {
  const q = ids.map(() => "?").join(", ")
  return `id IN (${q}) OR escalation_of IN (${q}) OR id IN (SELECT escalation_of FROM owner_told WHERE id IN (${q}) AND escalation_of IS NOT NULL)`
}

// --- the ladder ---

/** The owner addresses an urgent item may go to, in order. */
export function ladderStops(reach: Pick<ReachSettings, "ladder">, told: Pick<TellSettings, "channels" | "addresses">, registered: (channel: string) => boolean): string[] {
  const raw = reach.ladder.length ? reach.ladder : [...told.channels.map((c) => `${c}:default`), ...told.addresses]
  const out: string[] = []
  for (const s of raw) {
    const stop = s.trim()
    const ch = stopChannel(stop)
    if (ch && registered(ch) && !out.includes(stop)) out.push(stop)
  }
  return out
}

export function stopChannel(stop: string): string {
  const i = stop.indexOf(":")
  return i > 0 ? stop.slice(0, i) : ""
}

export function stopChat(stop: string): string {
  const i = stop.indexOf(":")
  return i > 0 ? stop.slice(i + 1) : "default"
}

/** The surfaces that mean the owner is where this address reaches him. */
function stopSurfaces(stop: string): string[] {
  return stopChannel(stop) === "push" ? ["phone", "desk"] : [stop]
}

/** Where an urgent item goes first: the address whose surface the owner
 *  was seen on last, among those up; none seen, the first one up. */
export function firstStop(stops: string[], presence: PresenceRow[], up: (channel: string) => boolean): string | null {
  const live = stops.filter((s) => up(stopChannel(s)))
  if (!live.length) return null
  let best: { stop: string; at: number } | null = null
  for (const s of live) {
    const at = Math.max(-Infinity, ...presence.filter((p) => stopSurfaces(s).includes(p.surface)).map((p) => p.at))
    if (Number.isFinite(at) && (!best || at > best.at)) best = { stop: s, at }
  }
  return best?.stop ?? live[0]
}

/** The address after `from` on the ladder (wrapping), up and not `from`. */
export function nextStop(stops: string[], from: string, up: (channel: string) => boolean): string | null {
  const i = stops.indexOf(from)
  const order = i < 0 ? stops : [...stops.slice(i + 1), ...stops.slice(0, i)]
  return order.find((s) => s !== from && up(stopChannel(s))) ?? null
}

export interface EscalateDeps {
  db: Database.Database
  ledger: ToldLedger
  settings: ReachSettings
  stops: string[]
  up: (channel: string) => boolean
  now: number
  /** Sends the escalation; rejects when it did not go. */
  send: (stop: string, row: ToldRow, text: string) => Promise<void>
  log: (msg: string) => void
}

/** Urgent rows sent and neither seen nor answered for the set minutes.
 *  Each is claimed (escalated_at) before anything is sent, so a second
 *  sweep, or a second process, never sends it again. */
export async function escalateUnseen(deps: EscalateDeps): Promise<number> {
  const { db, ledger, settings, now } = deps
  if (!settings.enabled || !(settings.escalateAfterMinutes > 0)) return 0
  const due = db.prepare(
    `SELECT id FROM owner_told
     WHERE urgent = 1 AND outcome = 'sent' AND seen_at IS NULL AND answered_at IS NULL
       AND escalated_at IS NULL AND escalation_of IS NULL AND at <= ? AND at >= ?
     ORDER BY at LIMIT 20`,
  ).all(now - settings.escalateAfterMinutes * MINUTE, now - ESCALATE_MAX_AGE_MS) as Array<{ id: number }>
  const claim = db.prepare("UPDATE owner_told SET escalated_at = ? WHERE id = ? AND escalated_at IS NULL")
  let sent = 0
  for (const { id } of due) {
    if (claim.run(now, id).changes !== 1) continue
    const row = ledger.get(id)
    if (!row) continue
    const from = `${row.channel}:${row.chatId}`
    const stop = nextStop(deps.stops, from, deps.up)
    if (!stop) {
      deps.log(`[reach] urgent "${row.title.slice(0, 80)}" unseen on ${from}; no other address to try`)
      continue
    }
    const minutes = Math.round((now - row.at) / MINUTE)
    const text = `${row.text ? `${row.text}\n\n` : ""}(Sent again here: not seen on ${row.channel} for ${minutes} min.)`
    const copy = ledger.add({
      at: now, key: row.key, requestId: row.requestId, kind: row.kind, channel: stopChannel(stop), chatId: stopChat(stop),
      from: row.from, title: row.title, text, outcome: "sent", urgent: true, escalationOf: row.id,
    })
    try {
      await deps.send(stop, row, text)
      sent++
      deps.log(`[reach] urgent "${row.title.slice(0, 80)}" unseen on ${from} for ${minutes} min; sent once to ${stop}`)
    } catch (e: any) {
      ledger.setOutcome(copy, "failed")
      deps.log(`[reach] urgent "${row.title.slice(0, 80)}": escalation to ${stop} failed: ${e?.message ?? e}`)
    }
  }
  return sent
}

// --- channel health ---

export interface ChannelHealth {
  up: boolean
  /** Why it is down, in plain words. */
  reason?: string
}

export interface ChannelHealthView extends ChannelHealth {
  /** Since when it is down (epoch ms). */
  since?: number
}

/** Follows the channels' health between checks: a channel down on two
 *  checks in a row raises one notice, and another only after it was up
 *  again. A one-check blip (a reconnect) raises nothing. */
export class ChannelWatch {
  private state = new Map<string, { downSince: number | null; checks: number; told: boolean; reason?: string }>()

  constructor(private opts: {
    read: () => Record<string, ChannelHealth>
    notice: (channel: string, reason: string) => void
    log: (msg: string) => void
    now?: () => number
    confirmChecks?: number
  }) {}

  tick(): void {
    const now = (this.opts.now ?? Date.now)()
    const confirm = this.opts.confirmChecks ?? 2
    for (const [name, h] of Object.entries(this.opts.read())) {
      const s = this.state.get(name) ?? { downSince: null, checks: 0, told: false }
      if (h.up) {
        if (s.downSince !== null) this.opts.log(`[reach] channel ${name} is up again`)
        this.state.set(name, { downSince: null, checks: 0, told: false })
        continue
      }
      s.downSince ??= now
      s.checks++
      s.reason = h.reason
      if (!s.told && s.checks >= confirm) {
        s.told = true
        this.opts.log(`[reach] channel ${name} is down: ${h.reason ?? "no reason given"}`)
        this.opts.notice(name, h.reason ?? "no reason given")
      }
      this.state.set(name, s)
    }
  }

  /** Since when each channel down at the last check has been down. */
  downSince(name: string): number | undefined {
    return this.state.get(name)?.downSince ?? undefined
  }
}
