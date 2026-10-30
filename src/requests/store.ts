import type Database from "better-sqlite3"
import { ensureColumns, PERSON_COLUMNS } from "@/storage/sqlite"
import { readCloseWhen, type CloseWhen } from "./checkers"
import type { Proof } from "./promise"
import type { QaFilter, QaRecord, QaVerdict } from "./qa"
import type { GoalRequest, GoalSummary, RequestGoal } from "./goals"

// --- Open requests: what a person asked for that is not finished (#356) ---
//
// One row per request a person made to an agent, kept until someone closes
// it. A turn from a person starts as a `candidate`; it becomes an open
// request when the turn leaves work behind (a delegation, a failure, a
// restart) or the agent says so. A candidate whose turn simply answered
// and ended is deleted.
//
// The store is plain sqlite in .agentx/db.sqlite. Every call is one small
// synchronous statement: nothing here calls a model or waits on I/O.

export type OpenState = "in_progress" | "waiting_owner" | "waiting_other" | "needs_attention"
export type ClosedState = "done" | "declined" | "dropped"
export type RequestState = "candidate" | OpenState | ClosedState

export const OPEN_STATES: readonly OpenState[] = ["in_progress", "waiting_owner", "waiting_other", "needs_attention"]
export const CLOSED_STATES: readonly ClosedState[] = ["done", "declined", "dropped"]

export type LinkKind = "run" | "step_run" | "delegation" | "card" | "workflow" | "watcher" | "comment" | HomeLinkKind

/** The channel of a post the owner wrote on the Wall (#1355). */
export const WALL_CHANNEL = "wall"

/** Longest owner comment kept on a request (#1316). */
export const COMMENT_MAX = 4000

/** Where the work of a request lives (#394): the issue, idea file,
 *  approval, ERP record or Desk card the agent named. The latest is kept
 *  in two columns; every home but a Desk card is also a request link, so
 *  one request keeps all its homes and byLink traces an issue back to its
 *  request. Links are unique per (kind, ref): when two requests land on
 *  one issue, the link stays with the first, the column holds both. A Desk
 *  card is a column only: "card" links are approval cards (tracker). */
export const HOME_KINDS = ["issue", "idea", "approval", "erp", "card"] as const
export type HomeKind = (typeof HOME_KINDS)[number]
export const HOME_LINK_KINDS = ["issue", "idea", "approval", "erp"] as const
export type HomeLinkKind = (typeof HOME_LINK_KINDS)[number]
export interface RequestHome { kind: HomeKind; link: string }
export const HOME_LINK_MAX = 500

/** What the last run of a loop's checker said (#1039). */
export type VerifyState = "verified" | "unverified" | "failed"

/** Who a loop is owed to: the owner, an agent id, or a known person id. */
export const OWED_TO_OWNER = "owner"

export interface RequestRecord {
  id: string
  state: RequestState
  channel: string
  chatId: string
  sender: string | null
  /** The known person who asked (people, #384), when the sender is one. */
  person: string | null
  agentId: string
  /** The request in the person's words. */
  text: string
  createdAt: number
  /** Last time anything happened under this request. */
  updatedAt: number
  /** Last time its state changed (#1100): what the Desk shows as "changed".
   *  A run starting or ending is activity, not a change. Null on rows from
   *  before the column. */
  stateChangedAt: number | null
  /** Why it needs attention, in words. */
  attentionReason: string | null
  /** When the owner was told it needs attention. Told once. */
  notifiedAt: number | null
  /** What the owner is being asked, while waiting on them. */
  question: string | null
  closedAt: number | null
  /** Link to the proof of a finished request (PR, issue, message, deploy). */
  evidence: string | null
  /** Why it was declined or dropped. */
  closeReason: string | null
  /** What the owner last wrote on it (a reply, or a note with a hand-off). */
  ownerNote: string | null
  /** That note was given to the agent in a pick-up: it is not said again. */
  noteSaid: boolean
  /** The agent it was asked of, once the owner handed it on. The chat it
   *  was asked in is that agent's: another agent may not be able to write
   *  there (#481). Null: never handed on. */
  askedAgent: string | null
  /** Where the work lives, once the agent named it (#394). */
  home: RequestHome | null
  // --- The open loop (#1039). Null on requests from before it. ---
  /** Who it is owed to: "owner", an agent id, or a known person id. A
   *  request from the owner's turn is owed to its sender. */
  owedTo: string | null
  /** An agent's promise (action promise), not a turn of the owner's. */
  promise: boolean
  /** When it is due, epoch ms. Past it, the loop is stalled. */
  dueAt: number | null
  /** What proves it is finished: the checker the requests check runs. */
  closeWhen: CloseWhen | null
  /** When the checker last ran, and what it said. */
  checkedAt: number | null
  verifiedAt: number | null
  verifyState: VerifyState | null
  /** The checker's last words: its evidence, or why it could not say. */
  verifyDetail: string | null
  /** What the agent said the work is when it accepted (#1048): its kind
   *  (code, research…) and its estimate in minutes. Kept for the plan
   *  gate and for audit. */
  work: string | null
  estimateMinutes: number | null
  /** The first `work` and `estimateMinutes` the agent declared. A later
   *  accept can change the two above; these stay, so a change of mind
   *  after a refused accept shows in the audit. */
  firstWork: string | null
  firstEstimateMinutes: number | null
  // --- What it is, for the owner's eyes (#1126). Null until written. ---
  /** A few words that say what the request is: the title of its card,
   *  its push and its Desk line. The owner's own words stay in `text`. */
  headline: string | null
  /** The one thing needed from the owner, or "nothing, just so you know". */
  need: string | null
  /** Who wrote them: the agent, or the daemon's one model call when the
   *  agent did not. An agent's words are never replaced by the model's. */
  headlineBy: "agent" | "model" | null
  /** When the daemon last asked the model for a headline: each request
   *  is asked once, across restarts. */
  headlineTriedAt: number | null
  // --- One Promise (#1138 D). Null on requests from before it. ---
  /** Who owes it when it is not its agent: "owner" for a decision card. */
  owedBy: string | null
  /** The typed proof it closed with: a link, a test, an output or a check. */
  proof: Proof | null
  /** The wiki fact its close wrote (`agentx wiki facts show <id>`). */
  factId: string | null
  // --- QA sign-off (#1188). Null on requests from before it. ---
  /** When it was last marked as needing QA. Null: not marked. */
  qaRequestedAt: number | null
  /** The latest verdict, with who gave it and when. */
  qa: QaRecord | null
  // --- Goal (#1168). Null: the request names none. ---
  /** The goal the agent said it serves when it accepted. */
  goal: RequestGoal | null
  /** When the requests check sent it back to its agent on its own, after
   *  a usage limit or a restart stopped it (#1542). Once per request. */
  resentAt: number | null
}

