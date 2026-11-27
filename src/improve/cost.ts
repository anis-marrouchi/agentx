// --- Cost signals: token waste, ranked like failures (#1995) ---
//
// The owner's goal (2026-11-19) is half the tokens for the same work. The
// self-improvement loop ranked failures every night but never saw cost.
// Five kinds are recorded here, once per run, after the run's reply is
// recorded, with no model call:
//
//   job_cost_high         a cron or workflow run used 3x or more its job
//                         type's median
//   start_no_cache_reuse  a new session wrote its start again although
//                         the same agent ran on the same model within the
//                         cache lifetime
//   context_rewrite       a call wrote most of its context to the cache again
//   model_switch          the main thread changed model
//   start_over_budget     a fresh start's first call read more than
//                         START_ALERT_TOKENS: the start-size guard (#2009).
//                         It reports; it never blocks a run
//
// A job type is agent + channel + (workflow id | cron job id | nothing).
// Its baseline is read from task_traces, the usage the daemon already
// keeps: no second store. Per-call numbers come from the run's callUsage
// (#1994); calls a subagent made are left out of the three per-call kinds
// (a subagent's fresh context is a deliberate saving, not waste) but count
// in job_cost_high, because they are paid.
//
// Every query forces idx_traces_agent_started and is bounded by
// started_at: on a 160k-row trace table the planner otherwise walks the
// status index for seconds (review of PR #2024). The thresholds are first
// guesses, constants until a week of real signals tunes them.

import type Database from "better-sqlite3"
import type { CallUsage, TaskUsage } from "@/daemon/token-tracker"
import { CACHE_TTL_MS } from "@/agents/prompt-cache"
import { emitSignal, signalDb, type Signal, type SignalKind } from "./signals"

export const COST_KINDS = ["job_cost_high", "start_no_cache_reuse", "context_rewrite", "model_switch", "start_over_budget"] as const satisfies readonly SignalKind[]
export const COST_KIND_SET = new Set<SignalKind>(COST_KINDS)

/** Past runs a job type needs before job_cost_high can fire. */
export const COST_MIN_PAST_RUNS = 10
export const COST_HIGH_FACTOR = 3
export const COST_HIGH_MIN_TOKENS = 50_000
export const BASELINE_RUNS = 30
export const BASELINE_DAYS = 14
export const START_WRITE_MIN = 20_000
/** The budget of a fresh start's first call: input + cache read + cache
 *  write (#2009). Named exceptions (full starts about 20k until #2002
 *  step 3) live on the issue, not in config. */
export const START_BUDGET_TOKENS = 15_000
/** The line start_over_budget fires above, for now. Full starts are about
 *  48-62k today, so a signal at the budget would fire on nearly every chat
 *  start (about 400 rows a day, review of PR #2035). Until #2009 part 2
 *  lands it catches regressions only; it is then lowered to
 *  START_BUDGET_TOKENS. start_tokens is recorded for every fresh start. */
export const START_ALERT_TOKENS = 64_000
export const REWRITE_SHARE = 0.8
export const REWRITE_MIN_CONTEXT = 20_000
/** The most one cost problem scores in a ranking window, whatever its
 *  kind's weight or row count: below 3 owner reopens (3 x 3 = 9), so token
 *  waste never pushes the owner's failures out of the nightly hand-off. */
export const COST_SCORE_CAP = 8
/** How far back the previous run of an agent or chat is looked for. */
const PREVIOUS_RUN_LOOKBACK_MS = 86_400_000

const DAY_MS = 86_400_000

export interface JobType {
  agentId: string
  channel: string
  workflowId: string | null
  cronId: string | null
  /** A run the daemon itself started (task_traces.wake_kind, #2012), when
   *  it is not a cron or workflow run. */
  wakeKind: string | null
}

/** The job type of a run. A `workflow:<id>` chatId names the run, not the
 *  workflow, so only `workflowId` says which workflow it is. A workflow or
 *  cron wins over the wake kind. */
export function jobTypeOf(agentId: string, channel: string, chatId: string | null | undefined, workflowId: string | null | undefined, wakeKind?: string | null): JobType {
  const cronId = !workflowId && typeof chatId === "string" && chatId.startsWith("cron:") ? chatId.slice(5) || null : null
  return { agentId, channel, workflowId: workflowId || null, cronId, wakeKind: !workflowId && !cronId && wakeKind ? wakeKind : null }
}

