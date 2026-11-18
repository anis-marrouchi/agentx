import type Database from "better-sqlite3"
import { randomUUID } from "crypto"

// --- The situation record and the gate log (#1892, phase 1) ---
//
// One row per chat (key: situationKey). Phase 1 knows one template,
// `conversation`, with three phases: during → ending → ended. The row holds
// only what has no other home: phase, why, the end generation and the reply
// slot. Only this store writes it. Every phase write is conditional on the
// phase and the time it last changed (S9): a write that matches no row
// lost a race and does nothing.
//
// The gate log keeps every message the gate dropped (active mode) or would
// have dropped (shadow mode), with the message itself so a person can
// re-deliver a wrong drop (`agentx situation release <id>`).

export type Phase = "during" | "ending" | "ended"
export type EndReason = "closed" | "courtesy loop" | "stale" | "person"
export type Slot = "free" | "taken" | "used"
export type SetBy = "rule" | "person"

export interface SituationRow {
  id: string
  key: string
  template: string
  phase: Phase
  endReason: EndReason | null
  endGeneration: number
  enteredAt: number
  phaseChangedAt: number
  setBy: SetBy
  why: string
  slot: Slot
  slotBy: string | null
  ownerAgent: string | null
}

export interface GateLogRow {
  id: number
  at: number
  key: string
  situationId: string | null
  messageId: string
  channel: string
  chatId: string
  senderId: string
  senderName: string
  senderKind: "person" | "bot" | "agent"
  text: string
  phase: string
  outcome: "drop" | "would-drop"
  reason: string
  /** The inbound message, for a release. Text clipped. */
  message: string
  releasedAt: number | null
}