const PROOF_KIND_NAMES: readonly string[] = ["link", "test", "output", "check"]

/** A stored proof, or null when there is none or it does not read. */
export function readProof(raw: unknown): Proof | null {
  if (typeof raw !== "string" || !raw) return null
  try {
    const p = JSON.parse(raw)
    return p && PROOF_KIND_NAMES.includes(p.kind) && typeof p.value === "string" && typeof p.ranAt === "number" ? p : null
  } catch {
    return null
  }
}

/** The first web link in an answer: what a delegate gave as its proof
 *  (a PR, an issue, a deploy page). Null when it gave none. */
export function firstLink(text: string): string | null {
  const m = /https?:\/\/[^\s<>"'`]+/i.exec(text ?? "")
  if (!m) return null
  let link = m[0].replace(/[.,;:!?\]*_]+$/, "")
  // A closing parenthesis is the link's own only when it opened one.
  while (link.endsWith(")") && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) link = link.slice(0, -1).replace(/[.,;:!?\]*_]+$/, "")
  return link
}

export const TEXT_MAX = 4000
const REASON_MAX = 500

/** Creates the tables when missing. Named, not numbered, so it cannot
 *  clash with a migration number another branch claimed. */
export function ensureRequestTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender TEXT,
      agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attention_reason TEXT,
      notified_at INTEGER,
      question TEXT,
      closed_at INTEGER,
      evidence TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_state_created ON requests(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_chat ON requests(agent_id, channel, chat_id, created_at);
    CREATE TABLE IF NOT EXISTS request_links (
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (kind, ref),
      FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_request_links_request ON request_links(request_id);
    CREATE TABLE IF NOT EXISTS request_verdicts (
      request_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      by_agent TEXT NOT NULL,
      at INTEGER NOT NULL,
      note TEXT,
      FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_request_verdicts_request ON request_verdicts(request_id, at);
  `)
  ensureColumns(db, "requests", PERSON_COLUMNS)
  ensureColumns(db, "requests", [["state_changed_at", "INTEGER"]])
  // How a delegation ended, and the link its answer gave (#1138).
  ensureColumns(db, "request_links", [["ended", "TEXT"], ["ended_at", "INTEGER"], ["proof", "TEXT"]])
  // Who a delegation went to (#1522): a later one to the same agent that
  // came back done is the retry of one that failed.
  ensureColumns(db, "request_links", [["agent", "TEXT"]])
  // When the owner last sent it back (reply, hand-off, pick-up, reopen,
  // #1522): a home closed before that does not close it.
  ensureColumns(db, "requests", [["sent_back_at", "INTEGER"]])
  // When the requests check resent it on its own (#1542): once, ever.
  ensureColumns(db, "requests", [["resent_at", "INTEGER"]])
  // Added after the first version: a database that already has the table
  // gets the columns here.
  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
  for (const [name, type] of [["pickup_at", "INTEGER"], ["owner_note", "TEXT"], ["note_said", "INTEGER"], ["asked_agent", "TEXT"], ["home_kind", "TEXT"], ["home_link", "TEXT"],
    ["owed_to", "TEXT"], ["promise", "INTEGER"], ["due_at", "INTEGER"], ["close_when", "TEXT"], ["checked_at", "INTEGER"],
    ["verified_at", "INTEGER"], ["verify_state", "TEXT"], ["verify_detail", "TEXT"],
    ["work", "TEXT"], ["estimate_minutes", "REAL"], ["first_work", "TEXT"], ["first_estimate_minutes", "REAL"],
    ["headline", "TEXT"], ["need", "TEXT"], ["headline_by", "TEXT"], ["headline_tried_at", "INTEGER"],
    ["owed_by", "TEXT"], ["proof", "TEXT"], ["fact_id", "TEXT"],
    ["qa_requested_at", "INTEGER"], ["qa_verdict", "TEXT"], ["qa_by", "TEXT"], ["qa_at", "INTEGER"], ["qa_note", "TEXT"],
    ["goal_id", "TEXT"], ["goal_title", "TEXT"]]) {
    if (cols.some((c) => c.name === name)) continue
    try {
      db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`)
    } catch (e: any) {
      // Daemon and dashboard starting together: the other one added it first.
      if (!/duplicate column name/i.test(String(e?.message))) throw e
    }
  }
}

/** For readers: a database without the table has no requests, and reading
 *  it must not create one. */
export function hasRequestTables(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()
}

function toRecord(r: any): RequestRecord {
  return {
    id: r.id, state: r.state, channel: r.channel, chatId: r.chat_id, sender: r.sender ?? null, person: r.person ?? null,
    agentId: r.agent_id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at, stateChangedAt: r.state_changed_at ?? null,
    attentionReason: r.attention_reason ?? null, notifiedAt: r.notified_at ?? null,
    question: r.question ?? null, closedAt: r.closed_at ?? null,
    evidence: r.evidence ?? null, closeReason: r.close_reason ?? null, ownerNote: r.owner_note ?? null, noteSaid: !!r.note_said,
    askedAgent: r.asked_agent ?? null,
    home: r.home_kind && r.home_link ? { kind: r.home_kind, link: r.home_link } : null,
    owedTo: r.owed_to ?? null, promise: !!r.promise, dueAt: r.due_at ?? null, closeWhen: readCloseWhen(r.close_when),
    checkedAt: r.checked_at ?? null, verifiedAt: r.verified_at ?? null, verifyState: r.verify_state ?? null, verifyDetail: r.verify_detail ?? null,
    work: r.work ?? null, estimateMinutes: r.estimate_minutes ?? null,
    firstWork: r.first_work ?? null, firstEstimateMinutes: r.first_estimate_minutes ?? null,
    headline: r.headline ?? null, need: r.need ?? null, headlineBy: r.headline_by === "agent" || r.headline_by === "model" ? r.headline_by : null,
    headlineTriedAt: r.headline_tried_at ?? null,
    owedBy: r.owed_by ?? null, proof: readProof(r.proof), factId: r.fact_id ?? null,
    qaRequestedAt: r.qa_requested_at ?? null,
    qa: r.qa_verdict && r.qa_by && typeof r.qa_at === "number" ? { verdict: r.qa_verdict, by: r.qa_by, at: r.qa_at, note: r.qa_note ?? null } : null,
    goal: r.goal_id && r.goal_title ? { id: r.goal_id, title: r.goal_title } : null,
    resentAt: r.resent_at ?? null,
  }
}

/** Goals shown, and requests read for them (#1168). */
export const GOALS_MAX = 50
const GOAL_REQUESTS_MAX = 2000
/** Requests listed under one goal. */
const GOAL_LIST_MAX = 50

const placeholders = (n: number) => Array(n).fill("?").join(",")

