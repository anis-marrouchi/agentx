// --- Cost signals: token waste, ranked like failures (#1995) ---
//
// The owner's goal (2026-11-19) is half the tokens for the same work. The
// self-improvement loop ranked failures every night but never saw cost.
// Four kinds are recorded here, once per run, right after the run ends,
// with no model call:
//
//   job_cost_high         the run used 3x or more its job type's median
//   start_no_cache_reuse  a new session wrote its start again although
//                         the same agent ran on the same model minutes ago
//   context_rewrite       a call wrote most of its context to the cache again
//   model_switch          the main thread changed model
//
// A job type is agent + channel + (workflow id | cron job id | nothing).
// Its baseline is read from task_traces, the usage the daemon already
// keeps: no second store. Per-call numbers come from the run's callUsage
// (#1994); calls a subagent made are left out of the three per-call kinds
// (a subagent's fresh context is a deliberate saving, not waste) but count
// in job_cost_high, because they are paid.
//
// The thresholds are first guesses, constants until a week of real
// signals tunes them.

import type Database from "better-sqlite3"
import type { CallUsage, TaskUsage } from "@/daemon/token-tracker"
import { emitSignal, signalDb, type Signal, type SignalKind } from "./signals"

export const COST_KINDS = ["job_cost_high", "start_no_cache_reuse", "context_rewrite", "model_switch"] as const satisfies readonly SignalKind[]
export const COST_KIND_SET = new Set<SignalKind>(COST_KINDS)

/** Past runs a job type needs before job_cost_high can fire. */
export const COST_MIN_PAST_RUNS = 10
export const COST_HIGH_FACTOR = 3
export const COST_HIGH_MIN_TOKENS = 50_000
export const BASELINE_RUNS = 30
export const BASELINE_DAYS = 14
/** The provider's cache lifetime: a prefix written longer ago is gone. */
export const CACHE_WINDOW_MS = 5 * 60_000
export const START_WRITE_MIN = 20_000
export const REWRITE_SHARE = 0.8
export const REWRITE_MIN_CONTEXT = 20_000
/** Cost rows counted per group and day in the ranking (S1). */
export const COST_ROWS_PER_DAY = 5

const DAY_MS = 86_400_000

export interface JobType {
  agentId: string
  channel: string
  workflowId: string | null
  cronId: string | null
}

/** The job type of a run. A `workflow:<id>` chatId names the run, not the
 *  workflow, so only `workflowId` says which workflow it is. */
export function jobTypeOf(agentId: string, channel: string, chatId: string | null | undefined, workflowId: string | null | undefined): JobType {
  const cronId = !workflowId && typeof chatId === "string" && chatId.startsWith("cron:") ? chatId.slice(5) || null : null
  return { agentId, channel, workflowId: workflowId || null, cronId }
}

/** The words every cost detail starts with. They survive normalizeDetail,
 *  so one job type stays one group. */
export function jobKey(jt: JobType): string {
  return `job ${jt.channel} ${jt.workflowId ?? jt.cronId ?? "chat"}`
}

/** Base + tier2 tokens of a trace row; tier2 is NULL before v12. */
const TOTAL_SQL = `(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_create_tokens, 0)
  + COALESCE(tier2_input_tokens, 0) + COALESCE(tier2_output_tokens, 0) + COALESCE(tier2_cache_read_tokens, 0) + COALESCE(tier2_cache_create_tokens, 0))`

function jobWhere(jt: JobType): { sql: string; args: unknown[] } {
  const base = "agent_id = ? AND channel = ?"
  if (jt.workflowId) return { sql: `${base} AND workflow_id = ?`, args: [jt.agentId, jt.channel, jt.workflowId] }
  if (jt.cronId) return { sql: `${base} AND chat_id = ?`, args: [jt.agentId, jt.channel, `cron:${jt.cronId}`] }
  return {
    sql: `${base} AND workflow_id IS NULL AND (chat_id IS NULL OR (chat_id NOT LIKE 'cron:%' AND chat_id NOT LIKE 'workflow:%'))`,
    args: [jt.agentId, jt.channel],
  }
}

export function runTotal(u: TaskUsage | undefined): number {
  return u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreateTokens : 0
}

