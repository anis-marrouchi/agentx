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
//
// Phase 4: closing steps. A record can carry `closing` (what the talk is
// about, where its note goes, who writes it). For such a record, after a
// committed change, the attached SituationRuns (runs.ts) starts the
// `situation-expiry` run of the new phase and, on an end, the
// `situation-close` run, and stores their run ids here with conditional
// writes (3.4, S13): the generation is written first (the move), then the
// run is started, then its id is stored.

export type Phase = "during" | "ending" | "ended"
export type EndReason = "closed" | "courtesy loop" | "stale" | "person"
export type Slot = "free" | "taken" | "used"
/** "peer": another organisation's agent said the talk ended (Q4). It may
 *  only make ours go quiet: such an end starts no closing steps. */
export type SetBy = "rule" | "person" | "peer"
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
  /** Closing steps for this talk (phase 4), or null: none. */
  closing: ClosingSlots | null
  /** The live `situation-expiry` run of the current phase (phase 4). */
  expiryRunId: string | null
  /** The `situation-close` run, and the end generation it belongs to. */
  closeRunId: string | null
  closeGeneration: number | null
}

/** What the closing steps of a talk need (design 3.1 slots, phase 4). Set
 *  by a person or a workflow step (`agentx situation closing`), never by
 *  a chat message. */