/** WHERE clause of a request waiting on QA (qa.ts awaitingQa). */
const AWAITING_QA = "qa_requested_at IS NOT NULL AND (qa_at IS NULL OR qa_at < qa_requested_at)"

/** How the quiet check words a request raised for being past its due
 *  time. Settling reads it back (#1214). */
export const OVERDUE_REASON = "Past its due time"

/** How the tracker words a request raised for a hand-off that failed,
 *  timed out or was lost. Settling reads it back once its retry came
 *  back done (#1520). */
export const HANDOFF_REASON = "The work handed to "

/** A request whose handed-on work all came back done (#1138). A hand-off
 *  that failed, timed out or was lost counts for nothing once one handed
 *  to the same agent after it ended came back done: that was its retry
 *  (#1522). Two running side by side are not each other's retry, lost or
 *  not: they may be two different parts (#1520). One still out, waiting,
 *  from before endings were kept, or to another agent holds it. */
const CAME_BACK = `r.close_when IS NULL AND COALESCE(r.promise, 0) = 0 AND r.pickup_at IS NULL
  AND EXISTS (SELECT 1 FROM request_links l WHERE l.request_id = r.id AND l.kind = 'delegation' AND l.ended = 'done')
  AND NOT EXISTS (SELECT 1 FROM request_links l WHERE l.request_id = r.id AND l.kind = 'delegation'
                  AND (l.ended IS NULL OR l.ended NOT IN ('done', 'superseded'))
                  AND NOT (l.ended IN ('error', 'lost', 'timeout') AND l.agent IS NOT NULL AND EXISTS (
                    SELECT 1 FROM request_links d WHERE d.request_id = r.id AND d.kind = 'delegation' AND d.ended = 'done'
                      AND d.agent = l.agent AND d.at > l.ended_at)))
  AND NOT EXISTS (SELECT 1 FROM request_links l WHERE l.request_id = r.id AND l.kind = 'workflow')`

/** Needs attention for a reason settling clears once the handed work came
 *  back: past its due time (#1214), or a hand-off that did not end done
 *  (#1520). */
const settleableAttention = (col: string) => `(${col} LIKE '${OVERDUE_REASON}%' OR ${col} LIKE '${HANDOFF_REASON}%')`

/** SET clause for a statement that writes `state`: the change time moves
 *  only when the state is really different. Takes the new state, then now. */
const STATE_CHANGED = "state_changed_at = CASE WHEN state IS ? THEN state_changed_at ELSE ? END"

export class RequestStore {
  constructor(private db: Database.Database) {
    ensureRequestTables(db)
    db.pragma("foreign_keys = ON")
  }