export function ensureSituationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS situations (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      template TEXT NOT NULL DEFAULT 'conversation',
      phase TEXT NOT NULL,
      end_reason TEXT,
      end_generation INTEGER NOT NULL DEFAULT 0,
      entered_at INTEGER NOT NULL,
      phase_changed_at INTEGER NOT NULL,
      set_by TEXT NOT NULL DEFAULT 'rule',
      why TEXT NOT NULL DEFAULT '',
      slot TEXT NOT NULL DEFAULT 'free',
      slot_by TEXT,
      owner_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS situation_gate_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      key TEXT NOT NULL,
      situation_id TEXT,
      message_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL DEFAULT '',
      sender_kind TEXT NOT NULL,
      text TEXT NOT NULL,
      phase TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      message TEXT NOT NULL,
      released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_situation_gate_log_at ON situation_gate_log(at);
  `)
}

const COLS = `id, key, template, phase, end_reason AS endReason, end_generation AS endGeneration,
  entered_at AS enteredAt, phase_changed_at AS phaseChangedAt, set_by AS setBy, why, slot,
  slot_by AS slotBy, owner_agent AS ownerAgent`

const LOG_COLS = `id, at, key, situation_id AS situationId, message_id AS messageId, channel,
  chat_id AS chatId, sender_id AS senderId, sender_name AS senderName, sender_kind AS senderKind,
  text, phase, outcome, reason, message, released_at AS releasedAt`

/** Gate log rows are kept this long. */
const LOG_KEEP_MS = 30 * 24 * 3600_000

export class SituationStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    ensureSituationTables(db)
  }

  get(key: string): SituationRow | null {
    return (this.db.prepare(`SELECT ${COLS} FROM situations WHERE key = ?`).get(key) as SituationRow | undefined) ?? null
  }

  /** First message on a chat: a record in `during` (or straight to
   *  `ending` when that first message is a closer). */
  create(key: string, phase: Phase, why: string, endReason?: EndReason): boolean {
    const at = this.now()
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO situations (id, key, phase, end_reason, entered_at, phase_changed_at, why, slot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), key, phase, phase === "ended" ? (endReason ?? "closed") : null, at, at, why, phase === "ended" ? "used" : "free")
    return r.changes > 0
  }

  /** Move the phase, only if it is still `from` since `since` (S9).
   *  Leaving `ended` adds one to the end generation (a reopen). Each new
   *  phase starts with a free slot; an end marks it used. */
  move(key: string, from: { phase: Phase; since: number }, to: Phase, opts: { why: string; setBy?: SetBy; endReason?: EndReason }): boolean {
    const bump = from.phase === "ended" && to !== "ended" ? 1 : 0
    const r = this.db.prepare(
      `UPDATE situations SET phase = ?, phase_changed_at = ?, why = ?, set_by = ?, end_reason = ?,
         end_generation = end_generation + ?, slot = ?, slot_by = NULL
       WHERE key = ? AND phase = ? AND phase_changed_at = ?`,
    ).run(to, Math.max(this.now(), from.since + 1), opts.why, opts.setBy ?? "rule", to === "ended" ? (opts.endReason ?? "closed") : null,
      bump, to === "ended" ? "used" : "free", key, from.phase, from.since)
    return r.changes > 0
  }

  /** A send that counts as a reply left for this chat. In `ending` it is
   *  the one goodbye: the slot is used and the talk is ended (closed). */
  noteSent(key: string, agentId?: string): boolean {
    const row = this.get(key)
    if (agentId && row && !row.ownerAgent) this.db.prepare("UPDATE situations SET owner_agent = ? WHERE key = ? AND owner_agent IS NULL").run(agentId, key)
    if (!row || row.phase !== "ending") return false
    return this.move(key, { phase: "ending", since: row.phaseChangedAt }, "ended", { why: "the goodbye was sent", endReason: "closed" })
  }

  /** The goodbye turn starts: the slot is taken by `by` (S2). One SQLite
   *  update, so two turns cannot both take it. */
  takeSlot(key: string, by: string): boolean {
    return this.db.prepare("UPDATE situations SET slot = 'taken', slot_by = ? WHERE key = ? AND phase = 'ending' AND slot = 'free'").run(by, key).changes > 0
  }

  /** The turn that took the slot ended. Nothing was sent: free it again. */
  freeSlot(key: string, by: string): boolean {
    return this.db.prepare("UPDATE situations SET slot = 'free', slot_by = NULL WHERE key = ? AND slot = 'taken' AND slot_by = ?").run(key, by).changes > 0
  }

  logGate(row: Omit<GateLogRow, "id" | "at" | "releasedAt">): number {
    const at = this.now()
    const r = this.db.prepare(
      `INSERT INTO situation_gate_log (at, key, situation_id, message_id, channel, chat_id, sender_id, sender_name, sender_kind, text, phase, outcome, reason, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(at, row.key, row.situationId, row.messageId, row.channel, row.chatId, row.senderId, row.senderName.slice(0, 120),
      row.senderKind, row.text.slice(0, 500), row.phase, row.outcome, row.reason, row.message)
    const id = Number(r.lastInsertRowid)
    if (id % 200 === 0) this.db.prepare("DELETE FROM situation_gate_log WHERE at < ?").run(at - LOG_KEEP_MS)
    return id
  }

  gateRow(id: number): GateLogRow | null {
    return (this.db.prepare(`SELECT ${LOG_COLS} FROM situation_gate_log WHERE id = ?`).get(id) as GateLogRow | undefined) ?? null
  }

  gateLog(opts: { limit?: number; outcome?: GateLogRow["outcome"] } = {}): GateLogRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
    return opts.outcome
      ? this.db.prepare(`SELECT ${LOG_COLS} FROM situation_gate_log WHERE outcome = ? ORDER BY id DESC LIMIT ?`).all(opts.outcome, limit) as GateLogRow[]
      : this.db.prepare(`SELECT ${LOG_COLS} FROM situation_gate_log ORDER BY id DESC LIMIT ?`).all(limit) as GateLogRow[]
  }

  markReleased(id: number): boolean {
    return this.db.prepare("UPDATE situation_gate_log SET released_at = ? WHERE id = ? AND released_at IS NULL").run(this.now(), id).changes > 0
  }
}
