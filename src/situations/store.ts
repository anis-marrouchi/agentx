import type Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { getEventBus } from "@/events/bus"

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
//
// Old rows go on a write, at most once an hour (#1921): gate log rows and
// chat records untouched for 30 days. No timer of its own.
//
// Phase 2: the store is the one emit point. Every committed change emits
// one `situation:phase` bus event, after the row is written. A person can
// override the phase (`override`: end, not this, clear); a "not this" is
// kept on the record so the word list does not undo it.

export type Phase = "during" | "ending" | "ended"
export type EndReason = "closed" | "courtesy loop" | "stale" | "person"
export type Slot = "free" | "taken" | "used"
export type SetBy = "rule" | "person"
/** A person's override that the recogniser must not undo. */
export type Override = "not-this"
export type OverrideAction = "end" | "not-this" | "clear"

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
  /** Set by a person's "not this": closers no longer move the talk to
   *  `ending` until its phase changes another way. */
  override: Override | null
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
  /** The inbound message, for a release. Kept under GATE_MESSAGE_MAX. */
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
    CREATE INDEX IF NOT EXISTS idx_situations_phase_changed_at ON situations(phase_changed_at);
  `)
  // Phase 2 (#1892): a person's override. Added to tables made by phase 1.
  const cols = db.prepare("PRAGMA table_info(situations)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === "override")) db.exec("ALTER TABLE situations ADD COLUMN override TEXT")
}

const COLS = `id, key, template, phase, end_reason AS endReason, end_generation AS endGeneration,
  entered_at AS enteredAt, phase_changed_at AS phaseChangedAt, set_by AS setBy, why, slot,
  slot_by AS slotBy, owner_agent AS ownerAgent, override`

const LOG_COLS = `id, at, key, situation_id AS situationId, message_id AS messageId, channel,
  chat_id AS chatId, sender_id AS senderId, sender_name AS senderName, sender_kind AS senderKind,
  text, phase, outcome, reason, message, released_at AS releasedAt`

/** Gate log rows are kept this long. */
const LOG_KEEP_MS = 30 * 24 * 3600_000
/** A chat's record untouched this long is removed (#1921). Not shorter
 *  than the largest `maxAge.duringHours` (30 days): such a talk is stale
 *  anyway, and the next message on that chat starts a new record. */
export const SITUATION_KEEP_MS = 30 * 24 * 3600_000
/** Old rows are pruned on a write, at most this often. */
const PRUNE_EVERY_MS = 3600_000
/** The stored inbound message (JSON, for a release) stays under this many
 *  characters (#1921). */
export const GATE_MESSAGE_MAX = 16_000
const MESSAGE_TEXT_MAX = 4_000

/** Keep the stored message under GATE_MESSAGE_MAX and still JSON a release
 *  can read: clip the text fields first, then leave out the large optional
 *  parts, then keep only what a re-delivery needs. */
export function clipGateMessage(json: string): string {
  if (json.length <= GATE_MESSAGE_MAX) return json
  let m: Record<string, unknown>
  try { m = JSON.parse(json) as Record<string, unknown> } catch { return JSON.stringify({ clipped: true }) }
  const clip = (v: unknown) => (typeof v === "string" && v.length > MESSAGE_TEXT_MAX ? v.slice(0, MESSAGE_TEXT_MAX) : v)
  m = { ...m, text: clip(m.text), replyToText: clip(m.replyToText), clipped: true }
  let out = JSON.stringify(m)
  for (const big of ["channelMeta", "runbookFiles", "media", "replyToText"]) {
    if (out.length <= GATE_MESSAGE_MAX) return out
    delete m[big]
    out = JSON.stringify(m)
  }
  if (out.length <= GATE_MESSAGE_MAX) return out
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined)
  const sender = (m.sender ?? {}) as Record<string, unknown>
  const group = m.group as Record<string, unknown> | undefined
  return JSON.stringify({
    id: s(m.id, 300), channel: s(m.channel, 50), accountId: s(m.accountId, 200),
    sender: { id: s(sender.id, 300), name: s(sender.name, 120), ...(sender.isBot ? { isBot: true } : {}) },
    ...(group ? { group: { id: s(group.id, 300), name: s(group.name, 200) } } : {}),
    text: s(m.text, MESSAGE_TEXT_MAX) ?? "", timestamp: s(m.timestamp, 40), clipped: true,
  })
}

type StatementName =
  | "get" | "getById" | "byPrefix" | "list" | "listByAgent" | "remove" | "create" | "move" | "setOwner" | "takeSlot" | "freeSlot" | "logGate" | "gateRow"
  | "gateLog" | "gateLogByOutcome" | "markReleased" | "pruneLog" | "pruneSituations"

export class SituationStore {
  /** Prepared once (#1921): better-sqlite3 statements are reusable. */
  private readonly q: Record<StatementName, Database.Statement>
  private lastPrune = 0

  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    ensureSituationTables(db)
    this.q = {
      get: db.prepare(`SELECT ${COLS} FROM situations WHERE key = ?`),
      getById: db.prepare(`SELECT ${COLS} FROM situations WHERE id = ?`),
      // Ids are UUIDs: a prefix of hex digits and dashes needs no escaping.
      byPrefix: db.prepare(`SELECT ${COLS} FROM situations WHERE substr(id, 1, ?) = ? LIMIT 2`),
      list: db.prepare(`SELECT ${COLS} FROM situations ORDER BY phase_changed_at DESC LIMIT ?`),
      listByAgent: db.prepare(`SELECT ${COLS} FROM situations WHERE owner_agent = ? ORDER BY phase_changed_at DESC LIMIT ?`),
      remove: db.prepare("DELETE FROM situations WHERE key = ? AND phase_changed_at = ?"),
      create: db.prepare(
        `INSERT OR IGNORE INTO situations (id, key, phase, end_reason, entered_at, phase_changed_at, why, slot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      move: db.prepare(
        `UPDATE situations SET phase = ?, phase_changed_at = ?, why = ?, set_by = ?, end_reason = ?,
           end_generation = end_generation + ?, slot = ?, slot_by = NULL, override = ?
         WHERE key = ? AND phase = ? AND phase_changed_at = ?`,
      ),
      setOwner: db.prepare("UPDATE situations SET owner_agent = ? WHERE key = ? AND owner_agent IS NULL"),
      takeSlot: db.prepare("UPDATE situations SET slot = 'taken', slot_by = ? WHERE key = ? AND phase = 'ending' AND slot = 'free'"),
      freeSlot: db.prepare("UPDATE situations SET slot = 'free', slot_by = NULL WHERE key = ? AND slot = 'taken' AND slot_by = ?"),
      logGate: db.prepare(
        `INSERT INTO situation_gate_log (at, key, situation_id, message_id, channel, chat_id, sender_id, sender_name, sender_kind, text, phase, outcome, reason, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      gateRow: db.prepare(`SELECT ${LOG_COLS} FROM situation_gate_log WHERE id = ?`),
      gateLog: db.prepare(`SELECT ${LOG_COLS} FROM situation_gate_log ORDER BY id DESC LIMIT ?`),
      gateLogByOutcome: db.prepare(`SELECT ${LOG_COLS} FROM situation_gate_log WHERE outcome = ? ORDER BY id DESC LIMIT ?`),
      markReleased: db.prepare("UPDATE situation_gate_log SET released_at = ? WHERE id = ? AND released_at IS NULL"),
      pruneLog: db.prepare("DELETE FROM situation_gate_log WHERE at < ?"),
      pruneSituations: db.prepare("DELETE FROM situations WHERE phase_changed_at < ?"),
    }
  }

  get(key: string): SituationRow | null {
    return (this.q.get.get(key) as SituationRow | undefined) ?? null
  }

  /** First message on a chat: a record in `during` (or straight to
   *  `ending` when that first message is a closer). */
  create(key: string, phase: Phase, why: string, endReason?: EndReason): boolean {
    const at = this.now()
    this.prune(at)
    const r = this.q.create.run(randomUUID(), key, phase, phase === "ended" ? (endReason ?? "closed") : null, at, at, why, phase === "ended" ? "used" : "free")
    if (r.changes > 0) this.emitChange(key, null, why)
    return r.changes > 0
  }

  /** Move the phase, only if it is still `from` since `since` (S9).
   *  Leaving `ended` adds one to the end generation (a reopen). Each new
   *  phase starts with a free slot; an end marks it used. */
  move(key: string, from: { phase: Phase; since: number }, to: Phase, opts: { why: string; setBy?: SetBy; endReason?: EndReason; override?: Override }): boolean {
    const bump = from.phase === "ended" && to !== "ended" ? 1 : 0
    const r = this.q.move.run(to, Math.max(this.now(), from.since + 1), opts.why, opts.setBy ?? "rule", to === "ended" ? (opts.endReason ?? "closed") : null,
      bump, to === "ended" ? "used" : "free", opts.override ?? null, key, from.phase, from.since)
    if (r.changes > 0) this.emitChange(key, from.phase, opts.why)
    return r.changes > 0
  }

  /** The one emit point (3.3): after a committed write, one bus event.
   *  The envelope (ring buffer, mesh peers) names the phase only; `cause`,
   *  which may name a sender, reaches in-process listeners only. Never
   *  throws. */
  private emitChange(key: string, from: Phase | null, cause: string, cleared?: SituationRow): void {
    try {
      const r = cleared ?? this.get(key)
      if (!r) return
      const [channel, , ...chat] = key.split("|")
      getEventBus().emit("situation:phase", {
        situationId: r.id, key, channel, chatId: chat.join("|"), template: r.template,
        endGeneration: r.endGeneration, from, to: cleared ? "cleared" : r.phase,
        cause: cause.slice(0, 300), setBy: cleared ? "person" : r.setBy,
        ...(!cleared && r.phase === "ended" && r.endReason ? { endReason: r.endReason } : {}),
        ...(r.ownerAgent ? { agentId: r.ownerAgent } : {}),
        at: new Date(this.now()).toISOString(),
      })
    } catch { /* observability never breaks a write */ }
  }

  /** The routed agent owns the chat's record (3.2): set at the first
   *  match, never replaced. */
  claimOwner(key: string, agentId: string): boolean {
    return this.q.setOwner.run(agentId, key).changes > 0
  }

  /** A record by its id, a unique id prefix (6 characters or more), or
   *  its key. */
  resolve(ref: string): SituationRow | null {
    const r = String(ref ?? "").trim()
    if (!r) return null
    const byId = this.q.getById.get(r) as SituationRow | undefined
    if (byId) return byId
    if (r.includes("|")) return this.get(r)
    if (r.length < 6) return null
    const hits = this.q.byPrefix.all(r.length, r) as SituationRow[]
    return hits.length === 1 ? hits[0] : null
  }

  /** Newest change first. */
  list(opts: { agent?: string; limit?: number } = {}): SituationRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
    return (opts.agent ? this.q.listByAgent.all(opts.agent, limit) : this.q.list.all(limit)) as SituationRow[]
  }

  /** A person's override (design 8, "How a person overrides"), from the
   *  chip or the CLI, never from a chat message:
   *   end       → ended (reason "person")
   *   not-this  → during, and closers do not move it to ending again
   *   clear     → the record is removed; the next message starts a new one
   *  Every write is conditional on the phase read here (S9). */
  override(ref: string, action: OverrideAction, by: string): { ok: true; row: SituationRow | null } | { ok: false; status: number; error: string } {
    const row = this.resolve(ref)
    if (!row) return { ok: false, status: 404, error: `no situation ${String(ref).slice(0, 80)}` }
    const who = String(by || "a person").slice(0, 80)
    const since = { phase: row.phase, since: row.phaseChangedAt }
    const raced = { ok: false as const, status: 409, error: "the situation changed meanwhile; try again" }
    if (action === "clear") {
      if (this.q.remove.run(row.key, row.phaseChangedAt).changes === 0) return raced
      this.emitChange(row.key, row.phase, `cleared by ${who}`, row)
      return { ok: true, row: null }
    }
    if (action === "end") {
      if (row.phase === "ended") return { ok: false, status: 409, error: "this talk has already ended" }
      if (!this.move(row.key, since, "ended", { why: `ended by ${who}`, setBy: "person", endReason: "person" })) return raced
      return { ok: true, row: this.get(row.key) }
    }
    if (action === "not-this") {
      if (row.phase === "during" && row.override === "not-this") return { ok: true, row }
      if (!this.move(row.key, since, "during", { why: `${who} said this talk is not ending`, setBy: "person", override: "not-this" })) return raced
      return { ok: true, row: this.get(row.key) }
    }
    return { ok: false, status: 400, error: `unknown action ${String(action).slice(0, 40)}` }
  }

  /** A send that counts as a reply left for this chat. In `ending` it is
   *  the one goodbye: the slot is used and the talk is ended (closed). */
  noteSent(key: string, agentId?: string, opts: { asked?: boolean } = {}): boolean {
    const row = this.get(key)
    if (agentId && row && !row.ownerAgent) this.q.setOwner.run(agentId, key)
    if (!row || row.phase !== "ending") return false
    // A reply that asks something is not a goodbye: the answer to it must
    // reach the agent, so the talk goes on.
    if (opts.asked) return this.move(key, { phase: "ending", since: row.phaseChangedAt }, "during", { why: "our reply asked a question" })
    return this.move(key, { phase: "ending", since: row.phaseChangedAt }, "ended", { why: "the goodbye was sent", endReason: "closed" })
  }

  /** The goodbye turn starts: the slot is taken by `by` (S2). One SQLite
   *  update, so two turns cannot both take it. */
  takeSlot(key: string, by: string): boolean {
    return this.q.takeSlot.run(by, key).changes > 0
  }

  /** The turn that took the slot ended. Nothing was sent: free it again. */
  freeSlot(key: string, by: string): boolean {
    return this.q.freeSlot.run(key, by).changes > 0
  }

  logGate(row: Omit<GateLogRow, "id" | "at" | "releasedAt">): number {
    const at = this.now()
    this.prune(at)
    const r = this.q.logGate.run(at, row.key, row.situationId, row.messageId, row.channel, row.chatId, row.senderId, row.senderName.slice(0, 120),
      row.senderKind, row.text.slice(0, 500), row.phase, row.outcome, row.reason.slice(0, 500), clipGateMessage(row.message))
    return Number(r.lastInsertRowid)
  }

  /** Remove gate log rows and chat records past their keep time. Runs on
   *  a write, at most once an hour. */
  private prune(at: number): void {
    if (at - this.lastPrune < PRUNE_EVERY_MS) return
    this.lastPrune = at
    this.q.pruneLog.run(at - LOG_KEEP_MS)
    this.q.pruneSituations.run(at - SITUATION_KEEP_MS)
  }

  gateRow(id: number): GateLogRow | null {
    return (this.q.gateRow.get(id) as GateLogRow | undefined) ?? null
  }

  gateLog(opts: { limit?: number; outcome?: GateLogRow["outcome"] } = {}): GateLogRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
    return opts.outcome
      ? this.q.gateLogByOutcome.all(opts.outcome, limit) as GateLogRow[]
      : this.q.gateLog.all(limit) as GateLogRow[]
  }

  markReleased(id: number): boolean {
    return this.q.markReleased.run(this.now(), id).changes > 0
  }
}
