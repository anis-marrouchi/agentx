import type Database from "better-sqlite3"

// --- Mesh analytics — bounded aggregates over the operational SQLite ---
//
// The mesh page needs four things the raw tables don't answer directly:
//   1. how much work ran, day by day, split by what triggered it;
//   2. where it breaks — which origin, and which *class* of cause;
//   3. which recurring jobs burn runtime and return nothing ("zombies");
//   4. how long a conversation thread lives, and where it got cut.
//
// Everything here is an aggregate or a structural field. No message
// previews, no responses, no error bodies beyond a classified label and a
// truncated exemplar — a mesh list API must stay safe to fan out across
// nodes (see CLAUDE.md, "Full cron responses can contain sensitive
// content"). Callers that need a payload go to /traces/:id on the owning
// node, authenticated, one record at a time.
//
// Every query is windowed by `since` and capped by an explicit LIMIT, so a
// node with a year of history costs the same as one with a week.

/** Coarse failure classes, ordered most→least actionable by an operator. */
export type CauseId =
  | "auth" | "quota" | "connectivity" | "overload"
  | "timeout" | "crash" | "misconfig" | "other"

const CAUSE_RULES: Array<{ id: CauseId; test: RegExp }> = [
  { id: "auth", test: /401|authenticat|oauth|subscription access|invalid api key|forbidden/i },
  { id: "quota", test: /weekly limit|usage limit|rate limit|quota|429|credit balance/i },
  { id: "overload", test: /overloaded|529|temporarily unavailable/i },
  { id: "connectivity", test: /enotfound|econnrefused|connectionrefused|unable to connect|etimedout|socket hang up|certificate|connection closed/i },
  { id: "timeout", test: /timed out|sigterm|timeout/i },
  { id: "misconfig", test: /not found on path|install it|max child workflow depth|no such agent|unknown agent|missing/i },
  { id: "crash", test: /exited mid-turn|exited with code|process error|database is locked|panic|segfault/i },
]

/** Map one raw error string to a cause class. Deterministic and total. */
export function classifyCause(error: string | null | undefined): CauseId {
  const e = String(error || "")
  if (!e.trim()) return "other"
  for (const r of CAUSE_RULES) if (r.test.test(e)) return r.id
  return "other"
}

export type Origin = "cron" | "workflow" | "direct"
function originOf(channel: string | null): Origin {
  if (channel === "cron") return "cron"
  if (channel === "workflow") return "workflow"
  return "direct"
}

/** Verdict for a recurring job, derived only from its own counters. */
export type Verdict = "never-succeeded" | "zombie" | "fragile" | "healthy"

export interface JobRow {
  key: string
  label: string
  kind: "cron" | "workflow"
  agent: string
  runs: number
  errors: number
  okRuns: number
  hours: number
  avgMinutes: number
  /** Mean output tokens across SUCCESSFUL runs only — a failed run
   *  producing nothing is a failure, not a zombie. */
  avgOutput: number
  lastAt: number | null
  verdict: Verdict
}

/** Thresholds are policy, not measurement — named so the UI can cite them. */
export const ZOMBIE_MIN_RUNS = 5
export const ZOMBIE_MIN_AVG_SECONDS = 60
export const ZOMBIE_MAX_AVG_OUTPUT = 25
export const FRAGILE_ERROR_RATE = 0.3

function verdictFor(runs: number, errors: number, avgSec: number, avgOut: number): Verdict {
  if (runs >= ZOMBIE_MIN_RUNS && errors === runs) return "never-succeeded"
  const ok = runs - errors
  if (ok >= ZOMBIE_MIN_RUNS && avgSec >= ZOMBIE_MIN_AVG_SECONDS && avgOut < ZOMBIE_MAX_AVG_OUTPUT) return "zombie"
  if (runs >= ZOMBIE_MIN_RUNS && errors / runs >= FRAGILE_ERROR_RATE) return "fragile"
  return "healthy"
}

export interface MeshAnalytics {
  generatedAt: number
  windowDays: number
  since: number
  totals: { runs: number; errors: number; hours: number; agents: number; threads: number }
  days: Array<{ day: string; cron: number[]; workflow: number[]; direct: number[] }>
  origins: Array<{ channel: string; runs: number; errors: number; hours: number }>
  causes: Array<{ cause: CauseId; count: number; agents: string[]; example: string }>
  jobs: JobRow[]
  threads: ThreadRow[]
  rotations: {
    total: number
    byReason: Array<{ reason: string; count: number }>
    /** Sum + sample count rather than a pre-averaged number, so merging
     *  several nodes stays exact instead of averaging averages. */
    tokenSum: number
    tokenSamples: number
    maxTokens: number
  }
  retention: { tracesWithSteps: number; traces: number }
}