const context = (c: CallUsage) => c.inputTokens + c.cacheReadTokens + c.cacheCreateTokens
const k = (n: number) => `${Math.round(n / 1000)}k`

export interface CostRun {
  /** The run's trace task id: the signal's ref. */
  taskId: string
  agentId: string
  channel: string
  chatId?: string | null
  workflowId?: string | null
  startedAt: number
  /** Continued a provider session. */
  resumed: boolean
  resumeSessionId?: string | null
  /** The model the run was billed on, as task_traces.model stores it. */
  model?: string | null
  usage?: TaskUsage
  calls?: CallUsage[]
}

export interface CostHistory {
  /** Totals of the job type's past successful runs, newest first. */
  pastTotals?: number[]
  /** The same agent's last run that ended in the cache window before this
   *  one started; null when none did. */
  lastAgentRun?: { finishedAt: number; model: string | null } | null
  /** The model of the previous run in the same conversation (agent,
   *  channel, chat), for a resumed run. */
  sessionPrevModel?: string | null
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The cost signals of one finished run. Pure: no database, no clock. */
export function costSignals(run: CostRun, history: CostHistory = {}): Signal[] {
  const jt = jobTypeOf(run.agentId, run.channel, run.chatId, run.workflowId)
  const key = jobKey(jt)
  const out: Signal[] = []
  const add = (kind: SignalKind, detail: string) => out.push({ kind, agentId: run.agentId, ref: run.taskId, detail: `${key}: ${detail}` })

  const total = runTotal(run.usage)
  const past = history.pastTotals ?? []
  if (past.length >= COST_MIN_PAST_RUNS && total >= COST_HIGH_MIN_TOKENS) {
    const med = median(past)
    if (med > 0 && total >= COST_HIGH_FACTOR * med) add("job_cost_high", `${(total / med).toFixed(1)}x median`)
  }

  const main = (run.calls ?? []).filter((c) => !c.sub)
  const first = main[0]
  const last = history.lastAgentRun
  if (!run.resumed && first && first.cacheReadTokens === 0 && first.cacheCreateTokens >= START_WRITE_MIN && last
    && run.startedAt - last.finishedAt <= CACHE_WINDOW_MS && run.startedAt >= last.finishedAt
    && !!run.model && last.model === run.model) {
    add("start_no_cache_reuse", `fresh start wrote ${k(first.cacheCreateTokens)}, last run ${Math.round((run.startedAt - last.finishedAt) / 60_000)} min ago`)
  }

  // The first call of a new session has to write its context; any other
  // call that writes most of it again lost the cache.
  const rewrites = main.filter((c, i) => (i > 0 || run.resumed) && context(c) >= REWRITE_MIN_CONTEXT && c.cacheCreateTokens >= REWRITE_SHARE * context(c))
  if (rewrites.length) {
    const worst = rewrites.reduce((a, b) => (b.cacheCreateTokens > a.cacheCreateTokens ? b : a))
    add("context_rewrite", `rewrite ${k(worst.cacheCreateTokens)} of ${k(context(worst))}`)
  }

  const models = main.map((c) => c.model).filter((m): m is string => !!m)
  const switched = models.findIndex((m, i) => i > 0 && m !== models[i - 1])
  if (switched > 0) add("model_switch", `${models[switched - 1]} → ${models[switched]}`)
  else if (run.resumed && history.sessionPrevModel && run.model && history.sessionPrevModel !== run.model) {
    add("model_switch", `${history.sessionPrevModel} → ${run.model}`)
  }
  return out
}

/** What `costSignals` needs from task_traces, read only when the run could
 *  fire the kind it is for. Synchronous; the caller catches. */
export function readCostHistory(db: Database.Database, run: CostRun, now = Date.now()): CostHistory {
  const h: CostHistory = {}
  if (runTotal(run.usage) >= COST_HIGH_MIN_TOKENS) {
    const w = jobWhere(jobTypeOf(run.agentId, run.channel, run.chatId, run.workflowId))
    const rows = db.prepare(
      `SELECT ${TOTAL_SQL} AS t FROM task_traces WHERE ${w.sql} AND status = 'ok' AND task_id != ?
       AND started_at >= ? AND started_at < ? AND ${TOTAL_SQL} > 0 ORDER BY started_at DESC LIMIT ?`,
    ).all(...w.args, run.taskId, now - BASELINE_DAYS * DAY_MS, run.startedAt, BASELINE_RUNS) as Array<{ t: number }>
    h.pastTotals = rows.map((r) => r.t)
  }
  const first = (run.calls ?? []).find((c) => !c.sub)
  if (!run.resumed && first && first.cacheReadTokens === 0 && first.cacheCreateTokens >= START_WRITE_MIN) {
    const row = db.prepare(
      `SELECT finished_at AS finishedAt, model FROM task_traces WHERE agent_id = ? AND task_id != ?
       AND finished_at IS NOT NULL AND finished_at <= ? AND finished_at >= ? ORDER BY finished_at DESC LIMIT 1`,
    ).get(run.agentId, run.taskId, run.startedAt, run.startedAt - CACHE_WINDOW_MS) as { finishedAt: number; model: string | null } | undefined
    h.lastAgentRun = row ?? null
  }
  if (run.resumed) {
    const row = db.prepare(
      `SELECT model FROM task_traces WHERE agent_id = ? AND channel = ? AND chat_id IS ? AND task_id != ?
       AND finished_at IS NOT NULL AND finished_at <= ? AND model IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    ).get(run.agentId, run.channel, run.chatId ?? null, run.taskId, run.startedAt) as { model: string } | undefined
    h.sessionPrevModel = row?.model ?? null
  }
  return h
}

/** Record a finished run's cost signals through the daemon's signal sink.
 *  Never throws, never blocks: a failed read logs and records nothing. */
export function emitCostSignals(run: CostRun, now = Date.now()): void {
  try {
    const db = signalDb()
    if (!db) return
    for (const s of costSignals(run, readCostHistory(db, run, now))) emitSignal(s, now)
  } catch (e: any) {
    console.warn(`[improve] cost signals skipped for ${run.taskId}: ${String(e?.message ?? e).slice(0, 200)}`)
  }
}

// --- The held check of a cost fix (stage 4) ---

/** The job types of the runs `taskIds` name. */
export function jobTypesOfTraces(db: Database.Database, taskIds: string[]): JobType[] {
  const out = new Map<string, JobType>()
  const stmt = db.prepare("SELECT agent_id AS agentId, channel, chat_id AS chatId, workflow_id AS workflowId FROM task_traces WHERE task_id = ?")
  for (const id of new Set(taskIds)) {
    const r = stmt.get(id) as { agentId: string; channel: string | null; chatId: string | null; workflowId: string | null } | undefined
    if (!r) continue
    const jt = jobTypeOf(r.agentId, r.channel ?? "", r.chatId, r.workflowId)
    out.set(`${jt.agentId}|${jt.channel}|${jobKey(jt)}`, jt)
  }
  return [...out.values()]
}

/** Successful runs of the job types started in [from, to), and their mean
 *  tokens per run. */
export function tokensPerRun(db: Database.Database, jobTypes: JobType[], from: number, to: number): { runs: number; perRun: number } {
  let runs = 0
  let tokens = 0
  for (const jt of jobTypes) {
    const w = jobWhere(jt)
    const r = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(${TOTAL_SQL}), 0) AS t FROM task_traces WHERE ${w.sql} AND status = 'ok'
       AND started_at >= ? AND started_at < ? AND ${TOTAL_SQL} > 0`,
    ).get(...w.args, from, to) as { n: number; t: number }
    runs += r.n
    tokens += r.t
  }
  return { runs, perRun: runs ? Math.round(tokens / runs) : 0 }
}

/** Rows of the owner's own signals about `agentId` in [from, to). */
export function ownerReopens(db: Database.Database, agentId: string, from: number, to: number): number {
  try {
    return (db.prepare(
      "SELECT COUNT(*) AS n FROM improve_signals WHERE kind IN ('owner_reopened', 'owner_check_mismatch') AND agent_id = ? AND at >= ? AND at < ?",
    ).get(agentId, from, to) as { n: number }).n
  } catch {
    return 0
  }
}

/** Reopens "did not go up": at most one more, or 25% more from 4 up, so
 *  0 → 1 does not fail a real fix. */
export function reopensWithin(before: number, after: number): boolean {
  return after <= (before >= 4 ? 1.25 * before : before + 1)
}
