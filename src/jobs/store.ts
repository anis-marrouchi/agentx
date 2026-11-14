import type Database from "better-sqlite3"
import { ensureColumns } from "@/storage/sqlite"
import { ensureRequestTables, HOME_LINK_MAX, TEXT_MAX, type RequestHome } from "@/requests/store"

// --- The job ledger (#1861) ---
//
// One record per piece of assigned work, whatever door it came through:
// an owner turn, an agent-to-agent hand-off, an issue mention, a cron or
// a workflow step. It is not a new table: a job is a row of `requests`
// with a few more columns.
//
//   - A row the owner's turn opened (requests/tracker.ts) keeps its own
//     `state` and everything that reads it. Its job state is read from
//     that state until a run declares one.
//   - A row opened at any other door has `state = 'job'`. No reader of
//     open requests lists that state, so the Desk, the requests check
//     and the owner's notices do not see it. Its state is `job_state`.
//
// Every call is one small synchronous statement, like the request store.

/** `state` of a row that is only a job: not an owner's request. */
export const JOB_ROW_STATE = "job"

/** Where the work came in. */
export const JOB_DOORS = ["owner", "a2a", "mention", "cron", "workflow", "api"] as const
export type JobDoor = (typeof JOB_DOORS)[number]

/** What a job is doing, as its last run declared it or the daemon found it.
 *    working   a run is on it (or was, and has not said otherwise yet)
 *    continue  the run ended with work left: the daemon wakes it at `wakeAt`
 *    waiting   on someone (`waitingOn`), until `until`
 *    blocked   cannot go on: `note` says why
 *    stalled   no live run, no wake, no waiter: found by the daemon
 *    done      finished, with its proof
 *    dropped   declined or dropped (owner rows only) */
export const JOB_STATES = ["working", "continue", "waiting", "blocked", "stalled", "done", "dropped"] as const
export type JobState = (typeof JOB_STATES)[number]
export const OPEN_JOB_STATES: readonly JobState[] = ["working", "continue", "waiting", "blocked", "stalled"]

export const JOB_NOTE_MAX = 1000
const WHO_MAX = 200

/** What a run says about its job when it ends (design point 2). */
export type JobDeclaration =
  | { state: "done"; proof: string }
  | { state: "continue"; wakeAt: number; note: string }
  | { state: "waiting"; on: string; until: number; note?: string }
  | { state: "blocked"; why: string }

export interface JobRecord {
  id: string
  door: JobDoor
  state: JobState
  /** Who asked: "owner", an agent id, `agent@peer`, `cron:<name>`, a login. */
  requester: string | null
  /** The agent that owes the work. */
  assignee: string
  /** The chat its runs happen in. */
  channel: string
  chatId: string
  text: string
  headline: string | null
  /** Where the work lives: the issue or merge request. */
  home: RequestHome | null
  parentId: string | null
  /** When the daemon starts its next run (state continue). */
  wakeAt: number | null
  /** How many times the daemon has woken it. */
  wakeCount: number
  /** Who it waits on, and until when (state waiting). */
  waitingOn: string | null
  until: number | null
  /** What is left, why it is blocked, or why it stalled. */
  note: string | null
  /** The proof of a finished job. */
  proof: string | null
  /** When a run last declared the state, and which run. */
  declaredAt: number | null
  declaredRun: string | null
  /** When the daemon asked the run for a state it did not give. Once per run end. */
  stateAskedAt: number | null
  stalledAt: number | null
  /** When its requester was told it stalled. */
  requesterToldAt: number | null
  /** The node its assignee runs on, when not this one, and its id there. */
  peer: string | null
  remoteId: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
  /** True for a row the owner's turn opened: `requests` machinery owns
   *  its closing. */
  ownerRequest: boolean
}

export interface JobRun {
  runId: string
  linkedAt: number
  /** From the run's trace. Null when the trace is not kept here. */
  status: string | null
  startedAt: number | null
  finishedAt: number | null
  costUsd: number | null
  error: string | null
}

