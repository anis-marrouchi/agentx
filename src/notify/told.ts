import { createHash } from "crypto"
import type Database from "better-sqlite3"

// --- One record of what the owner was told (#1126) ---
//
// Every message that goes to the owner's own addresses (the notification
// channels, and any private chat listed in notifications.told.addresses)
// passes one gate and leaves one row here: what was said, which item and
// request it belongs to, the channel, who sent it, and what became of it.
//
// The gate decides before anything is sent:
//
//   repeat   the same item was already told within the window, on any
//            channel: not told again. An item is its key: request:<id>,
//            card:<id>, or what the caller names; without one, a long
//            enough text is its own key, so a script that sends the same
//            alarm every hour is told once a day.
//   digest   a nag ("not finished", "disk low", "channel down") waits for
//            the daily digest, which folds every waiting one into a line.
//   send     anything else. Focus and calls still hold it (notify()).
//
// Urgent messages always go. The record is the base for "did he get it?"
// (seen, answered) later: the table keeps one row per decision.

export type TellKind = "notice" | "nag"
export type TellOutcome = "sent" | "held" | "digest" | "repeat" | "failed"

/** What a caller says about a message to the owner. All optional: a bare
 *  message on an owner channel is a notice keyed by its text. */
export interface TellMeta {
  /** The item it is about. Same key, same item, whatever the channel. */
  key?: string
  /** The open request it belongs to (requests, #356). */
  requestId?: string
  kind?: TellKind
  /** Goes now: no repeat check, no digest. */
  urgent?: boolean
  /** Who is telling: an agent id, or a daemon part (requests, watchers). */
  from?: string
  /** Without a key, the text is the key: only for notices (the daemon's
   *  own, `agentx notify`), never for an agent's answer, which may well
   *  say the same thing twice on purpose. */
  textKey?: boolean
}

export interface ToldRow {
  id: number
  at: number
  key: string
  requestId: string | null
  kind: TellKind
  channel: string
  chatId: string
  from: string | null
  title: string
  text: string
  outcome: TellOutcome
  digestedAt: number | null
}

export interface TellSettings {
  enabled: boolean
  repeatWindowHours: number
  channels: string[]
  addresses: string[]
  digestNags: boolean
  /** A daily digest can go out (on, with a destination). False: a nag is
   *  sent at once, or it would never reach anyone. Unset: true. */
  digestAvailable?: boolean
}

export const DEFAULT_TELL_SETTINGS: TellSettings = {
  enabled: true, repeatWindowHours: 24, channels: ["push", "ntfy"], addresses: [], digestNags: true,
}

/** A text shorter than this is not its own key: "Done." twice in a day is
 *  two answers, not a repeat. */
export const TEXT_KEY_MIN = 40
/** Longest a text alone keeps an item told. */
export const TEXT_WINDOW_HOURS = 20
/** Days a row of the record is kept. */
export const TOLD_KEEP_DAYS = 90
const TEXT_MAX = 2000
const HOUR = 3_600_000

/** The item a message is about. Null: it has none, and is never a repeat. */
export function tellKey(meta: TellMeta, title: string, text: string): string | null {
  if (meta.key?.trim()) return meta.key.trim().slice(0, 200)
  // A request id says which request a notice belongs to, not which notice
  // it is: "step blocked" and "plan finished" are two things to tell.
  if (!meta.textKey) return null
  const words = `${title}\n${text}`.replace(/\s+/g, " ").trim().toLowerCase()
  if (words.length < TEXT_KEY_MIN) return null
  return `text:${createHash("sha256").update(words).digest("hex").slice(0, 24)}`
}

/** The title and the rest of a message as channels carry it: push and
 *  ntfy take the title from the first line. */
export function splitTitle(text: string): { title: string; body: string } {
  const at = text.indexOf("\n")
  return at < 0 ? { title: text.trim(), body: "" } : { title: text.slice(0, at).trim(), body: text.slice(at + 1).trim() }
}