export interface ThreadRow {
  key: string
  agent: string
  channel: string
  chatId: string
  runs: number
  errors: number
  firstAt: number
  lastAt: number
  hours: number
  rotations: number
  rotationReasons: Array<{ reason: string; count: number }>
  /** Actual session-cut timestamps, so the UI plots real events instead of
   *  spacing ticks evenly along the bar. Capped per thread and evenly
   *  SAMPLED from the full list when it overflows — every tick shown is a
   *  real cut; `cutsShown < rotations` tells the UI to say so. */
  cuts: Array<{ at: number; reason: string }>
  cutsShown: number
}

type Row = Record<string, any>

/** `date()` in the caller's timezone, expressed as a fixed UTC offset in
 *  minutes. Avoids depending on the daemon host's TZ, which differs across
 *  mesh nodes and would make merged day buckets disagree. */
function dayExpr(col: string): string {
  // ADD the offset: local time is UTC plus minutes-east, so a Tunis (UTC+1)
  // caller at 23:30 UTC is already on the next local day. Subtracting here
  // is wrong for only one hour a day, which is exactly why it survives
  // eyeballing — the unit test is what catches it.
  return `date((${col} + @tzOffsetMs) / 1000, 'unixepoch')`
}

export interface AnalyticsOpts {
  /** Days of history to include, clamped 0..180. Zero is a real value and
   *  means "since local midnight" — a Today button that quietly showed the
   *  last 24 hours would span two calendar days and misname itself. */
  days?: number
  /** Minutes east of UTC, i.e. `-new Date().getTimezoneOffset()`. */
  tzOffsetMinutes?: number
  /** Max rows per unbounded list (jobs, threads). Clamped 1..200. */
  limit?: number
}