/** A cron job, a workflow or a kind of daemon wake: work that repeats,
 *  so its median means something. A chat job type lumps unrelated
 *  conversations together. */
export function hasJobIdentity(jt: JobType): boolean {
  return !!(jt.workflowId || jt.cronId || jt.wakeKind)
}

/** The words every cost detail starts with. They survive normalizeDetail,
 *  so one job type stays one group. */
export function jobKey(jt: JobType): string {
  return `job ${jt.channel} ${jt.workflowId ?? jt.cronId ?? (jt.wakeKind ? `wake:${jt.wakeKind}` : "chat")}`
}

/** Base + tier2 tokens of a trace row; tier2 is NULL before v12. */
const TOTAL_SQL = `(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_create_tokens, 0)
  + COALESCE(tier2_input_tokens, 0) + COALESCE(tier2_output_tokens, 0) + COALESCE(tier2_cache_read_tokens, 0) + COALESCE(tier2_cache_create_tokens, 0))`

const FROM_TRACES = "FROM task_traces INDEXED BY idx_traces_agent_started"

function jobWhere(jt: JobType): { sql: string; args: unknown[] } {
  const base = "agent_id = ? AND channel = ?"
  if (jt.workflowId) return { sql: `${base} AND workflow_id = ?`, args: [jt.agentId, jt.channel, jt.workflowId] }
  if (jt.cronId) return { sql: `${base} AND chat_id = ?`, args: [jt.agentId, jt.channel, `cron:${jt.cronId}`] }
  const chat = `${base} AND workflow_id IS NULL AND (chat_id IS NULL OR (chat_id NOT LIKE 'cron:%' AND chat_id NOT LIKE 'workflow:%'))`
  if (jt.wakeKind) return { sql: `${chat} AND wake_kind = ?`, args: [jt.agentId, jt.channel, jt.wakeKind] }
  return {
    sql: `${chat} AND wake_kind IS NULL`,
    args: [jt.agentId, jt.channel],
  }
}

export function runTotal(u: TaskUsage | undefined): number {
  return u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreateTokens : 0
}

const context = (c: CallUsage) => c.inputTokens + c.cacheReadTokens + c.cacheCreateTokens
const k = (n: number) => `${Math.round(n / 1000)}k`

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** What a fresh start's first main call read: input + cache read + cache
 *  write. Null for a resumed run, or when the runtime reports no per-call
 *  numbers (only Claude Code does). Stored in task_traces.start_tokens. */
export function startTokens(run: Pick<CostRun, "resumed" | "calls">): number | null {
  if (run.resumed) return null
  const first = (run.calls ?? []).find((c) => !c.sub)
  return first ? context(first) : null
}

export interface CostRun {
  /** The run's trace task id: the signal's ref. */
  taskId: string
  agentId: string
  channel: string
  chatId?: string | null
  workflowId?: string | null
  /** task_traces.wake_kind (#2012). */
  wakeKind?: string | null
  startedAt: number
  /** Continued a provider session. */
  resumed: boolean
  resumeSessionId?: string | null
  /** The model the run was billed on, as task_traces.model stores it. */
  model?: string | null
  usage?: TaskUsage
  calls?: CallUsage[]
}

interface PreviousRun { finishedAt: number; model: string | null }

export interface CostHistory {
  /** Totals of the job type's past successful runs, newest first. */
  pastTotals?: number[]
  /** The same agent's last run that ended within the cache lifetime before
   *  this one started; null when none did. */
  lastAgentRun?: PreviousRun | null
  /** The previous finished run in the same conversation (agent, channel,
   *  chat) within a day, for a resumed run; null when there is none. */
  chatPrev?: PreviousRun | null
}