export function ensureToldTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_told (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      request_id TEXT,
      kind TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender TEXT,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      outcome TEXT NOT NULL,
      digested_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_owner_told_key_at ON owner_told(item_key, at);
    CREATE INDEX IF NOT EXISTS idx_owner_told_at ON owner_told(at);
    CREATE INDEX IF NOT EXISTS idx_owner_told_digest ON owner_told(outcome, digested_at);
  `)
}

function toRow(r: any): ToldRow {
  return {
    id: r.id, at: r.at, key: r.item_key, requestId: r.request_id ?? null, kind: r.kind, channel: r.channel, chatId: r.chat_id,
    from: r.sender ?? null, title: r.title, text: r.text, outcome: r.outcome, digestedAt: r.digested_at ?? null,
  }
}

export class ToldLedger {
  constructor(private db: Database.Database) {
    ensureToldTable(db)
  }

  add(row: Omit<ToldRow, "id" | "digestedAt">): number {
    return Number(this.db.prepare(
      `INSERT INTO owner_told (at, item_key, request_id, kind, channel, chat_id, sender, title, text, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.at, row.key, row.requestId, row.kind, row.channel, row.chatId, row.from, row.title.slice(0, 300), row.text.slice(0, TEXT_MAX), row.outcome).lastInsertRowid)
  }

  setOutcome(id: number, outcome: TellOutcome): void {
    this.db.prepare("UPDATE owner_told SET outcome = ? WHERE id = ?").run(outcome, id)
  }

  /** The last time this item reached the owner, or was put in the digest,
   *  since `since`. A failed send does not count: it never arrived. */
  lastTold(key: string, since: number): ToldRow | null {
    const r = this.db.prepare(
      "SELECT * FROM owner_told WHERE item_key = ? AND at >= ? AND outcome IN ('sent', 'held', 'digest') ORDER BY at DESC LIMIT 1",
    ).get(key, since)
    return r ? toRow(r) : null
  }

  /** Nags waiting for the digest, oldest first. */
  waitingForDigest(limit = 500): ToldRow[] {
    return this.db.prepare("SELECT * FROM owner_told WHERE outcome = 'digest' AND digested_at IS NULL ORDER BY at LIMIT ?").all(limit).map(toRow)
  }

  waitingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM owner_told WHERE outcome = 'digest' AND digested_at IS NULL").get() as { n: number }).n
  }

  markDigested(ids: number[], at: number): void {
    const mark = this.db.prepare("UPDATE owner_told SET digested_at = ? WHERE id = ?")
    this.db.transaction(() => { for (const id of ids) mark.run(at, id) })()
  }

  /** Rows since `since`, newest first. */
  since(since: number, limit = 200): ToldRow[] {
    return this.db.prepare("SELECT * FROM owner_told WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?").all(since, limit).map(toRow)
  }

  /** How many of each outcome since `since`: the before/after figure. */
  counts(since: number): Record<TellOutcome, number> {
    const out: Record<TellOutcome, number> = { sent: 0, held: 0, digest: 0, repeat: 0, failed: 0 }
    for (const r of this.db.prepare("SELECT outcome, COUNT(*) AS n FROM owner_told WHERE at >= ? GROUP BY outcome").all(since) as Array<{ outcome: TellOutcome; n: number }>) {
      out[r.outcome] = r.n
    }
    return out
  }

  /** Delete rows older than `before`. */
  prune(before: number): number {
    return this.db.prepare("DELETE FROM owner_told WHERE at < ?").run(before).changes
  }
}

export interface TellDecision {
  verdict: "send" | "repeat" | "digest"
  key: string | null
  /** The row written for it; for send, update it with the outcome. */
  rowId: number
}

/** The one gate. Synchronous, no I/O beyond the ledger. */
export class OwnerGate {
  constructor(
    private ledger: ToldLedger,
    private settings: () => TellSettings,
    private now: () => number = Date.now,
  ) {}

  /** Is this address the owner's own? */
  isOwnerAddress(channel: string, chatId: string): boolean {
    const s = this.settings()
    if (!s.enabled) return false
    return s.channels.includes(channel) || s.addresses.includes(`${channel}:${chatId}`)
  }