export function buildMeshAnalytics(db: Database.Database, opts: AnalyticsOpts = {}): MeshAnalytics {
  const days = Math.max(0, Math.min(180, Math.floor(opts.days ?? 30)))
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 60)))
  const tzOffsetMs = (opts.tzOffsetMinutes ?? 0) * 60_000
  const now = Date.now()
  const since = days === 0
    ? Math.floor((now + tzOffsetMs) / 86_400_000) * 86_400_000 - tzOffsetMs
    : now - days * 86_400_000
  const p = { since, tzOffsetMs, limit }

  const totals = db.prepare(`
    SELECT COUNT(*) runs,
           SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) errors,
           SUM(COALESCE(duration_ms,0)) ms,
           COUNT(DISTINCT agent_id) agents,
           COUNT(DISTINCT agent_id || '|' || COALESCE(channel,'') || '|' || COALESCE(chat_id,'')) threads
    FROM task_traces WHERE started_at >= @since
  `).get(p) as Row

  const dayRows = db.prepare(`
    SELECT ${dayExpr("started_at")} day,
           CASE channel WHEN 'cron' THEN 'cron' WHEN 'workflow' THEN 'workflow' ELSE 'direct' END origin,
           COUNT(*) runs,
           SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) errors
    FROM task_traces WHERE started_at >= @since
    GROUP BY 1, 2 ORDER BY 1
  `).all(p) as Row[]

  // Seed every day in the window, including today and any day nothing ran.
  // GROUP BY only emits days that have rows, and rendering that sparse list
  // as evenly spaced columns silently relabels the axis — a quiet Sunday
  // would vanish and every later column would shift left by one.
  const byDay = new Map<string, MeshAnalytics["days"][number]>()
  for (const day of dayKeysBetween(since, now, tzOffsetMs)) {
    byDay.set(day, { day, cron: [0, 0], workflow: [0, 0], direct: [0, 0] })
  }
  for (const r of dayRows) {
    let d = byDay.get(r.day)
    if (!d) { d = { day: r.day, cron: [0, 0], workflow: [0, 0], direct: [0, 0] }; byDay.set(r.day, d) }
    const bucket = d[r.origin as Origin]
    bucket[0] = r.runs - r.errors
    bucket[1] = r.errors
  }

  const origins = (db.prepare(`
    SELECT COALESCE(channel,'unknown') channel, COUNT(*) runs,
           SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) errors,
           SUM(COALESCE(duration_ms,0)) ms
    FROM task_traces WHERE started_at >= @since
    GROUP BY 1 ORDER BY runs DESC LIMIT 20
  `).all(p) as Row[]).map((r) => ({
    channel: r.channel, runs: r.runs, errors: r.errors, hours: round(r.ms / 3_600_000, 2),
  }))

  // Distinct error strings are few (tens), but cap anyway so a node with
  // high-cardinality errors can't blow the payload.
  const errRows = db.prepare(`
    SELECT COALESCE(error,'') error, agent_id, COUNT(*) c
    FROM task_traces
    WHERE started_at >= @since AND status IN ('error','timeout')
    GROUP BY 1, 2 ORDER BY c DESC LIMIT 400
  `).all(p) as Row[]
  const causeMap = new Map<CauseId, { count: number; agents: Map<string, number>; example: string }>()
  for (const r of errRows) {
    const id = classifyCause(r.error)
    let c = causeMap.get(id)
    if (!c) { c = { count: 0, agents: new Map(), example: "" }; causeMap.set(id, c) }
    c.count += r.c
    c.agents.set(r.agent_id, (c.agents.get(r.agent_id) || 0) + r.c)
    if (!c.example && r.error) c.example = String(r.error).slice(0, 120)
  }
  const causes = [...causeMap.entries()]
    .map(([cause, c]) => ({
      cause,
      count: c.count,
      agents: [...c.agents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]),
      example: c.example,
    }))
    .sort((a, b) => b.count - a.count)

  const jobs = [
    ...(db.prepare(`
      SELECT chat_id key, agent_id agent, COUNT(*) runs,
             SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) errors,
             SUM(COALESCE(duration_ms,0)) ms,
             SUM(CASE WHEN status = 'ok' THEN COALESCE(output_tokens,0) ELSE 0 END) okOut,
             MAX(started_at) lastAt
      FROM task_traces
      WHERE started_at >= @since AND channel = 'cron' AND chat_id IS NOT NULL
      GROUP BY 1, 2 ORDER BY ms DESC LIMIT @limit
    `).all(p) as Row[]).map((r) => toJob(r, "cron", String(r.key).replace(/^cron:/, ""))),
    ...(db.prepare(`
      SELECT workflow_id key, agent_id agent, COUNT(*) runs,
             SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) errors,
             SUM(COALESCE(duration_ms,0)) ms,
             SUM(CASE WHEN status = 'ok' THEN COALESCE(output_tokens,0) ELSE 0 END) okOut,
             MAX(started_at) lastAt
      FROM task_traces
      WHERE started_at >= @since AND channel = 'workflow' AND workflow_id IS NOT NULL
      GROUP BY 1, 2 ORDER BY ms DESC LIMIT @limit
    `).all(p) as Row[]).map((r) => toJob(r, "workflow", String(r.key))),
  ].sort((a, b) => b.hours - a.hours)

  // Ordered by how long the thread lived, because that is what the panel
  // reading this is called: a 400-run workflow node that existed for one
  // second is not a lifetime. Runs break the tie.
  const threadRows = db.prepare(`
    SELECT agent_id agent, COALESCE(channel,'unknown') channel, COALESCE(chat_id,'-') chatId,
           COUNT(*) runs,
           SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) errors,
           MIN(started_at) firstAt, MAX(started_at) lastAt,
           SUM(COALESCE(duration_ms,0)) ms
    FROM task_traces WHERE started_at >= @since
    GROUP BY 1, 2, 3
    ORDER BY (MAX(started_at) - MIN(started_at)) DESC, runs DESC
    LIMIT @limit
  `).all(p) as Row[]

  // One pass over the window's rotations, joined in memory on the same
  // (agent, channel, chat) triple. Bounded by LIMIT rather than by an
  // N+1 per thread.
  const rotRows = db.prepare(`
    SELECT agent_id agent, channel, chat_id chatId, reason, rotated_at rotatedAt
    FROM rotations WHERE rotated_at >= @sinceIso
    ORDER BY rotated_at LIMIT 20000
  `).all({ sinceIso: new Date(since).toISOString() }) as Row[]
  const rotIndex = new Map<string, Array<{ at: number; reason: string }>>()
  for (const r of rotRows) {
    const k = `${r.agent}|${r.channel}|${r.chatId}`
    const list = rotIndex.get(k) || []
    list.push({ at: Date.parse(r.rotatedAt), reason: r.reason })
    rotIndex.set(k, list)
  }

  const threads: ThreadRow[] = threadRows.map((r) => {
    const key = `${r.agent}|${r.channel}|${r.chatId}`
    const rots = rotIndex.get(key) || []
    const byReason = new Map<string, number>()
    for (const x of rots) byReason.set(x.reason, (byReason.get(x.reason) || 0) + 1)
    return {
      key, agent: r.agent, channel: r.channel, chatId: r.chatId,
      runs: r.runs, errors: r.errors, firstAt: r.firstAt, lastAt: r.lastAt,
      hours: round(r.ms / 3_600_000, 2),
      rotations: rots.length,
      rotationReasons: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      cuts: sample(rots, CUTS_PER_THREAD),
      cutsShown: Math.min(rots.length, CUTS_PER_THREAD),
    }
  })

  const rotTotals = db.prepare(`
    SELECT reason, COUNT(*) c,
           SUM(COALESCE(last_turn_input_tokens,0)) tokSum,
           SUM(CASE WHEN last_turn_input_tokens IS NOT NULL THEN 1 ELSE 0 END) tokN,
           MAX(COALESCE(last_turn_input_tokens,0)) maxTok
    FROM rotations WHERE rotated_at >= @sinceIso GROUP BY 1 ORDER BY c DESC
  `).all({ sinceIso: new Date(since).toISOString() }) as Row[]

  const retention = db.prepare(`
    SELECT COUNT(*) traces,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM task_trace_steps s WHERE s.task_id = t.task_id) THEN 1 ELSE 0 END) withSteps
    FROM task_traces t WHERE started_at >= @since
  `).get(p) as Row

  return {
    generatedAt: now,
    windowDays: days,
    since,
    totals: {
      runs: totals.runs || 0, errors: totals.errors || 0,
      hours: round((totals.ms || 0) / 3_600_000, 2),
      agents: totals.agents || 0, threads: totals.threads || 0,
    },
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    origins,
    causes,
    jobs,
    threads,
    rotations: {
      total: rotTotals.reduce((v, r) => v + r.c, 0),
      byReason: rotTotals.map((r) => ({ reason: r.reason, count: r.c })),
      tokenSum: rotTotals.reduce((v, r) => v + (r.tokSum || 0), 0),
      tokenSamples: rotTotals.reduce((v, r) => v + (r.tokN || 0), 0),
      maxTokens: Math.max(0, ...rotTotals.map((r) => r.maxTok || 0)),
    },
    retention: { traces: retention.traces || 0, tracesWithSteps: retention.withSteps || 0 },
  }
}

