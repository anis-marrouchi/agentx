import type Database from "better-sqlite3"
import { DEFAULT_CHECKER_SETTINGS, describeCloseWhen, parseCloseWhen, readCloseWhen, type CheckerSettings, type CheckResult, type CloseWhen } from "./checkers"
import { describeCount, parseCountSpec, readCountSpec, type CountSpec } from "./checkers/count"
import type { RequestGoal } from "./goals"

// --- A goal as its own record (#1568 part 3) ---
//
// Until now a goal was a label on a request: it existed while a request
// named it (#1168). Crons need something lasting to point at, so a goal is
// now a row of its own: a title, an owner agent, a state (active, done or
// dropped), what "done" means in words, and optionally a check the daemon
// runs itself (any loop checker, or an open count). Requests keep their
// goal_id; accepting a request with a goal makes the record when it is
// new. A goal is done when its check is met, or when its owner closes it.
// A closed goal stays closed: a new goal needs a new id.

export const GOAL_STATES = ["active", "done", "dropped"] as const
export type GoalState = (typeof GOAL_STATES)[number]

export const DONE_WHEN_MAX = 300
export const GOAL_EVIDENCE_MAX = 500

/** What closes a goal: a loop checker, or an open count (#1568). */
export type GoalCheck = CloseWhen | ({ kind: "count" } & CountSpec)

export interface GoalRecord {
  id: string
  title: string
  /** The agent that keeps it moving and may close it. */
  ownerAgent: string | null
  state: GoalState
  doneWhen: string | null
  check: GoalCheck | null
  /** Why it closed: the check's evidence, or the owner's words. */
  evidence: string | null
  /** What the check saw last time, and when. */
  lastCheck: string | null
  lastCheckAt: number | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

/** Check the `check` (or closeWhen) of a goal: a spec, or why it is refused. */
export function parseGoalCheck(v: unknown, settings: CheckerSettings = DEFAULT_CHECKER_SETTINGS, now = Date.now()): GoalCheck | string {
  if (v && typeof v === "object" && !Array.isArray(v) && String((v as any).kind).trim().toLowerCase() === "count") {
    const spec = parseCountSpec(v as Record<string, unknown>)
    return typeof spec === "string" ? spec : { kind: "count", ...spec }
  }
  const spec = parseCloseWhen(v, settings, now)
  if (typeof spec !== "string") return spec
  return /^closeWhen(\.kind)? must be/.test(spec) ? "check must be an object with a kind: url, issue, git-ancestor, reply or count" : spec.replace(/^closeWhen/, "check")
}

function readGoalCheck(json: string | null): GoalCheck | null {
  if (!json) return null
  try {
    if (JSON.parse(json)?.kind === "count") {
      const spec = readCountSpec(json)
      return spec ? { kind: "count", ...spec } : null
    }
  } catch {
    return null
  }
  return readCloseWhen(json)
}

export function describeGoalCheck(check: GoalCheck): string {
  return check.kind === "count" ? describeCount(check) : describeCloseWhen(check)
}

function toGoal(r: any): GoalRecord {
  return {
    id: r.id, title: r.title, ownerAgent: r.owner_agent ?? null, state: r.state, doneWhen: r.done_when ?? null,
    check: readGoalCheck(r.check_spec), evidence: r.evidence ?? null, lastCheck: r.last_check ?? null, lastCheckAt: r.last_check_at ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at ?? null,
  }
}

export interface GoalInput extends RequestGoal {
  ownerAgent?: string | null
  doneWhen?: string | null
  check?: GoalCheck | null
}

export class GoalStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner_agent TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        done_when TEXT,
        check_spec TEXT,
        evidence TEXT,
        last_check TEXT,
        last_check_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_goals_state ON goals(state);
    `)
  }

  get(id: string): GoalRecord | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id)
    return row ? toGoal(row) : null
  }

  /** Most recently updated first. */
  list(states: readonly GoalState[] = GOAL_STATES, limit = 200): GoalRecord[] {
    const marks = states.map(() => "?").join(", ")
    return (this.db.prepare(`SELECT * FROM goals WHERE state IN (${marks}) ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(...states, limit) as any[]).map(toGoal)
  }

  /** The record of a goal a request names on accept: made when it is new,
   *  left as it is otherwise (its title and owner are the record's). */
  ensure(goal: RequestGoal, ownerAgent: string | null, now: number): GoalRecord {
    this.db.prepare(
      "INSERT INTO goals (id, title, owner_agent, state, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(goal.id, goal.title, ownerAgent, now, now)
    return this.get(goal.id)!
  }

  /** Make a goal, or change an active one: only the fields given change. */
  upsert(input: GoalInput, now: number): GoalRecord {
    const had = this.get(input.id)
    if (!had) {
      this.db.prepare(
        "INSERT INTO goals (id, title, owner_agent, state, done_when, check_spec, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
      ).run(input.id, input.title, input.ownerAgent ?? null, input.doneWhen ?? null, input.check ? JSON.stringify(input.check) : null, now, now)
    } else {
      this.db.prepare(
        "UPDATE goals SET title = ?, owner_agent = ?, done_when = ?, check_spec = ?, updated_at = ? WHERE id = ?",
      ).run(
        input.title || had.title,
        input.ownerAgent !== undefined ? input.ownerAgent : had.ownerAgent,
        input.doneWhen !== undefined ? input.doneWhen : had.doneWhen,
        input.check !== undefined ? (input.check ? JSON.stringify(input.check) : null) : (had.check ? JSON.stringify(had.check) : null),
        now, input.id,
      )
    }
    return this.get(input.id)!
  }

  /** Close an active goal as done or dropped. False when it was not active. */
  close(id: string, state: Exclude<GoalState, "active">, evidence: string | null, now: number): boolean {
    const res = this.db.prepare(
      "UPDATE goals SET state = ?, evidence = ?, closed_at = ?, updated_at = ? WHERE id = ? AND state = 'active'",
    ).run(state, evidence ? evidence.slice(0, GOAL_EVIDENCE_MAX) : null, now, now, id)
    return res.changes > 0
  }

  /** What the check saw: not a change of the goal, so updated_at stays. */
  markChecked(id: string, detail: string, now: number): void {
    this.db.prepare("UPDATE goals SET last_check = ?, last_check_at = ? WHERE id = ?").run(detail.slice(0, GOAL_EVIDENCE_MAX), now, id)
  }

  /** Active goals with a check last run at `before` or earlier (or never). */
  dueChecks(before: number): GoalRecord[] {
    return (this.db.prepare(
      "SELECT * FROM goals WHERE state = 'active' AND check_spec IS NOT NULL AND (last_check_at IS NULL OR last_check_at <= ?) ORDER BY last_check_at ASC LIMIT 50",
    ).all(before) as any[]).map(toGoal)
  }
}