export const JOB_COLUMNS: Array<[string, string]> = [
  ["door", "TEXT"], ["job_state", "TEXT"], ["requester", "TEXT"], ["parent_id", "TEXT"],
  ["wake_at", "INTEGER"], ["wake_count", "INTEGER"], ["waiting_on", "TEXT"], ["job_note", "TEXT"],
  ["declared_at", "INTEGER"], ["declared_run", "TEXT"], ["state_asked_at", "INTEGER"],
  ["stalled_at", "INTEGER"], ["requester_told_at", "INTEGER"],
  ["peer", "TEXT"], ["remote_id", "TEXT"],
]

/** Adds the job columns to `requests`. By name, so it cannot clash with
 *  a migration number, and safe to run on every start. */
export function ensureJobColumns(db: Database.Database): void {
  ensureRequestTables(db)
  ensureColumns(db, "requests", JOB_COLUMNS)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_job_state ON requests(job_state) WHERE job_state IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_requests_parent ON requests(parent_id) WHERE parent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_requests_wake ON requests(wake_at) WHERE wake_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_requests_job_home ON requests(agent_id, home_link) WHERE state = 'job' AND home_link IS NOT NULL;
  `)
}

/** The job state of any row of `requests`, in SQL. A closed owner request
 *  is closed whatever a run declared; an open one reads its declared
 *  state, else the one its request state means. */
export const JOB_STATE_SQL = `CASE
  WHEN state = 'done' THEN 'done'
  WHEN state IN ('declined', 'dropped') THEN 'dropped'
  WHEN job_state IS NOT NULL THEN job_state
  WHEN state IN ('waiting_owner', 'waiting_other') THEN 'waiting'
  WHEN state = 'needs_attention' THEN 'blocked'
  ELSE 'working' END`

function toJob(r: any): JobRecord {
  const ownerRequest = r.state !== JOB_ROW_STATE
  const state = r.derived_state as JobState
  // An owner request with no declared state says what it waits on itself.
  const legacy = ownerRequest && !r.job_state
  return {
    id: r.id,
    door: (JOB_DOORS as readonly string[]).includes(r.door) ? r.door : "owner",
    state,
    requester: r.requester ?? (ownerRequest ? r.owed_to ?? r.sender ?? "owner" : null),
    assignee: r.agent_id, channel: r.channel, chatId: r.chat_id,
    text: r.text, headline: r.headline ?? null,
    home: r.home_kind && r.home_link ? { kind: r.home_kind, link: r.home_link } : null,
    parentId: r.parent_id ?? null,
    wakeAt: r.wake_at ?? null, wakeCount: r.wake_count ?? 0,
    waitingOn: r.waiting_on ?? (legacy && r.state === "waiting_owner" ? "owner" : null),
    until: state === "waiting" ? r.due_at ?? null : null,
    note: r.job_note ?? (legacy ? r.attention_reason ?? r.question ?? null : null),
    proof: r.evidence ?? null,
    declaredAt: r.declared_at ?? null, declaredRun: r.declared_run ?? null, stateAskedAt: r.state_asked_at ?? null,
    stalledAt: r.stalled_at ?? null, requesterToldAt: r.requester_told_at ?? null,
    peer: r.peer ?? null, remoteId: r.remote_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at ?? null,
    ownerRequest,
  }
}

const SELECT = `SELECT *, ${JOB_STATE_SQL} AS derived_state FROM requests`
const placeholders = (n: number) => Array(n).fill("?").join(",")
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n)

/** WHERE clause of a row that is not closed, as a job or as a request. */
const OPEN_ROW = "state NOT IN ('done', 'declined', 'dropped') AND COALESCE(job_state, '') != 'done'"

export interface JobQuery {
  /** Only these states. Unset: every state. */
  states?: readonly JobState[]
  door?: JobDoor
  assignee?: string
  requester?: string
  /** Children of this job. */
  parentId?: string
  /** Only jobs with no parent. */
  roots?: boolean
  limit: number
  offset?: number
}

export class JobStore {
  constructor(private db: Database.Database) {
    ensureJobColumns(db)
    db.pragma("foreign_keys = ON")
  }

  /** Open a job at a door other than the owner's turn: working, linked to
   *  the run that started it when there is one. False when the id exists. */
  open(input: {
    id: string; door: Exclude<JobDoor, "owner">; requester: string | null; assignee: string
    channel: string; chatId: string; text: string
    home?: RequestHome | null; parentId?: string | null; runId?: string | null
    peer?: string | null; remoteId?: string | null
    /** Unset: working. A job handed to another node starts waiting on it. */
    state?: "working" | "waiting"
    waitingOn?: string | null
    now: number
  }): boolean {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO requests (id, state, channel, chat_id, sender, agent_id, text, created_at, updated_at, state_changed_at,
         door, job_state, requester, parent_id, home_kind, home_link, peer, remote_id, waiting_on)
       VALUES (?, '${JOB_ROW_STATE}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.channel, input.chatId, input.requester ? clip(input.requester, WHO_MAX) : null, input.assignee,
      input.text.slice(0, TEXT_MAX), input.now, input.now, input.now,
      input.door, input.state ?? "working", input.requester ? clip(input.requester, WHO_MAX) : null, input.parentId ?? null,
      input.home?.kind ?? null, input.home ? input.home.link.slice(0, HOME_LINK_MAX) : null,
      input.peer ?? null, input.remoteId ?? null, input.waitingOn ? clip(input.waitingOn, WHO_MAX) : null,
    )
    if (res.changes > 0 && input.runId) this.linkRun(input.id, input.runId, input.now)
    return res.changes > 0
  }

  /** Mark the door of a row the owner's turn opened, and its parent. */
  tagOwnerRow(id: string, tag: { parentId?: string | null }): void {
    this.db.prepare("UPDATE requests SET door = COALESCE(door, 'owner'), parent_id = COALESCE(?, parent_id) WHERE id = ? AND state != ?")
      .run(tag.parentId ?? null, id, JOB_ROW_STATE)
  }

  get(id: string): JobRecord | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id)
    return row ? toJob(row) : null
  }

  /** The job a run, or a delegation, belongs to. */
  byRun(runId: string): JobRecord | null {
    return this.byLink("run", runId)
  }

  byDelegation(delegationId: string): JobRecord | null {
    return this.byLink("delegation", delegationId)
  }

  private byLink(kind: string, ref: string): JobRecord | null {
    const row = this.db.prepare(
      `SELECT r.*, ${JOB_STATE_SQL} AS derived_state
       FROM requests r JOIN request_links l ON l.request_id = r.id WHERE l.kind = ? AND l.ref = ?`,
    ).get(kind, ref)
    return row ? toJob(row) : null
  }

  /** The open mention job of this assignee at this home, newest first: a
   *  new comment on the same issue continues it. Mention jobs only: a
   *  hand-off that names the issue is its own job, and a comment must not
   *  link its run to it (or close it). Not owner rows. */
  openAtHome(assignee: string, homeLink: string): JobRecord | null {
    const row = this.db.prepare(
      `${SELECT} WHERE state = ? AND door = 'mention' AND agent_id = ? AND home_link = ? AND job_state IN (${placeholders(OPEN_JOB_STATES.length)})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(JOB_ROW_STATE, assignee, homeLink.slice(0, HOME_LINK_MAX), ...OPEN_JOB_STATES)
    return row ? toJob(row) : null
  }

  /** A run of the job. A run belongs to one job: the first that linked it. */
  linkRun(id: string, runId: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO request_links (request_id, kind, ref, at) VALUES (?, 'run', ?, ?)").run(id, runId, now)
  }

  linkDelegation(id: string, delegationId: string, now: number, agent: string | null = null): void {
    this.db.prepare("INSERT OR IGNORE INTO request_links (request_id, kind, ref, at, agent) VALUES (?, 'delegation', ?, ?, ?)").run(id, delegationId, now, agent)
  }

  /** A run started on the job: it is working again. Clears a wake that
   *  fired, a wait and a stall. A closed job stays closed. */
  working(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET job_state = 'working', updated_at = ?, wake_at = NULL, waiting_on = NULL, stalled_at = NULL,
         requester_told_at = NULL, state_asked_at = NULL
       WHERE id = ? AND ${OPEN_ROW}`,
    ).run(now, id).changes > 0
  }

  /** What the run said about the job as it ended. False when the job is
   *  closed or missing. Done closes a job row with its proof. An owner's
   *  request is not closed here (false): that stays with agentx_request,
   *  which checks the proof against the owner's words. */
  declare(id: string, d: JobDeclaration, by: { runId?: string | null; now: number }): boolean {
    const { now } = by
    const run = by.runId ?? null
    if (d.state === "done") {
      const proof = clip(d.proof, JOB_NOTE_MAX)
      if (!proof) throw new Error("a finished job needs its proof")
      return this.db.prepare(
        `UPDATE requests SET job_state = 'done', updated_at = ?, state_changed_at = ?, declared_at = ?, declared_run = ?, wake_at = NULL,
           waiting_on = NULL, stalled_at = NULL, job_note = NULL, evidence = ?, closed_at = ?
         WHERE id = ? AND state = '${JOB_ROW_STATE}' AND ${OPEN_ROW}`,
      ).run(now, now, now, run, proof, now, id).changes > 0
    }
    if (d.state === "continue") {
      return this.db.prepare(
        `UPDATE requests SET job_state = 'continue', updated_at = ?, declared_at = ?, declared_run = ?, wake_at = ?, job_note = ?,
           waiting_on = NULL, stalled_at = NULL
         WHERE id = ? AND ${OPEN_ROW}`,
      ).run(now, now, run, d.wakeAt, clip(d.note, JOB_NOTE_MAX), id).changes > 0
    }
    if (d.state === "waiting") {
      const on = clip(d.on, WHO_MAX)
      if (!on) throw new Error("a waiting job names who it waits on")
      return this.db.prepare(
        `UPDATE requests SET job_state = 'waiting', updated_at = ?, declared_at = ?, declared_run = ?, waiting_on = ?, due_at = ?, job_note = ?,
           wake_at = NULL, stalled_at = NULL
         WHERE id = ? AND ${OPEN_ROW}`,
      ).run(now, now, run, on, d.until, d.note ? clip(d.note, JOB_NOTE_MAX) : null, id).changes > 0
    }
    const why = clip(d.why, JOB_NOTE_MAX)
    if (!why) throw new Error("a blocked job says why")
    return this.db.prepare(
      `UPDATE requests SET job_state = 'blocked', updated_at = ?, declared_at = ?, declared_run = ?, job_note = ?, wake_at = NULL,
         waiting_on = NULL, stalled_at = NULL
       WHERE id = ? AND ${OPEN_ROW}`,
    ).run(now, now, run, why, id).changes > 0
  }

  /** The daemon asked the ended run for the state it did not give. */
  markStateAsked(id: string, now: number): boolean {
    return this.db.prepare(`UPDATE requests SET state_asked_at = ? WHERE id = ? AND state_asked_at IS NULL AND ${OPEN_ROW}`).run(now, id).changes > 0
  }

  /** No live run, no wake, no waiter. True the first time; a job already
   *  stalled keeps its first reason and time. */
  markStalled(id: string, reason: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET job_state = 'stalled', stalled_at = ?, updated_at = ?, job_note = ?, wake_at = NULL, requester_told_at = NULL
       WHERE id = ? AND ${OPEN_ROW} AND COALESCE(job_state, '') != 'stalled'`,
    ).run(now, now, clip(reason, JOB_NOTE_MAX), id).changes > 0
  }

  /** Stalled jobs whose requester was not told yet, oldest first. */
  stalledUntold(limit = 50): JobRecord[] {
    return this.db.prepare(
      `${SELECT} WHERE job_state = 'stalled' AND requester_told_at IS NULL AND ${OPEN_ROW} ORDER BY stalled_at, rowid LIMIT ?`,
    ).all(limit).map(toJob)
  }

  /** Claims the telling: true for the one caller that may send it. */
  markRequesterTold(id: string, now: number): boolean {
    return this.db.prepare("UPDATE requests SET requester_told_at = ? WHERE id = ? AND requester_told_at IS NULL").run(now, id).changes > 0
  }

  /** Jobs whose wake time has come, oldest wake first. */
  dueWakes(now: number, limit = 20): JobRecord[] {
    return this.db.prepare(
      `${SELECT} WHERE wake_at IS NOT NULL AND wake_at <= ? AND job_state = 'continue' AND ${OPEN_ROW} ORDER BY wake_at, rowid LIMIT ?`,
    ).all(now, limit).map(toJob)
  }

  /** Claims a due wake: clears it and counts it. True for the one caller
   *  that may start the run. */
  takeWake(id: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET wake_at = NULL, wake_count = COALESCE(wake_count, 0) + 1, updated_at = ?
       WHERE id = ? AND wake_at IS NOT NULL AND wake_at <= ? AND ${OPEN_ROW}`,
    ).run(now, id, now).changes > 0
  }

  /** Arm a wake the daemon decided on itself (background work ended, a
   *  start that did not take): the job continues at `at`, with why. */
  armWake(id: string, at: number, note: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET job_state = 'continue', wake_at = ?, job_note = ?, updated_at = ?, waiting_on = NULL, stalled_at = NULL
       WHERE id = ? AND ${OPEN_ROW}`,
    ).run(at, clip(note, JOB_NOTE_MAX), now, id).changes > 0
  }

  /** Arm again a wake that was taken and whose run never began. Only
   *  while the job is as `takeWake` left it (continue, no wake set):
   *  whatever moved it since (a stop, a declaration) stands. */
  rearmWake(id: string, at: number, note: string, now: number): boolean {
    return this.db.prepare(
      `UPDATE requests SET wake_at = ?, job_note = ?, updated_at = ?
       WHERE id = ? AND job_state = 'continue' AND wake_at IS NULL AND ${OPEN_ROW}`,
    ).run(at, clip(note, JOB_NOTE_MAX), now, id).changes > 0
  }

  /** How many runs began on the job so far. */
  runCount(id: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM request_links WHERE request_id = ? AND kind = 'run'").get(id) as { n: number }).n
  }

  /** The newest open job of this agent in this chat: the one background
   *  work left by a turn there belongs to. */
  latestInChat(assignee: string, channel: string, chatId: string): JobRecord | null {
    const row = this.db.prepare(
      `${SELECT} WHERE agent_id = ? AND channel = ? AND chat_id = ? AND state != 'candidate' AND ${OPEN_ROW}
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    ).get(assignee, channel, chatId)
    return row ? toJob(row) : null
  }

  /** What the job's runs cost so far, where the traces priced them. */
  costUsd(id: string): number {
    return this.runs(id).reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  }

  /** The open jobs the minute check may stall, least recently moved
   *  first: working, continue or waiting, with no wake set, on this node;
   *  an owner's request only once a run declared a job state on it. */
  unheldCandidates(limit = 500): JobRecord[] {
    return this.db.prepare(
      `${SELECT} WHERE job_state IN ('working', 'continue', 'waiting') AND wake_at IS NULL AND peer IS NULL AND ${OPEN_ROW}
         AND (state = '${JOB_ROW_STATE}' OR declared_at IS NOT NULL)
       ORDER BY updated_at, rowid LIMIT ?`,
    ).all(limit).map(toJob)
  }

  /** Every open job, oldest first: what the minute check walks. */
  listOpen(limit = 2000): JobRecord[] {
    return this.db.prepare(
      `${SELECT} WHERE state != 'candidate' AND ${JOB_STATE_SQL} IN (${placeholders(OPEN_JOB_STATES.length)}) ORDER BY created_at, rowid LIMIT ?`,
    ).all(...OPEN_JOB_STATES, limit).map(toJob)
  }

  /** Jobs newest first. A turn still being answered (a candidate) is not
   *  listed: it is deleted when it just answers. */
  query(q: JobQuery): { items: JobRecord[]; total: number } {
    const where = ["state != 'candidate'"]
    const args: unknown[] = []
    if (q.states?.length) { where.push(`${JOB_STATE_SQL} IN (${placeholders(q.states.length)})`); args.push(...q.states) }
    if (q.door === "owner") where.push("(door IS NULL OR door = 'owner')")
    else if (q.door) { where.push("door = ?"); args.push(q.door) }
    if (q.assignee) { where.push("agent_id = ?"); args.push(q.assignee) }
    if (q.requester) { where.push("COALESCE(requester, owed_to, sender) = ?"); args.push(q.requester) }
    if (q.parentId) { where.push("parent_id = ?"); args.push(q.parentId) }
    if (q.roots) where.push("parent_id IS NULL")
    const sql = where.join(" AND ")
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${sql}`).get(...args) as { n: number }).n
    const items = this.db.prepare(`${SELECT} WHERE ${sql} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset ?? 0).map(toJob)
    return { items, total }
  }

  children(id: string, limit = 200): JobRecord[] {
    return this.db.prepare(`${SELECT} WHERE parent_id = ? ORDER BY created_at, rowid LIMIT ?`).all(id, limit).map(toJob)
  }

  /** How many jobs are in each state, candidates left out. */
  counts(): Record<JobState, number> {
    const out = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>
    const rows = this.db.prepare(`SELECT ${JOB_STATE_SQL} AS s, COUNT(*) AS n FROM requests WHERE state != 'candidate' GROUP BY 1`).all() as Array<{ s: JobState; n: number }>
    for (const r of rows) if (r.s in out) out[r.s] = r.n
    return out
  }

  /** The job's runs, oldest first, with what their traces say. A database
   *  without the traces lists the links alone. */
  runs(id: string, limit = 200): JobRun[] {
    const links = this.db.prepare("SELECT ref, at FROM request_links WHERE request_id = ? AND kind = 'run' ORDER BY at, rowid LIMIT ?").all(id, limit) as Array<{ ref: string; at: number }>
    if (!links.length) return []
    let traces = new Map<string, any>()
    try {
      const rows = this.db.prepare(
        `SELECT task_id, status, started_at, finished_at, cost_usd, error FROM task_traces WHERE task_id IN (${placeholders(links.length)})`,
      ).all(...links.map((l) => l.ref)) as any[]
      traces = new Map(rows.map((r) => [r.task_id, r]))
    } catch {
      // No trace table here (a test database, or a reader before the first run).
    }
    return links.map((l) => {
      const t = traces.get(l.ref)
      return {
        runId: l.ref, linkedAt: l.at, status: t?.status ?? null, startedAt: t?.started_at ?? null, finishedAt: t?.finished_at ?? null,
        costUsd: t?.cost_usd ?? null, error: t?.error ?? null,
      }
    })
  }

  /** Delete job rows older than `before`: finished ones by their close,
   *  and working, blocked and stalled ones by their last move. Nothing
   *  reopens a failed cron or workflow run's job, and a job still "working"
   *  that long after its last move lost its run to a restart. A job with a
   *  wake set or a named waiter is kept: its own clock ends it. Owner
   *  requests age out with the request store's own pruning. */
  pruneDone(before: number): number {
    return this.db.prepare(
      `DELETE FROM requests WHERE state = ? AND ((job_state = 'done' AND closed_at < ?) OR (job_state IN ('working', 'blocked', 'stalled') AND updated_at < ?))`,
    ).run(JOB_ROW_STATE, before, before).changes
  }
}