  /** Decide, and record the decision. A send is recorded as sent at once
   *  and corrected with `outcome` once known. */
  decide(msg: { channel: string; chatId: string; title: string; text: string }, meta: TellMeta = {}): TellDecision {
    const s = this.settings()
    const now = this.now()
    const key = tellKey(meta, msg.title, msg.text)
    const kind: TellKind = meta.kind ?? "notice"
    // A text is its own key for less than a day: a report that goes out
    // daily with the same words is not taken for a repeat of yesterday's.
    const windowMs = (key?.startsWith("text:") ? Math.min(s.repeatWindowHours, TEXT_WINDOW_HOURS) : s.repeatWindowHours) * HOUR
    let verdict: TellDecision["verdict"] = "send"
    if (!meta.urgent && key && this.ledger.lastTold(key, now - windowMs)) verdict = "repeat"
    else if (!meta.urgent && kind === "nag" && s.digestNags && s.digestAvailable !== false) verdict = "digest"
    const rowId = this.ledger.add({
      at: now, key: key ?? `once:${now}`, requestId: meta.requestId ?? null,
      kind, channel: msg.channel, chatId: msg.chatId, from: meta.from ?? null, title: msg.title, text: msg.text,
      outcome: verdict === "send" ? "sent" : verdict,
    })
    return { verdict, key, rowId }
  }

  outcome(rowId: number, outcome: TellOutcome): void {
    this.ledger.setOutcome(rowId, outcome)
  }

  /** The digest line for every nag waiting, and how to clear them once
   *  the digest went out. Null when none waits. */
  digestLine(): { line: string; ids: number[] } | null {
    const rows = this.ledger.waitingForDigest()
    if (!rows.length) return null
    return { line: nagLine(rows), ids: rows.map((r) => r.id) }
  }

  markDigested(ids: number[]): void {
    this.ledger.markDigested(ids, this.now())
  }

  /** What the owner was told since `since`: counts by outcome, and the
   *  newest rows. */
  report(since: number, limit = 50): { counts: Record<TellOutcome, number>; waitingForDigest: number; items: ToldRow[] } {
    return { counts: this.ledger.counts(since), waitingForDigest: this.ledger.waitingCount(), items: this.ledger.since(since, limit) }
  }

  /** Drop rows older than `days`. */
  prune(days: number): number {
    return this.ledger.prune(this.now() - days * 24 * HOUR)
  }
}

/** The `told` of a /send body, as far as a caller may set it: what the
 *  message is about, never that it already passed the gate. */
export function toldOfBody(v: unknown, agentId?: unknown): TellMeta & { passed?: boolean } {
  const o = v && typeof v === "object" ? v as Record<string, unknown> : {}
  const s = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined)
  const kind = o.kind === "nag" || o.kind === "notice" ? o.kind : undefined
  const from = s(o.from, 100) ?? s(agentId, 100)
  // A caller's key lives in its own space: it cannot name the daemon's
  // items (digest:<day>, request:<id>:attention) and so silence them.
  return {
    ...(s(o.key, 190) ? { key: `send:${s(o.key, 190)}` } : {}),
    ...(s(o.requestId, 100) ? { requestId: s(o.requestId, 100) } : {}),
    ...(kind ? { kind } : {}),
    ...(o.urgent === true ? { urgent: true } : {}),
    ...(o.textKey === true ? { textKey: true } : {}),
    ...(from ? { from } : {}),
  }
}

/** "12 notices held for this digest: Not finished ×9 (Check the invoices
 *  batch, Compare hosting plans, …); Mac disk low ×3." One line. */
export function nagLine(rows: Array<Pick<ToldRow, "title">>, maxGroups = 5, maxNames = 3): string {
  // Grouped by what comes before the first ": " of the title ("Not
  // finished: <headline>"), each group naming its first few items.
  const groups = new Map<string, { count: number; names: string[] }>()
  for (const r of rows) {
    const [head, ...rest] = r.title.split(": ")
    const name = rest.join(": ").trim()
    const g = groups.get(head.trim()) ?? { count: 0, names: [] }
    g.count++
    if (name && !g.names.includes(name)) g.names.push(name)
    groups.set(head.trim(), g)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count)
  const parts = sorted.slice(0, maxGroups).map(([head, { count, names }]) => {
    const list = names.length ? ` (${names.slice(0, maxNames).join(", ")}${names.length > maxNames ? ", …" : ""})` : ""
    return `${head}${count > 1 ? ` ×${count}` : ""}${list}`
  })
  const more = sorted.length > maxGroups ? `; ${sorted.length - maxGroups} more kinds` : ""
  return `${rows.length} notice${rows.length === 1 ? "" : "s"} held for this digest: ${parts.join("; ")}${more}.`
}