export type GoalChecker = (check: GoalCheck) => Promise<CheckResult>

/** Run the check of every active goal not checked for `everyMinutes`.
 *  Met closes the goal as done with the check's evidence. Returns the ids
 *  closed. One goal's failure never stops the others. */
export async function checkGoals(store: GoalStore, check: GoalChecker, everyMinutes: number, now: number, log: (msg: string) => void = () => {}): Promise<string[]> {
  const closed: string[] = []
  for (const g of store.dueChecks(now - everyMinutes * 60_000)) {
    let res: CheckResult
    try {
      res = await check(g.check!)
    } catch (e: any) {
      res = { verdict: "unverifiable", detail: String(e?.message ?? e) }
    }
    store.markChecked(g.id, res.detail, now)
    if (res.verdict === "met" && store.close(g.id, "done", `check: ${res.detail}`, now)) {
      closed.push(g.id)
      log(`[goals] ${g.id} done: ${res.detail}`)
    } else if (res.verdict === "unverifiable") {
      log(`[goals] ${g.id}: check failed: ${res.detail}`)
    }
  }
  return closed
}

/** The goal's state for a cron prompt or a plan turn: a few lines. */
export function goalBrief(g: GoalRecord, counts?: { open: number; done: number } | null): string {
  const lines = [`[Goal] ${g.title} (${g.id}): ${g.state}${g.ownerAgent ? `, owner ${g.ownerAgent}` : ""}.`]
  if (g.doneWhen) lines.push(`Done when: ${g.doneWhen}`)
  if (g.check) lines.push(`Check: ${describeGoalCheck(g.check)}${g.lastCheck ? `; last seen: ${g.lastCheck}${g.lastCheckAt ? ` (${new Date(g.lastCheckAt).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}` : ""}`)
  if (counts) lines.push(`Requests under it: ${counts.open} open, ${counts.done} done.`)
  return lines.join("\n")
}