function toJob(r: Row, kind: "cron" | "workflow", label: string): JobRow {
  const okRuns = r.runs - r.errors
  const avgSec = r.runs ? r.ms / r.runs / 1000 : 0
  const avgOutput = okRuns ? r.okOut / okRuns : 0
  return {
    key: `${kind}:${label}`, label, kind, agent: r.agent,
    runs: r.runs, errors: r.errors, okRuns,
    hours: round(r.ms / 3_600_000, 2),
    avgMinutes: round(avgSec / 60, 2),
    avgOutput: round(avgOutput, 1),
    lastAt: r.lastAt ?? null,
    verdict: verdictFor(r.runs, r.errors, avgSec, avgOutput),
  }
}

/** Every local calendar day touched by [from, to], inclusive of today.
 *  A fixed UTC offset makes "local day" a pure shift, so the whole range
 *  is one integer loop and every node in the mesh agrees on the buckets. */
export function dayKeysBetween(from: number, to: number, tzOffsetMs: number): string[] {
  const first = Math.floor((from + tzOffsetMs) / 86_400_000)
  const last = Math.floor((to + tzOffsetMs) / 86_400_000)
  const out: string[] = []
  for (let d = first; d <= last && out.length <= 400; d++) {
    out.push(new Date(d * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}

/** Local-day boundaries for one YYYY-MM-DD key under the same fixed offset. */
export function dayBounds(day: string, tzOffsetMs: number): { start: number; end: number } {
  const start = Date.parse(day + "T00:00:00Z") - tzOffsetMs
  return { start, end: start + 86_400_000 }
}

/** Evenly sample `max` items out of `list`, preserving order and endpoints.
 *  Used so a thread with 800 session cuts still plots real timestamps
 *  rather than a synthetic even spread. */
const CUTS_PER_THREAD = 48
function sample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list.slice()
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))])
  return out
}

function round(n: number, places: number): number {
  const f = 10 ** places
  return Math.round((n || 0) * f) / f
}