  /** Note a turn a person started. Linked to its run. */
  addCandidate(input: {
    id: string; runId: string; channel: string; chatId: string; sender?: string | null
    person?: string | null; agentId: string; text: string; now: number
  }): void {
    // Owed to whoever asked: the known person, else the sender (#1039).
    const owedTo = input.person ?? input.sender ?? null
    this.db.prepare(
      `INSERT OR IGNORE INTO requests (id, state, channel, chat_id, sender, person, agent_id, text, created_at, updated_at, state_changed_at, owed_to)
       VALUES (?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.channel, input.chatId, input.sender ?? null, input.person ?? null, input.agentId, input.text.slice(0, TEXT_MAX), input.now, input.now, input.now, owedTo)
    this.link(input.id, "run", input.runId, input.now)
  }

  /** An agent's promise (#1039): open at once, in progress, owed to
   *  `owedTo`. The chat is the one of the turn that made it. */
  addPromise(input: {
    id: string; channel: string; chatId: string; agentId: string; text: string; owedTo: string
    owedBy?: string | null; dueAt?: number | null; closeWhen?: CloseWhen | null; home?: RequestHome | null; now: number
  }): void {
    this.db.prepare(
      `INSERT INTO requests (id, state, channel, chat_id, agent_id, text, created_at, updated_at, state_changed_at, owed_to, owed_by, promise, due_at, close_when, home_kind, home_link)
       VALUES (?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      input.id, input.channel, input.chatId, input.agentId, input.text.slice(0, TEXT_MAX), input.now, input.now, input.now, input.owedTo,
      input.owedBy ?? null, input.dueAt ?? null, input.closeWhen ? JSON.stringify(input.closeWhen) : null,
      input.home?.kind ?? null, input.home ? input.home.link.slice(0, HOME_LINK_MAX) : null,
    )
    if (input.home) this.linkHome(input.id, input.home, input.now)
  }

  /** A post the owner wrote on the Wall (#1355): open at once, in
   *  progress, owed to the owner, and marked for pick-up, so the daemon's
   *  requests check gives it to the agent as a new turn. */
  addWallPost(input: { id: string; agentId: string; text: string; now: number }): void {
    this.db.prepare(
      `INSERT INTO requests (id, state, channel, chat_id, sender, agent_id, text, created_at, updated_at, state_changed_at, owed_to, pickup_at)
       VALUES (?, 'in_progress', ?, 'owner', 'owner', ?, ?, ?, ?, ?, 'owner', ?)`,
    ).run(input.id, WALL_CHANNEL, input.agentId, input.text.slice(0, TEXT_MAX), input.now, input.now, input.now, input.now)
  }

  /** How many open promises this agent holds. */
  openPromises(agentId: string): number {
    return (this.db.prepare(
      `SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND promise = 1 AND state IN (${placeholders(OPEN_STATES.length)})`,
    ).get(agentId, ...OPEN_STATES) as { n: number }).n
  }

  /** Did this agent open a promise in this chat since `since`? */
  promisedInChat(agentId: string, channel: string, chatId: string, since: number): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM requests WHERE agent_id = ? AND channel = ? AND chat_id = ? AND promise = 1 AND created_at >= ? LIMIT 1",
    ).get(agentId, channel, chatId, since)
  }

  /** Give an open request a due time or a checker, from accept or wait. */
  setLoop(id: string, loop: { dueAt?: number | null; closeWhen?: CloseWhen | null }, now: number): void {
    if (loop.dueAt !== undefined) this.db.prepare("UPDATE requests SET due_at = ?, updated_at = ? WHERE id = ?").run(loop.dueAt, now, id)
    if (loop.closeWhen !== undefined) {
      this.db.prepare("UPDATE requests SET close_when = ?, verify_state = NULL, verify_detail = NULL, updated_at = ? WHERE id = ?")
        .run(loop.closeWhen ? JSON.stringify(loop.closeWhen) : null, now, id)
    }
  }

  /** What the agent declared about the work on accept (#1048). Only the
   *  fields given are written; the first value of each is kept too.
   *  Not a touch: a refused accept is not progress. */
  setWork(id: string, w: { work?: string; estimateMinutes?: number }): void {
    if (w.work !== undefined) {
      this.db.prepare("UPDATE requests SET work = ?, first_work = COALESCE(first_work, ?) WHERE id = ?").run(w.work, w.work, id)
    }
    if (w.estimateMinutes !== undefined) {
      this.db.prepare("UPDATE requests SET estimate_minutes = ?, first_estimate_minutes = COALESCE(first_estimate_minutes, ?) WHERE id = ?")
        .run(w.estimateMinutes, w.estimateMinutes, id)
    }
  }

  /** What the request is, in the owner's terms (#1126). The agent's words
   *  always win; the model's only fill a request that has none, so a late
   *  model answer never replaces what the agent said meanwhile. A field
   *  left undefined is kept. Not a touch: describing is not progress. */
  setHeadline(id: string, h: { headline?: string; need?: string }, by: "agent" | "model"): boolean {
    if (h.headline === undefined && h.need === undefined) return false
    const guard = by === "model" ? " AND headline IS NULL" : ""
    // headline_by says who wrote the headline: a need alone does not change it.
    return this.db.prepare(
      `UPDATE requests SET headline = COALESCE(?, headline), need = COALESCE(?, need),
         headline_by = CASE WHEN ? IS NULL THEN headline_by ELSE ? END WHERE id = ?${guard}`,
    ).run(h.headline ?? null, h.need ?? null, h.headline ?? null, by, id).changes > 0
  }

  /** Open requests the owner may see that have no headline yet and were
   *  not tried, newest first: the ones the daemon writes one for. */
  withoutHeadline(limit = 20): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(OPEN_STATES.length)}) AND headline IS NULL AND headline_tried_at IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...OPEN_STATES, limit).map(toRecord)
  }

  /** Claim the one model call for this request's headline. True for the
   *  caller that got it; false when another caller already did, so two
   *  passes working from older copies never both pay for it. */
  markHeadlineTried(id: string, now: number): boolean {
    return this.db.prepare("UPDATE requests SET headline_tried_at = ? WHERE id = ? AND headline_tried_at IS NULL").run(now, id).changes > 0
  }

  /** The goal the request serves (#1168), from accept. A later accept
   *  with another goal moves it. Not a touch: naming a goal is not progress. */
  setGoal(id: string, goal: RequestGoal): void {
    this.db.prepare("UPDATE requests SET goal_id = ?, goal_title = ? WHERE id = ?").run(goal.id, goal.title, id)
  }

  /** Every goal a request names (#1168), most recently active first: its
   *  requests open and closed alike (closed ones until they age out), and
   *  the cost of the runs linked to them. Cost needs the task traces; a
   *  database without them sums nothing. */
  goals(limit = GOALS_MAX): GoalSummary[] {
    const rows = this.db.prepare(
      `SELECT * FROM requests WHERE goal_id IS NOT NULL AND state != 'candidate' ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    ).all(GOAL_REQUESTS_MAX).map(toRecord)
    const cost = new Map<string, { usd: number | null; runs: number; unpriced: number }>()
    try {
      const priced = this.db.prepare(
        `SELECT l.request_id AS id, SUM(t.cost_usd) AS usd, COUNT(*) AS runs, SUM(CASE WHEN t.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM request_links l JOIN requests r ON r.id = l.request_id JOIN task_traces t ON t.task_id = l.ref
         WHERE l.kind IN ('run', 'step_run') AND r.goal_id IS NOT NULL GROUP BY l.request_id`,
      ).all() as Array<{ id: string; usd: number | null; runs: number; unpriced: number }>
      for (const p of priced) cost.set(p.id, p)
    } catch {
      // No task traces in this database: no cost to show.
    }
    const byGoal = new Map<string, GoalSummary>()
    for (const r of rows) {
      const goal = r.goal!
      let g = byGoal.get(goal.id)
      // Rows come newest first: the first one names the goal.
      if (!g) byGoal.set(goal.id, g = { id: goal.id, title: goal.title, open: 0, done: 0, dropped: 0, progress: null, costUsd: 0, runs: 0, unpriced: 0, lastAt: r.updatedAt, requests: [] })
      if (r.state === "done") g.done++
      else if ((CLOSED_STATES as readonly string[]).includes(r.state)) g.dropped++
      else g.open++
      const c = cost.get(r.id)
      if (c) {
        g.costUsd += c.usd ?? 0
        g.runs += c.runs
        g.unpriced += c.unpriced
      }
      const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
      // The counts and the cost take every request; the list, the newest.
      if (g.requests.length >= GOAL_LIST_MAX) continue
      const item: GoalRequest = {
        id: r.id, state: r.state, agentId: r.agentId, title: words.length > 120 ? `${words.slice(0, 119)}…` : words,
        createdAt: r.createdAt, closedAt: r.closedAt, costUsd: c?.usd ?? null,
      }
      g.requests.push(item)
    }
    const out = [...byGoal.values()].slice(0, limit)
    for (const g of out) {
      g.progress = g.open + g.done ? g.done / (g.open + g.done) : null
      g.costUsd = Math.round(g.costUsd * 10_000) / 10_000
    }
    return out
  }

  /** goals() without each goal's request list, counted in SQL (#1396): the
   *  Wall reads it on every load. It reads the same requests goals() does,
   *  and prices only their runs, so both give the same numbers. */
  goalCounts(limit = GOALS_MAX): Array<Omit<GoalSummary, "requests">> {
    const kept = `WITH kept AS (
        SELECT id, goal_id, goal_title, state, updated_at, rowid AS rid FROM requests
        WHERE goal_id IS NOT NULL AND goal_title IS NOT NULL AND state != 'candidate' ORDER BY updated_at DESC, rowid DESC LIMIT ?)`
    const rows = this.db.prepare(
      `${kept}, ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY goal_id ORDER BY updated_at DESC, rid DESC) AS n FROM kept)
       SELECT k.goal_id AS id, f.goal_title AS title, f.updated_at AS lastAt,
         SUM(CASE WHEN k.state = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN k.state IN (${placeholders(CLOSED_STATES.length)}) AND k.state != 'done' THEN 1 ELSE 0 END) AS dropped,
         SUM(CASE WHEN k.state NOT IN (${placeholders(CLOSED_STATES.length)}) THEN 1 ELSE 0 END) AS open
       FROM kept k JOIN ranked f ON f.goal_id = k.goal_id AND f.n = 1
       GROUP BY k.goal_id ORDER BY f.updated_at DESC, f.rid DESC LIMIT ?`,
    ).all(GOAL_REQUESTS_MAX, ...CLOSED_STATES, ...CLOSED_STATES, limit) as Array<{ id: string; title: string; lastAt: number; open: number; done: number; dropped: number }>
    if (!rows.length) return []
    const cost = new Map<string, { usd: number | null; runs: number; unpriced: number }>()
    try {
      const priced = this.db.prepare(
        `${kept}
         SELECT k.goal_id AS id, SUM(t.cost_usd) AS usd, COUNT(*) AS runs, SUM(CASE WHEN t.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM kept k JOIN request_links l ON l.request_id = k.id JOIN task_traces t ON t.task_id = l.ref
         WHERE l.kind IN ('run', 'step_run') GROUP BY k.goal_id`,
      ).all(GOAL_REQUESTS_MAX) as Array<{ id: string; usd: number | null; runs: number; unpriced: number }>
      for (const p of priced) cost.set(p.id, p)
    } catch {
      // No task traces in this database: no cost to show.
    }
    return rows.map((r) => {
      const c = cost.get(r.id)
      return {
        id: r.id, title: r.title, open: r.open, done: r.done, dropped: r.dropped,
        progress: r.open + r.done ? r.done / (r.open + r.done) : null,
        costUsd: Math.round((c?.usd ?? 0) * 10_000) / 10_000, runs: c?.runs ?? 0, unpriced: c?.unpriced ?? 0, lastAt: r.lastAt,
      }
    })
  }

  /** What the checker said. `met` is written by closeVerified, not here.
   *  Not a touch: a check is not activity on the loop. */
  markChecked(id: string, state: VerifyState | null, detail: string, now: number): void {
    this.db.prepare("UPDATE requests SET checked_at = ?, verify_state = ?, verify_detail = ? WHERE id = ?")
      .run(now, state, detail.slice(0, REASON_MAX) || null, id)
  }

  /** The checker found the evidence: closed as done, with its words. Its
   *  proof is the check that ran (#1138 D). */
  closeVerified(id: string, evidence: string, now: number): boolean {
    const text = evidence.trim().slice(0, REASON_MAX) || "the check was met"
    const proof: Proof = { kind: "check", value: text, ranAt: now }
    const closed = this.db.prepare(
      `UPDATE requests SET state = 'done', closed_at = ?, updated_at = ?, state_changed_at = ?, evidence = ?, close_reason = NULL,
         checked_at = ?, verified_at = ?, verify_state = 'verified', verify_detail = ?, proof = ?
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run(now, now, now, text, now, now, text, JSON.stringify(proof), id, ...CLOSED_STATES).changes > 0
    if (closed) this.done(id)
    return closed
  }

  private doneHooks = new Set<(r: RequestRecord) => void>()

  /** Called after every close as done, with the closed request (#1138 D).
   *  Returns the function that removes it. */
  onDone(fn: (r: RequestRecord) => void): () => void {
    this.doneHooks.add(fn)
    return () => { this.doneHooks.delete(fn) }
  }

  private done(id: string): void {
    if (!this.doneHooks.size) return
    const r = this.get(id)
    if (r) for (const fn of this.doneHooks) fn(r)
  }

  /** The wiki fact a promise's close wrote. */
  setFact(id: string, factId: string): void {
    this.db.prepare("UPDATE requests SET fact_id = ? WHERE id = ?").run(factId, id)
  }

  /** Marks it as needing QA (#1188), or no longer (false). Marking it
   *  again after a verdict asks for a new one. Not a touch. */
  setNeedsQa(id: string, needed: boolean, now: number): void {
    this.db.prepare("UPDATE requests SET qa_requested_at = ? WHERE id = ?").run(needed ? now : null, id)
  }

  /** A QA verdict (#1188): kept as the request's latest, and in its
   *  history. Open or closed alike: QA often comes after the done. Not a
   *  touch: a verdict is not progress on the work. */
  recordVerdict(id: string, v: { verdict: QaVerdict; by: string; note: string | null }, now: number): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO request_verdicts (request_id, verdict, by_agent, at, note) VALUES (?, ?, ?, ?, ?)").run(id, v.verdict, v.by, now, v.note)
      this.db.prepare("UPDATE requests SET qa_verdict = ?, qa_by = ?, qa_at = ?, qa_note = ? WHERE id = ?").run(v.verdict, v.by, now, v.note, id)
    })()
  }

  /** Every verdict given on it, oldest first. */
  verdicts(id: string): QaRecord[] {
    return this.db.prepare("SELECT verdict, by_agent AS by, at, note FROM request_verdicts WHERE request_id = ? ORDER BY at, rowid").all(id) as QaRecord[]
  }

  /** Open loops with a checker whose last run is older than `before`
   *  (or that never ran), oldest check first. */
  dueForCheck(before: number, limit = 50): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(OPEN_STATES.length)}) AND close_when IS NOT NULL
         AND (checked_at IS NULL OR checked_at < ?) ORDER BY COALESCE(checked_at, 0), created_at LIMIT ?`,
    ).all(...OPEN_STATES, before, limit).map(toRecord)
  }

  /** Open requests whose home is an issue or merge request and that have
   *  no checker of their own, last looked at before `before` (#1522). A
   *  request waiting on the owner keeps its question, a promise is the
   *  agent's word to someone, and a pick-up not told yet is the owner's:
   *  all three are left. `since`: when it was asked, or last sent back by
   *  the owner; only a home closed after that closes it. */
  homesDue(before: number, limit = 50): Array<{ request: RequestRecord; since: number }> {
    return (this.db.prepare(
      `SELECT * FROM requests WHERE state IN ('in_progress', 'waiting_other', 'needs_attention') AND close_when IS NULL
         AND home_kind = 'issue' AND home_link IS NOT NULL AND COALESCE(promise, 0) = 0 AND pickup_at IS NULL
         AND (checked_at IS NULL OR checked_at < ?) ORDER BY COALESCE(checked_at, 0), created_at LIMIT ?`,
    ).all(before, limit) as any[]).map((row) => ({ request: toRecord(row), since: Math.max(row.created_at, row.sent_back_at ?? 0) }))
  }

  /** The home was read: only the time, so a request with no checker keeps
   *  its verify state (#1522). */
  markHomeChecked(id: string, now: number): void {
    this.db.prepare("UPDATE requests SET checked_at = ? WHERE id = ?").run(now, id)
  }

  /** Open loops past their due time with nothing done since it passed,
   *  or quiet since `quietBefore` (the owner handed one on after it fell
   *  due: it gets the usual quiet time). A loop waiting on the owner is
   *  left alone: its question reminds them. */
  overdue(now: number, quietBefore: number): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN ('in_progress', 'waiting_other') AND due_at IS NOT NULL AND due_at < ?
         AND (updated_at <= due_at OR updated_at < ?)
       ORDER BY due_at, rowid`,
    ).all(now, quietBefore).map(toRecord)
  }

  get(id: string): RequestRecord | null {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id)
    return row ? toRecord(row) : null
  }

  /** The request a run, delegation or card belongs to. */
  byLink(kind: LinkKind, ref: string): RequestRecord | null {
    const row = this.db.prepare(
      "SELECT r.* FROM requests r JOIN request_links l ON l.request_id = r.id WHERE l.kind = ? AND l.ref = ?",
    ).get(kind, ref)
    return row ? toRecord(row) : null
  }

  /** `agent`: who a delegation went to (#1522). */
  link(requestId: string, kind: LinkKind, ref: string, now: number, agent: string | null = null): void {
    this.db.prepare("INSERT OR IGNORE INTO request_links (request_id, kind, ref, at, agent) VALUES (?, ?, ?, ?, ?)").run(requestId, kind, ref, now, agent)
  }

  /** Delegation links kept before the agent was (#1520): filled from the
   *  delegation log, delegation id → callee. Returns how many were filled. */
  fillLinkAgents(agents: Map<string, string>): number {
    const fill = this.db.prepare("UPDATE request_links SET agent = ? WHERE kind = 'delegation' AND ref = ? AND agent IS NULL")
    let n = 0
    this.db.transaction(() => {
      for (const [ref, agent] of agents) n += fill.run(agent, ref).changes
    })()
    return n
  }

  /** Delegation links kept before the agent was (#1520), filled from the
   *  callee's own turn: a delegation runs in chat `a2a:<caller>:<callee>:<id>`
   *  (src/a2a/delegation.ts), kept in task_history until its retention
   *  prunes it. A peer's delegation runs on the peer, with no row here:
   *  those stay without an agent. Returns how many were filled. */
  fillLinkAgentsFromHistory(): number {
    const hasHistory = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_history'").get()
    if (!hasHistory) return 0
    const refs = new Set((this.db.prepare(
      "SELECT DISTINCT ref FROM request_links WHERE kind = 'delegation' AND agent IS NULL",
    ).all() as Array<{ ref: string }>).map((r) => r.ref))
    if (!refs.size) return 0
    const agents = new Map<string, string>()
    for (const { chat_id } of this.db.prepare(
      "SELECT DISTINCT chat_id FROM task_history WHERE chat_id LIKE 'a2a:%:%:%'",
    ).iterate() as Iterable<{ chat_id: string }>) {
      // The callee is the third part, not the row's agent_id: a turn can
      // be kept under another id than the one the delegation went to.
      const parts = chat_id.split(":")
      if (parts.length !== 4) continue
      const [, , callee, ref] = parts
      if (callee && refs.has(ref) && !agents.has(ref)) agents.set(ref, callee)
    }
    return this.fillLinkAgents(agents)
  }

  /** The owner wrote again in the chat (#1520): requests of that agent
   *  waiting on the owner there since before go back to work, and the
   *  settle and quiet rules follow them from there. Promises are left:
   *  their own check follows them. So is a request waiting on a decision
   *  card not yet answered: the card's answer moves it (cardResolved). A
   *  card from before answers were kept counts as undecided only while
   *  the request has not moved since it was raised. Returns the ids moved. */
  releaseOwnerWaits(agentId: string, channel: string, chatId: string, now: number): string[] {
    const ids = (this.db.prepare(
      `SELECT r.id FROM requests r WHERE r.agent_id = ? AND r.channel = ? AND r.chat_id = ? AND r.state = 'waiting_owner'
         AND COALESCE(r.promise, 0) = 0 AND COALESCE(r.state_changed_at, r.updated_at) < ?
         AND NOT EXISTS (SELECT 1 FROM request_links l WHERE l.request_id = r.id AND l.kind = 'card' AND l.ended IS NULL
                           AND l.at >= COALESCE(r.state_changed_at, r.updated_at))`,
    ).all(agentId, channel, chatId, now) as Array<{ id: string }>).map((r) => r.id)
    for (const id of ids) this.progress(id, now)
    return ids
  }

  /** The owner commented on the request from the Wall (#1316): kept as a
   *  "comment" link, its words in the link's proof column. */
  comment(requestId: string, ref: string, text: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO request_links (request_id, kind, ref, at, proof) VALUES (?, 'comment', ?, ?, ?)")
      .run(requestId, ref, now, text.slice(0, COMMENT_MAX))
  }

  /** How the linked work ended ("done", "waiting", "error"…), and the
   *  link its answer gave as proof, if any (#1138). */
  endLink(kind: LinkKind, ref: string, ended: string, proof: string | null, now: number): void {
    this.db.prepare("UPDATE request_links SET ended = ?, ended_at = ?, proof = ? WHERE kind = ? AND ref = ?")
      .run(ended, now, proof ? proof.slice(0, HOME_LINK_MAX) : null, kind, ref)
  }

  /** The owner sent the request back (a reply on it, a hand-off, a
   *  pick-up): work that came back before is no longer what finishes it.
   *  Only work handed on and done after that can settle the request, with
   *  its own link (#1138). */
  private supersedeHandBacks(id: string): void {
    this.db.prepare("UPDATE request_links SET ended = 'superseded' WHERE request_id = ? AND kind = 'delegation' AND ended = 'done'").run(id)
  }

  /** Requests whose handed-on work all came back done (#1138): at least
   *  one delegation done since the owner last sent it back, and none that
   *  is still out, waiting, failed or from before endings were kept.
   *  Superseded ones count for neither. In progress and quiet since
   *  `before`, or raised only for being past its due time (#1214) or for a
   *  hand-off that did not end done (#1520), with that work back since
   *  before `before`. A due time is the agent's own
   *  (its accept, its estimate, a wait it reported): the owner's due times
   *  are promises, which are left out. So are loops with a checker, a
   *  pick-up the agent has not been told about yet, and anything with a
   *  follow-up workflow, which may still be running and reports its own end. */
  handedBack(before: number): RequestRecord[] {
    return this.db.prepare(
      `SELECT r.* FROM requests r
        WHERE (
            (r.state = 'in_progress' AND r.updated_at < ?)
            OR (r.state = 'needs_attention' AND ${settleableAttention("r.attention_reason")}
                AND (SELECT MAX(l.ended_at) FROM request_links l WHERE l.request_id = r.id AND l.kind = 'delegation' AND l.ended = 'done') < ?)
          )
          AND ${CAME_BACK}
        ORDER BY r.created_at, r.rowid`,
    ).all(before, before).map(toRecord)
  }

  /** The request's handed-on work all came back done, as handedBack reads
   *  it, however long ago (#1214). */
  cameBack(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM requests r WHERE r.id = ? AND ${CAME_BACK}`).get(id)
  }

  /** The newest proof link the request's delegations brought back since
   *  the owner last sent it back. */
  handBackProof(requestId: string): { proof: string; ref: string } | null {
    const row = this.db.prepare(
      `SELECT proof, ref FROM request_links WHERE request_id = ? AND kind = 'delegation' AND ended = 'done' AND proof IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
    ).get(requestId) as { proof: string; ref: string } | undefined
    return row ?? null
  }

  /** Settled (#1138): the handed work came back done and nobody closed
   *  it. Closed as done with the delegate's link, or, without one, as
   *  "unproven: …". Either way unverified: nothing checked the link. Only
   *  from in progress, or raised for being overdue (#1214) or for a
   *  hand-off that did not end done (#1520): anything that moved since it
   *  was read is left. */
  settle(id: string, proof: string | null, detail: string, now: number): boolean {
    const evidence = (proof ?? `unproven: ${detail}`).trim().slice(0, REASON_MAX)
    return this.db.prepare(
      `UPDATE requests SET state = 'done', closed_at = ?, updated_at = ?, state_changed_at = ?, evidence = ?, close_reason = NULL,
         verify_state = ?, verify_detail = ?
       WHERE id = ? AND (state = 'in_progress' OR (state = 'needs_attention' AND ${settleableAttention("attention_reason")}))`,
    ).run(now, now, now, evidence, "unverified", detail.slice(0, REASON_MAX), id).changes > 0
  }

  links(requestId: string): Array<{ kind: LinkKind; ref: string; at: number }> {
    return this.db.prepare("SELECT kind, ref, at FROM request_links WHERE request_id = ? ORDER BY at, rowid").all(requestId) as any
  }

  /** The agent's newest answer under this request: the final reply of its
   *  latest linked run that has one. Null when nothing was recorded, or
   *  when this database has no traces. */
  lastAnswer(requestId: string): { agentId: string; text: string; at: number } | null {
    try {
      const row = this.db.prepare(
        `SELECT t.agent_id AS agentId, t.final_response AS text, COALESCE(t.finished_at, t.started_at) AS at
         FROM request_links l JOIN task_traces t ON t.task_id = l.ref
         WHERE l.request_id = ? AND l.kind = 'run' AND t.final_response IS NOT NULL AND t.final_response != ''
         ORDER BY t.started_at DESC LIMIT 1`,
      ).get(requestId) as { agentId: string; text: string; at: number } | undefined
      return row ?? null
    } catch {
      return null
    }
  }

  /** Something happened under this request: it is not quiet. */
  touch(id: string, now: number): void {
    this.db.prepare("UPDATE requests SET updated_at = ? WHERE id = ?").run(now, id)
  }

  /** Work is under way. Opens a candidate; clears an earlier "needs
   *  attention" so a later failure is raised again. Closed stays closed. */
  progress(id: string, now: number, state: "in_progress" | "waiting_other" = "in_progress"): void {
    // A need written for the owner's answer is met once work goes on (#1126).
    this.db.prepare(
      `UPDATE requests SET ${STATE_CHANGED}, state = ?, updated_at = ?, attention_reason = NULL, notified_at = NULL, question = NULL,
         need = CASE WHEN state IN ('waiting_owner', 'needs_attention') THEN NULL ELSE need END
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run(state, now, state, now, id, ...CLOSED_STATES)
  }

  /** The next step is the owner's answer. What it needs from the owner is
   *  now that answer: a need written for the work before is dropped
   *  unless the agent gives a new one (#1126). */
  waitOnOwner(id: string, question: string, now: number, need: string | null = null): void {
    this.db.prepare(
      `UPDATE requests SET ${STATE_CHANGED}, state = 'waiting_owner', updated_at = ?, question = ?, need = ?, attention_reason = NULL, notified_at = NULL
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run("waiting_owner", now, now, question.slice(0, TEXT_MAX), need, id, ...CLOSED_STATES)
  }

  /** The work failed, timed out, was cut off, or went quiet. A request
   *  already waiting for attention keeps its first reason and is not
   *  raised a second time. */
  needsAttention(id: string, reason: string, now: number): boolean {
    const res = this.db.prepare(
      `UPDATE requests SET state = 'needs_attention', updated_at = ?, state_changed_at = ?, attention_reason = ?, notified_at = NULL
       WHERE id = ? AND state NOT IN ('needs_attention', ${placeholders(CLOSED_STATES.length)})`,
    ).run(now, now, reason.replace(/\s+/g, " ").trim().slice(0, REASON_MAX), id, ...CLOSED_STATES)
    return res.changes > 0
  }

  /** Close it: done needs evidence, declined and dropped need a reason.
   *  A done may carry a typed proof (#1138 D), kept beside the evidence. */
  close(id: string, state: ClosedState, detail: string, now: number, proof: Proof | null = null): boolean {
    const text = detail.trim()
    if (!text) throw new Error(state === "done" ? "a finished request needs a link to the evidence" : `a ${state} request needs a reason`)
    const kept = state === "done" && proof ? JSON.stringify(proof) : null
    const res = this.db.prepare(
      `UPDATE requests SET state = ?, closed_at = ?, updated_at = ?, state_changed_at = ?, evidence = ?, close_reason = ?, proof = ?
       WHERE id = ? AND state NOT IN (${placeholders(CLOSED_STATES.length)})`,
    ).run(state, now, now, now, state === "done" ? text.slice(0, REASON_MAX) : null, state === "done" ? null : text.slice(0, REASON_MAX), kept, id, ...CLOSED_STATES)
    const closed = res.changes > 0
    if (closed && state === "done") this.done(id)
    return closed
  }

  /** A candidate whose turn ended with nothing left to follow. */
  discardCandidate(id: string): boolean {
    return this.db.prepare("DELETE FROM requests WHERE id = ? AND state = 'candidate'").run(id).changes > 0
  }

  /** Open requests, oldest first. */
  listOpen(): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(OPEN_STATES.length)}) ORDER BY created_at, rowid`,
    ).all(...OPEN_STATES).map(toRecord)
  }

  /** Requests in these states that nothing has touched since `before`.
   *  A loop with a due time is judged by that, not by quiet (#1039). */
  quietSince(states: RequestState[], before: number): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(states.length)}) AND updated_at < ? AND due_at IS NULL ORDER BY created_at, rowid`,
    ).all(...states, before).map(toRecord)
  }

  /** Requests that need attention and were not raised yet. */
  awaitingNotice(): RequestRecord[] {
    return this.db.prepare(
      "SELECT * FROM requests WHERE state = 'needs_attention' AND notified_at IS NULL ORDER BY created_at, rowid",
    ).all().map(toRecord)
  }

  markNotified(id: string, now: number | null): void {
    this.db.prepare("UPDATE requests SET notified_at = ? WHERE id = ?").run(now, id)
  }

  /** Requests in one state, oldest first. */
  listByState(state: RequestState): RequestRecord[] {
    return this.db.prepare("SELECT * FROM requests WHERE state = ? ORDER BY created_at, rowid").all(state).map(toRecord)
  }

  /** Requests closed since `since`, newest first. */
  listClosedSince(since: number, limit = 50): RequestRecord[] {
    return this.db.prepare(
      `SELECT * FROM requests WHERE state IN (${placeholders(CLOSED_STATES.length)}) AND closed_at >= ? ORDER BY closed_at DESC, rowid DESC LIMIT ?`,
    ).all(...CLOSED_STATES, since, limit).map(toRecord)
  }

  /** Records where the work lives: the column holds the latest, the links
   *  keep every one. touch: false keeps updated_at, for calls that must
   *  not count as progress. */
  setHome(id: string, home: RequestHome, now: number, opts: { touch?: boolean } = {}): void {
    const link = home.link.slice(0, HOME_LINK_MAX)
    if (opts.touch === false) {
      this.db.prepare("UPDATE requests SET home_kind = ?, home_link = ? WHERE id = ?").run(home.kind, link, id)
    } else {
      this.db.prepare("UPDATE requests SET home_kind = ?, home_link = ?, updated_at = ? WHERE id = ?")
        .run(home.kind, link, now, id)
    }
    this.linkHome(id, home, now)
  }

  private linkHome(id: string, home: RequestHome, now: number): void {
    if ((HOME_LINK_KINDS as readonly string[]).includes(home.kind)) this.link(id, home.kind as HomeLinkKind, home.link.slice(0, HOME_LINK_MAX), now)
  }

  /** Requests by state and age, for GET /requests (#394), and by QA
   *  (#1188). Oldest first;
   *  `newest` keeps the newest `limit` instead of the oldest. `total`
   *  counts every match, so a caller can page with `offset`. */
  query(q: { states: readonly RequestState[]; since?: number; closedSince?: number; qa?: QaFilter; limit: number; offset?: number; newest?: boolean }): { items: RequestRecord[]; total: number } {
    const where = [`state IN (${placeholders(q.states.length)})`]
    const args: unknown[] = [...q.states]
    if (q.since !== undefined) { where.push("created_at >= ?"); args.push(q.since) }
    if (q.closedSince !== undefined) { where.push("closed_at >= ?"); args.push(q.closedSince) }
    // QA (#1188): awaiting sign-off, or the latest verdict is this one.
    if (q.qa === "awaiting") where.push(AWAITING_QA)
    else if (q.qa) { where.push("qa_verdict = ?"); args.push(q.qa) }
    const sql = where.join(" AND ")
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${sql}`).get(...args) as { n: number }).n
    const order = q.newest ? "DESC" : "ASC"
    const items = this.db.prepare(`SELECT * FROM requests WHERE ${sql} ORDER BY created_at ${order}, rowid ${order} LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset ?? 0).map(toRecord)
    return { items: q.newest ? items.reverse() : items, total }
  }

  /** The owner said "pick it up again": back in progress, and the agent
   *  is to be told at the next check. `resend`: the requests check sends
   *  it back on its own (#1542), only if it never did before, and marks it. */
  requestPickup(id: string, now: number, opts: { resend?: boolean } = {}): boolean {
    return this.db.transaction(() => {
      const moved = this.db.prepare(
        `UPDATE requests SET state = 'in_progress', updated_at = ?, state_changed_at = ?, attention_reason = NULL, notified_at = NULL, pickup_at = ?, need = NULL
           ${opts.resend ? ", resent_at = ?" : ""}
         WHERE id = ? AND state = 'needs_attention'${opts.resend ? " AND resent_at IS NULL" : ""}`,
      ).run(now, now, now, ...(opts.resend ? [now] : []), id).changes > 0
      if (moved) this.supersedeHandBacks(id)
      return moved
    })()
  }

  /** The owner replied, or handed it to an agent (the same or another):
   *  that agent has it, in progress, and is told at the next check. Any
   *  open request, not only one that needs attention. The agent it was
   *  asked of is kept from the first time: channel and chat stay its own. */
  handOff(id: string, agentId: string, note: string, now: number): boolean {
    return this.db.transaction(() => {
      const moved = this.db.prepare(
        `UPDATE requests SET ${STATE_CHANGED}, agent_id = ?, state = 'in_progress', updated_at = ?, attention_reason = NULL, notified_at = NULL,
           question = NULL, need = NULL, pickup_at = ?, owner_note = ?, note_said = NULL, asked_agent = COALESCE(asked_agent, agent_id)
         WHERE id = ? AND state IN (${placeholders(OPEN_STATES.length)})`,
      ).run("in_progress", now, agentId, now, now, note.trim().slice(0, TEXT_MAX) || null, id, ...OPEN_STATES).changes > 0
      if (moved) this.supersedeHandBacks(id)
      return moved
    })()
  }

  /** The owner commented on a closed post (#1355): it opens again, in
   *  progress, with the comment as the owner's note, for its agent to pick
   *  up at the next check. How it was closed is kept until it closes again. */
  reopen(id: string, note: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET ${STATE_CHANGED}, state = 'in_progress', closed_at = NULL, updated_at = ?, attention_reason = NULL, notified_at = NULL,
         question = NULL, need = NULL, pickup_at = ?, owner_note = ?, note_said = NULL
       WHERE id = ? AND state IN (${placeholders(CLOSED_STATES.length)})`,
    ).run("in_progress", now, now, now, note.trim().slice(0, TEXT_MAX) || null, id, ...CLOSED_STATES).changes > 0
  }

  /** This note of the owner is given to the agent in a pick-up, or (false)
   *  was not after all. Only while it is still the note on the request: a
   *  reply written since has its own pick-up and its own mark. */
  setNoteSaid(id: string, note: string, said: boolean): void {
    this.db.prepare(`UPDATE requests SET note_said = ? WHERE id = ? AND owner_note = ?${said ? " AND pickup_at IS NULL" : ""}`).run(said ? 1 : null, id, note)
  }

  /** Requests whose agent has not been told to pick them up yet. Each is
   *  returned once. One statement: a mark the dashboard (another process)
   *  writes meanwhile is either returned here or kept for the next read. */
  takePickups(): RequestRecord[] {
    return this.db.prepare("UPDATE requests SET sent_back_at = pickup_at, pickup_at = NULL WHERE pickup_at IS NOT NULL RETURNING *").all()
      .map(toRecord)
      .filter((r) => r.state === "in_progress")
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Every request asked since `since` (candidates left out), for the
   *  daily flow (#1542): only what the count needs. */
  flowRows(since: number): Array<{ state: RequestState; createdAt: number; closeReason: string | null; resentAt: number | null }> {
    return this.db.prepare(
      `SELECT state, created_at AS createdAt, close_reason AS closeReason, resent_at AS resentAt
       FROM requests WHERE created_at >= ? AND state != 'candidate' ORDER BY created_at, rowid`,
    ).all(since) as any
  }

  /** Delete closed requests older than `before`. Open ones never age out. */
  pruneClosed(before: number): number {
    return this.db.prepare(
      `DELETE FROM requests WHERE state IN (${placeholders(CLOSED_STATES.length)}) AND closed_at < ?`,
    ).run(...CLOSED_STATES, before).changes
  }
}
