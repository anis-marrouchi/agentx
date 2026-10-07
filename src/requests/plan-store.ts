import type Database from "better-sqlite3"
import { TEXT_MAX } from "./store"

// --- Tracked plans: the steps of one open request (#788) ---
//
// A request that takes several steps (build, deploy, check it is live,
// tell the client) gets one plan. Each step has an owner agent and a
// "done when" check; steps run in order. The daemon's plan check
// (plan-sweep.ts) starts each step, nudges a step that went quiet, sends an
// approved message itself, and tells the owner once at the end or when a
// step is blocked.
//
// Stored beside the request in .agentx/db.sqlite. A plan is deleted with
// its request (retention), never on its own.

export type PlanState = "active" | "done" | "closed"
export type StepState = "pending" | "active" | "done" | "blocked" | "skipped"
export type ApprovalState = "none" | "pending" | "approved" | "declined" | "expired"

export const FINISHED_STEP_STATES: readonly StepState[] = ["done", "skipped"]

export interface PlanRecord {
  requestId: string
  /** The agent that accepted the request and wrote the plan. */
  createdBy: string
  createdAt: number
  state: PlanState
  finishedAt: number | null
  /** When the owner was sent the summary. Sent once. */
  notifiedAt: number | null
}

export interface PlanStep {
  requestId: string
  /** 1-based position: steps run in this order. */
  idx: number
  name: string
  /** "message": the daemon sends `message` itself. Any other kind is work
   *  the owner agent does and reports. */
  kind: string
  agentId: string
  /** What proves the step is done, in words. */
  doneWhen: string
  state: StepState
  /** The owner approved this step when the plan was made (approveKinds). */
  needsApproval: boolean
  approval: ApprovalState
  cardId: string | null
  message: string | null
  toChannel: string | null
  toChat: string | null
  toAccount: string | null
  /** The daemon marks the step done when this address answers (and shows
   *  `checkContains`, when set). */
  checkUrl: string | null
  checkContains: string | null
  /** This step's own stall time; null: the setting. */
  stallMinutes: number | null
  evidence: string | null
  /** Why it is blocked or skipped. */
  note: string | null
  /** When its owner agent was given the step. */
  dispatchedAt: number | null
  /** Last progress on the step. */
  updatedAt: number
  nudges: number
  lastNudgeAt: number | null
  /** When the owner was told the step is blocked. */
  notifiedAt: number | null
}

export interface PlanEvent {
  requestId: string
  step: number | null
  at: number
  kind: string
  detail: string
}

export type NewStep = Pick<PlanStep, "name" | "kind" | "agentId" | "doneWhen" | "needsApproval">
  & Partial<Pick<PlanStep, "message" | "toChannel" | "toChat" | "toAccount" | "checkUrl" | "checkContains" | "stallMinutes">>

const DETAIL_MAX = 1000