/** The cost signals of one finished run. Pure: no database, no clock. */
export function costSignals(run: CostRun, history: CostHistory = {}): Signal[] {
  const jt = jobTypeOf(run.agentId, run.channel, run.chatId, run.workflowId, run.wakeKind)
  const key = jobKey(jt)
  const out: Signal[] = []
  const add = (kind: SignalKind, detail: string) => out.push({ kind, agentId: run.agentId, ref: run.taskId, detail: `${key}: ${detail}` })

  const total = runTotal(run.usage)
  const past = history.pastTotals ?? []
  if (hasJobIdentity(jt) && past.length >= COST_MIN_PAST_RUNS && total >= COST_HIGH_MIN_TOKENS) {
    const med = median(past)
    if (med > 0 && total >= COST_HIGH_FACTOR * med) add("job_cost_high", `${(total / med).toFixed(1)}x median`)
  }

  const main = (run.calls ?? []).filter((c) => !c.sub)
  const first = main[0]
  const last = history.lastAgentRun
  if (!run.resumed && first && first.cacheReadTokens === 0 && first.cacheCreateTokens >= START_WRITE_MIN && last
    && run.startedAt - last.finishedAt <= CACHE_TTL_MS && run.startedAt >= last.finishedAt
    && !!run.model && last.model === run.model) {
    add("start_no_cache_reuse", `fresh start wrote ${k(first.cacheCreateTokens)}, last run ${Math.round((run.startedAt - last.finishedAt) / 60_000)} min ago`)
  }

  // The first call of a new session has to write its context, and so does
  // the first call of a resumed one once the cache has expired: neither is
  // waste. Any other call that writes most of its context again lost it.
  const prev = history.chatPrev
  const firstWarm = run.resumed && !!prev && run.startedAt - prev.finishedAt <= CACHE_TTL_MS
  const rewrites = main.filter((c, i) => (i > 0 || firstWarm) && context(c) >= REWRITE_MIN_CONTEXT && c.cacheCreateTokens >= REWRITE_SHARE * context(c))
  if (rewrites.length) {
    const worst = rewrites.reduce((a, b) => (b.cacheCreateTokens > a.cacheCreateTokens ? b : a))
    add("context_rewrite", `rewrite ${k(worst.cacheCreateTokens)} of ${k(context(worst))}`)
  }

  const models = main.map((c) => c.model).filter((m): m is string => !!m)
  const switched = models.findIndex((m, i) => i > 0 && m !== models[i - 1])
  if (switched > 0) add("model_switch", `${models[switched - 1]} → ${models[switched]}`)
  else if (run.resumed && prev?.model && run.model && prev.model !== run.model) {
    add("model_switch", `${prev.model} → ${run.model}`)
  }

  const start = startTokens(run)
  if (start !== null && start > START_ALERT_TOKENS) add("start_over_budget", `fresh start ${k(start)}, budget ${k(START_BUDGET_TOKENS)}`)
  return out
}

// --- The queries: each forces the agent index and is bounded in time ---

export interface Query { sql: string; args: unknown[] }

/** The job type's past successful runs, last BASELINE_DAYS. */
export function baselineQuery(run: CostRun, now: number): Query {
  const w = jobWhere(jobTypeOf(run.agentId, run.channel, run.chatId, run.workflowId, run.wakeKind))
  return {
    sql: `SELECT ${TOTAL_SQL} AS t ${FROM_TRACES} WHERE ${w.sql} AND started_at >= ? AND started_at < ?
      AND status = 'ok' AND task_id != ? AND ${TOTAL_SQL} > 0 ORDER BY started_at DESC LIMIT ?`,
    args: [...w.args, now - BASELINE_DAYS * DAY_MS, run.startedAt, run.taskId, BASELINE_RUNS],
  }
}

/** The agent's last run that ended within the cache lifetime before this one. */
export function lastAgentRunQuery(run: CostRun): Query {
  return {
    sql: `SELECT finished_at AS finishedAt, model ${FROM_TRACES} WHERE agent_id = ? AND started_at >= ? AND started_at < ?
      AND task_id != ? AND finished_at IS NOT NULL AND finished_at <= ? AND finished_at >= ? ORDER BY finished_at DESC LIMIT 1`,
    args: [run.agentId, run.startedAt - PREVIOUS_RUN_LOOKBACK_MS, run.startedAt, run.taskId, run.startedAt, run.startedAt - CACHE_TTL_MS],
  }
}

/** The previous finished run in the same conversation, within a day. */
export function chatPrevQuery(run: CostRun): Query {
  return {
    sql: `SELECT finished_at AS finishedAt, model ${FROM_TRACES} WHERE agent_id = ? AND started_at >= ? AND started_at < ?
      AND channel = ? AND chat_id IS ? AND task_id != ? AND finished_at IS NOT NULL AND finished_at <= ?
      ORDER BY finished_at DESC LIMIT 1`,
    args: [run.agentId, run.startedAt - PREVIOUS_RUN_LOOKBACK_MS, run.startedAt, run.channel, run.chatId ?? null, run.taskId, run.startedAt],
  }
}