export interface ClosingSlots {
  /** What the talk is, in a few words: "job interview with a candidate". */
  purpose: string
  /** Where the note goes: an issue or merge request link, a wiki page. */
  home: string
  /** The agent that writes the note and owns the follow-ups. Default: the
   *  chat's agent. */
  agent?: string
  /** A message to the other side of the talk once it ended. Outward: the
   *  owner is always asked first (`outward: ask first`, fail closed). */
  message?: string
  /** The chat as its channel names it, for that message. The record's key
   *  holds a normalised id (a WhatsApp group id without its "@g.us"
   *  ending), which the channel cannot send to. */
  chatId?: string
  /** Other agents of this node that may own a follow-up of this talk.
   *  The talk's agent and the owner always may; anyone else named by the
   *  note's agent is not given the promise (the talk's agent keeps it). */
  agents?: string[]
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
  // Phase 4: closing steps and the runs the store started.
  for (const [name, type] of [["closing", "TEXT"], ["expiry_run_id", "TEXT"], ["close_run_id", "TEXT"], ["close_generation", "INTEGER"], ["note_at", "TEXT"], ["note_generation", "INTEGER"]]) {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE situations ADD COLUMN ${name} ${type}`)
  }
}

const COLS = `id, key, template, phase, end_reason AS endReason, end_generation AS endGeneration,
  entered_at AS enteredAt, phase_changed_at AS phaseChangedAt, set_by AS setBy, why, slot,
  slot_by AS slotBy, owner_agent AS ownerAgent, override, closing,
  expiry_run_id AS expiryRunId, close_run_id AS closeRunId, close_generation AS closeGeneration`

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
  | "get" | "getById" | "byPrefix" | "list" | "remove" | "create" | "move" | "setOwner" | "takeSlot" | "freeSlot" | "logGate" | "gateRow"
  | "gateLog" | "gateLogByOutcome" | "markReleased" | "pruneLog" | "pruneSituations"
  | "setClosing" | "setExpiryRun" | "setCloseRun" | "openWithClosing" | "endedWithClosing" | "noteFor" | "setNote"

/** A row as SQLite returns it: `closing` is JSON text. */
type RawRow = Omit<SituationRow, "closing"> & { closing: string | null }

function parseClosing(v: string | null): ClosingSlots | null {
  if (!v) return null
  try {
    const c = JSON.parse(v) as ClosingSlots
    return c && typeof c.purpose === "string" && typeof c.home === "string" ? c : null
  } catch { return null }
}

function toRow(r: RawRow | undefined): SituationRow | null {
  return r ? { ...r, closing: parseClosing(r.closing) } : null
}

/** Told after every committed change (the runs part, phase 4). `row` is
 *  the record after the write; for a cleared record, the record before. */
export type SituationChangeListener = (change: { row: SituationRow; from: Phase | null; cleared: boolean }) => void

export class SituationStore {
  /** Prepared once (#1921): better-sqlite3 statements are reusable. */
  private readonly q: Record<StatementName, Database.Statement>
  private lastPrune = 0
  private changeListener: SituationChangeListener | null = null

  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    ensureSituationTables(db)
    this.q = {
      get: db.prepare(`SELECT ${COLS} FROM situations WHERE key = ?`),
      getById: db.prepare(`SELECT ${COLS} FROM situations WHERE id = ?`),
      // Ids are UUIDs: a prefix of hex digits and dashes needs no escaping.
      byPrefix: db.prepare(`SELECT ${COLS} FROM situations WHERE substr(id, 1, ?) = ? LIMIT 2`),
      // NULL filters match every row.
      list: db.prepare(`SELECT ${COLS} FROM situations WHERE (@agent IS NULL OR owner_agent = @agent) AND (@phase IS NULL OR phase = @phase)
        ORDER BY phase_changed_at DESC LIMIT @limit`),
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
      // Steps set on an ended talk are for its next end: this end counts as
      // handled, so no close starts for it, not even after a restart.
      setClosing: db.prepare(`UPDATE situations SET closing = ?, template = ?,
        close_generation = CASE WHEN phase = 'ended' AND ? = 1 THEN end_generation ELSE close_generation END WHERE id = ?`),
      noteFor: db.prepare("SELECT note_at AS noteAt FROM situations WHERE id = ? AND note_generation = ?"),
      setNote: db.prepare("UPDATE situations SET note_at = ?, note_generation = ? WHERE id = ?"),
      // S9: only for the phase it was started for.
      setExpiryRun: db.prepare("UPDATE situations SET expiry_run_id = ? WHERE id = ? AND phase_changed_at = ?"),
      // One close per end generation (S3).
      setCloseRun: db.prepare(
        `UPDATE situations SET close_run_id = ?, close_generation = ?
         WHERE id = ? AND phase = 'ended' AND end_generation = ? AND close_generation IS NOT ?`,
      ),
      openWithClosing: db.prepare(`SELECT ${COLS} FROM situations WHERE phase != 'ended' AND closing IS NOT NULL`),
      endedWithClosing: db.prepare(`SELECT ${COLS} FROM situations WHERE phase = 'ended' AND closing IS NOT NULL AND phase_changed_at >= ?
        AND (close_generation IS NULL OR close_generation != end_generation)`),
    }
  }

  /** Attach the runs part (daemon start). Null detaches it. */
  onChange(fn: SituationChangeListener | null): void {
    this.changeListener = fn
  }

  get(key: string): SituationRow | null {
    return toRow(this.q.get.get(key) as RawRow | undefined)
  }

  getById(id: string): SituationRow | null {
    return toRow(this.q.getById.get(id) as RawRow | undefined)
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
   *  The envelope (ring buffer, mesh peers) names the channel, chat id and phase, like message:matched; `cause`,
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
    this.tellListener(cleared ?? this.get(key), from, !!cleared)
  }

  private tellListener(row: SituationRow | null, from: Phase | null, cleared: boolean): void {
    if (!row || !this.changeListener) return
    try { this.changeListener({ row, from, cleared }) } catch { /* the runs part never breaks a write */ }
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
    const byId = this.getById(r)
    if (byId) return byId
    if (r.includes("|")) return this.get(r)
    if (r.length < 6) return null
    const hits = this.q.byPrefix.all(r.length, r) as RawRow[]
    return hits.length === 1 ? toRow(hits[0]) : null
  }

  /** Newest change first. */
  list(opts: { agent?: string; phase?: Phase; limit?: number } = {}): SituationRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
    return (this.q.list.all({ agent: opts.agent ?? null, phase: opts.phase ?? null, limit }) as RawRow[]).map((r) => toRow(r)!)
  }

  // --- Phase 4: closing steps ---

  /** Give a talk closing steps (or remove them with null). `template`
   *  names the kind of talk, for example "meeting". The runs part is told,
   *  so the expiry run of the current phase starts at once. */
  setClosing(id: string, closing: ClosingSlots | null, template?: string): SituationRow | null {
    const row = this.getById(id)
    if (!row) return null
    // Steps given to an ended talk that had none: this end is marked handled.
    const fresh = closing && !row.closing ? 1 : 0
    this.q.setClosing.run(closing ? JSON.stringify(closing) : null, (template || row.template).slice(0, 40), fresh, id)
    const after = this.getById(id)
    this.tellListener(after, after?.phase ?? null, false)
    return after
  }

  /** The link of the closing note already posted for end generation
   *  `gen`. Null: none yet. */
  noteFor(id: string, gen: number): string | null {
    const r = this.q.noteFor.get(id, gen) as { noteAt: string | null } | undefined
    return r?.noteAt ?? null
  }

  /** Record that the closing note of end generation `gen` was posted. */
  setNote(id: string, gen: number, link: string): void {
    this.q.setNote.run(link, gen, id)
  }

  /** Store the expiry run started for the phase that changed at
   *  `phaseChangedAt`. False: the phase moved meanwhile (cancel the run). */
  setExpiryRun(id: string, phaseChangedAt: number, runId: string): boolean {
    return this.q.setExpiryRun.run(runId, id, phaseChangedAt).changes > 0
  }

  /** Store the close run of end generation `gen`. False: the talk is not
   *  ended in that generation, or a close for it is already stored. */
  setCloseRun(id: string, gen: number, runId: string): boolean {
    return this.q.setCloseRun.run(runId, gen, id, gen, gen).changes > 0
  }

  /** The `situation-expiry` run's step: end the talk as stale, only if
   *  its phase has not changed since the run started (S9). A missed
   *  cancel is harmless. */
  expire(id: string, phaseChangedAt: number): { ended: boolean; why: string } {
    const row = this.getById(id)
    if (!row) return { ended: false, why: "the record is gone" }
    if (row.phase === "ended") return { ended: false, why: "the talk has already ended" }
    if (row.phaseChangedAt !== phaseChangedAt) return { ended: false, why: "the phase changed since this run started" }
    const ok = this.move(row.key, { phase: row.phase, since: row.phaseChangedAt }, "ended", { why: `no change for longer than the ${row.phase} phase's max age`, endReason: "stale" })
    return ok ? { ended: true, why: "ended as stale" } : { ended: false, why: "the phase changed meanwhile" }
  }

  /** Open talks with closing steps (S14: their expiry runs at start). */
  openWithClosing(): SituationRow[] {
    return (this.q.openWithClosing.all() as RawRow[]).map((r) => toRow(r)!)
  }

  /** Talks with closing steps that ended since `since` and have no close
   *  run for that end yet (a close missed while the daemon was down). */
  endedWithClosing(since: number): SituationRow[] {
    return (this.q.endedWithClosing.all(since) as RawRow[]).map((r) => toRow(r)!)
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