export function ensurePlanTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_plans (
      request_id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      finished_at INTEGER,
      notified_at INTEGER,
      FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_request_plans_state ON request_plans(state);
    CREATE TABLE IF NOT EXISTS request_plan_steps (
      request_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      done_when TEXT NOT NULL,
      state TEXT NOT NULL,
      needs_approval INTEGER NOT NULL DEFAULT 0,
      approval TEXT NOT NULL DEFAULT 'none',
      card_id TEXT,
      message TEXT,
      to_channel TEXT,
      to_chat TEXT,
      to_account TEXT,
      check_url TEXT,
      check_contains TEXT,
      stall_minutes REAL,
      evidence TEXT,
      note TEXT,
      dispatched_at INTEGER,
      updated_at INTEGER NOT NULL,
      nudges INTEGER NOT NULL DEFAULT 0,
      last_nudge_at INTEGER,
      notified_at INTEGER,
      PRIMARY KEY (request_id, idx),
      FOREIGN KEY (request_id) REFERENCES request_plans(request_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS request_plan_events (
      request_id TEXT NOT NULL,
      step INTEGER,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES request_plans(request_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_request_plan_events ON request_plan_events(request_id, at);
  `)
}

export function hasPlanTables(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'request_plans'").get()
}

function toPlan(r: any): PlanRecord {
  return {
    requestId: r.request_id, createdBy: r.created_by, createdAt: r.created_at, state: r.state,
    finishedAt: r.finished_at ?? null, notifiedAt: r.notified_at ?? null,
  }
}

function toStep(r: any): PlanStep {
  return {
    requestId: r.request_id, idx: r.idx, name: r.name, kind: r.kind, agentId: r.agent_id, doneWhen: r.done_when,
    state: r.state, needsApproval: !!r.needs_approval, approval: r.approval, cardId: r.card_id ?? null,
    message: r.message ?? null, toChannel: r.to_channel ?? null, toChat: r.to_chat ?? null, toAccount: r.to_account ?? null,
    checkUrl: r.check_url ?? null, checkContains: r.check_contains ?? null, stallMinutes: r.stall_minutes ?? null,
    evidence: r.evidence ?? null, note: r.note ?? null, dispatchedAt: r.dispatched_at ?? null, updatedAt: r.updated_at,
    nudges: r.nudges, lastNudgeAt: r.last_nudge_at ?? null, notifiedAt: r.notified_at ?? null,
  }
}

/** Fields a step update may change, by their column. */
const STEP_COLUMNS: Record<string, string> = {
  state: "state", approval: "approval", cardId: "card_id", message: "message", evidence: "evidence", note: "note",
  dispatchedAt: "dispatched_at", updatedAt: "updated_at", nudges: "nudges", lastNudgeAt: "last_nudge_at", notifiedAt: "notified_at",
}

export type StepPatch = Partial<Pick<PlanStep,
  "state" | "approval" | "cardId" | "message" | "evidence" | "note" | "dispatchedAt" | "updatedAt" | "nudges" | "lastNudgeAt" | "notifiedAt">>

export class PlanStore {
  constructor(private db: Database.Database) {
    ensurePlanTables(db)
  }

  /** Record a plan for an open request. Step 1 starts active: the agent
   *  that wrote the plan is in the turn and, when it owns step 1, already
   *  at work on it. */
  create(requestId: string, createdBy: string, steps: NewStep[], now: number): void {
    const insertPlan = this.db.prepare(
      "INSERT INTO request_plans (request_id, created_by, created_at, state) VALUES (?, ?, ?, 'active')",
    )
    const insertStep = this.db.prepare(
      `INSERT INTO request_plan_steps (request_id, idx, name, kind, agent_id, done_when, state, needs_approval, message,
         to_channel, to_chat, to_account, check_url, check_contains, stall_minutes, dispatched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      insertPlan.run(requestId, createdBy, now)
      steps.forEach((s, i) => {
        const first = i === 0
        // The writer already has step 1 when it is theirs; anyone else's
        // step 1 is handed over by the plan check.
        const own = first && s.agentId === createdBy && s.kind !== "message"
        insertStep.run(
          requestId, i + 1, s.name, s.kind, s.agentId, s.doneWhen, first ? "active" : "pending", s.needsApproval ? 1 : 0,
          s.message ?? null, s.toChannel ?? null, s.toChat ?? null, s.toAccount ?? null, s.checkUrl ?? null,
          s.checkContains ?? null, s.stallMinutes ?? null, own ? now : null, now,
        )
      })
      this.event(requestId, null, "created", `${steps.length} steps, written by ${createdBy}`, now)
    })()
  }

  get(requestId: string): PlanRecord | null {
    const row = this.db.prepare("SELECT * FROM request_plans WHERE request_id = ?").get(requestId)
    return row ? toPlan(row) : null
  }

  steps(requestId: string): PlanStep[] {
    return this.db.prepare("SELECT * FROM request_plan_steps WHERE request_id = ? ORDER BY idx").all(requestId).map(toStep)
  }

  step(requestId: string, idx: number): PlanStep | null {
    const row = this.db.prepare("SELECT * FROM request_plan_steps WHERE request_id = ? AND idx = ?").get(requestId, idx)
    return row ? toStep(row) : null
  }

  /** Plans the check still follows, oldest first. */
  listActive(): PlanRecord[] {
    return this.db.prepare("SELECT * FROM request_plans WHERE state = 'active' ORDER BY created_at, rowid").all().map(toPlan)
  }

  updateStep(requestId: string, idx: number, patch: StepPatch): void {
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      const col = STEP_COLUMNS[key]
      if (!col || value === undefined) continue
      sets.push(`${col} = ?`)
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value)
    }
    if (!sets.length) return
    this.db.prepare(`UPDATE request_plan_steps SET ${sets.join(", ")} WHERE request_id = ? AND idx = ?`).run(...values, requestId, idx)
  }

  /** The plan ended: every step finished ("done"), or its request was
   *  closed first ("closed"). */
  finish(requestId: string, state: Exclude<PlanState, "active">, now: number): boolean {
    return this.db.prepare(
      "UPDATE request_plans SET state = ?, finished_at = ? WHERE request_id = ? AND state = 'active'",
    ).run(state, now, requestId).changes > 0
  }

  markNotified(requestId: string, now: number | null): void {
    this.db.prepare("UPDATE request_plans SET notified_at = ? WHERE request_id = ?").run(now, requestId)
  }

  /** Finished plans whose summary has not reached the owner yet. */
  awaitingSummary(): PlanRecord[] {
    return this.db.prepare("SELECT * FROM request_plans WHERE state = 'done' AND notified_at IS NULL ORDER BY finished_at").all().map(toPlan)
  }

  /** What happened, in order: the plan's log. */
  event(requestId: string, step: number | null, kind: string, detail: string, now: number): void {
    this.db.prepare("INSERT INTO request_plan_events (request_id, step, at, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .run(requestId, step, now, kind, detail.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX))
  }

  events(requestId: string, limit = 200): PlanEvent[] {
    return (this.db.prepare(
      "SELECT request_id, step, at, kind, detail FROM request_plan_events WHERE request_id = ? ORDER BY at, rowid LIMIT ?",
    ).all(requestId, limit) as any[]).map((r) => ({ requestId: r.request_id, step: r.step ?? null, at: r.at, kind: r.kind, detail: r.detail }))
  }
}

export const STEP_TEXT_MAX = TEXT_MAX