/** A job type's successful runs started in [from, to), with their totals. */
export function jobRunsQuery(jt: JobType, from: number, to: number): Query {
  const w = jobWhere(jt)
  return {
    sql: `SELECT task_id AS taskId, ${TOTAL_SQL} AS t ${FROM_TRACES} WHERE ${w.sql} AND started_at >= ? AND started_at < ?
      AND status = 'ok' AND ${TOTAL_SQL} > 0`,
    args: [...w.args, from, to],
  }
}

/** What `costSignals` needs from task_traces, read only when the run could
 *  fire the kind it is for. Synchronous; the caller catches. */
export function readCostHistory(db: Database.Database, run: CostRun, now = Date.now()): CostHistory {
  const h: CostHistory = {}
  const jt = jobTypeOf(run.agentId, run.channel, run.chatId, run.workflowId, run.wakeKind)
  if (hasJobIdentity(jt) && runTotal(run.usage) >= COST_HIGH_MIN_TOKENS) {
    const q = baselineQuery(run, now)
    h.pastTotals = (db.prepare(q.sql).all(...q.args) as Array<{ t: number }>).map((r) => r.t)
  }
  const first = (run.calls ?? []).find((c) => !c.sub)
  if (!run.resumed && first && first.cacheReadTokens === 0 && first.cacheCreateTokens >= START_WRITE_MIN) {
    const q = lastAgentRunQuery(run)
    h.lastAgentRun = (db.prepare(q.sql).get(...q.args) as PreviousRun | undefined) ?? null
  }
  if (run.resumed) {
    const q = chatPrevQuery(run)
    h.chatPrev = (db.prepare(q.sql).get(...q.args) as PreviousRun | undefined) ?? null
  }
  return h
}

/** Record a finished run's cost signals through the daemon's signal sink.
 *  Never throws: a failed read logs and records nothing. */
export function emitCostSignals(run: CostRun, now = Date.now()): void {
  try {
    const db = signalDb()
    if (!db) return
    for (const s of costSignals(run, readCostHistory(db, run, now))) emitSignal(s, now)
  } catch (e: any) {
    console.warn(`[improve] cost signals skipped for ${run.taskId}: ${String(e?.message ?? e).slice(0, 200)}`)
  }
}

/** Emit on a later tick, so the reads never sit between a run and its
 *  reply. Never throws. */
export function queueCostSignals(run: CostRun, now?: number): void {
  try {
    setImmediate(() => emitCostSignals(run, now ?? Date.now()))
  } catch { /* never in the reply's way */ }
}

// --- The held check of a cost fix (stage 4) ---

/** The job types of the runs `taskIds` name. */
export function jobTypesOfTraces(db: Database.Database, taskIds: string[]): JobType[] {
  const out = new Map<string, JobType>()
  const stmt = db.prepare("SELECT agent_id AS agentId, channel, chat_id AS chatId, workflow_id AS workflowId, wake_kind AS wakeKind FROM task_traces WHERE task_id = ?")
  for (const id of new Set(taskIds)) {
    const r = stmt.get(id) as { agentId: string; channel: string | null; chatId: string | null; workflowId: string | null; wakeKind: string | null } | undefined
    if (!r) continue
    const jt = jobTypeOf(r.agentId, r.channel ?? "", r.chatId, r.workflowId, r.wakeKind)
    out.set(`${jt.agentId}|${jt.channel}|${jobKey(jt)}`, jt)
  }
  return [...out.values()]
}

/** Successful runs of the job types started in [from, to), and their
 *  median tokens per run. The runs in `flagged` (the problem's own refs)
 *  are left out: they were picked for being costly, so counting them makes
 *  any later window look cheaper. When every run was flagged, all count. */
export function tokensPerRun(db: Database.Database, jobTypes: JobType[], from: number, to: number, flagged: Set<string> = new Set()): { runs: number; perRun: number } {
  const all: Array<{ taskId: string; t: number }> = []
  for (const jt of jobTypes) {
    const q = jobRunsQuery(jt, from, to)
    all.push(...(db.prepare(q.sql).all(...q.args) as Array<{ taskId: string; t: number }>))
  }
  const clean = all.filter((r) => !flagged.has(r.taskId))
  const use = clean.length ? clean : all
  return { runs: use.length, perRun: Math.round(median(use.map((r) => r.t))) }
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
