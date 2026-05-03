import type { IncomingMessage, ServerResponse } from "http"
import { resolve } from "path"
import { existsSync } from "fs"
import Database from "better-sqlite3"
import { renderObservabilityPage } from "./ui/pages/observability"
import type { TopbarPeer } from "./topbar"

// Anthropic public per-million-token rates. Same numbers
// src/observability/tracker.ts uses; duplicated here so this module stays
// independent of the in-process token tracker.
const RATE_PER_M: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  opus:    { input: 15,  output: 75,  cacheRead: 1.5,  cacheCreate: 18.75 },
  sonnet:  { input: 3,   output: 15,  cacheRead: 0.3,  cacheCreate: 3.75 },
  haiku:   { input: 0.25, output: 1.25, cacheRead: 0.025, cacheCreate: 0.3125 },
}
function modelFamily(model: string): "opus" | "sonnet" | "haiku" {
  const m = (model || "").toLowerCase()
  if (m.includes("opus")) return "opus"
  if (m.includes("haiku")) return "haiku"
  return "sonnet"
}
function rowCost(row: {
  model: string;
  input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_create_tokens: number;
  tier2_input_tokens?: number; tier2_output_tokens?: number;
  tier2_cache_read_tokens?: number; tier2_cache_create_tokens?: number;
}): number {
  const r = RATE_PER_M[modelFamily(row.model)]
  // Tier-2 columns ALSO live in input_tokens etc. (they're a subset, not a
  // disjoint count). The tier-2 multiplier (1.5×) is the additional charge.
  const base =
    (row.input_tokens / 1_000_000) * r.input +
    (row.output_tokens / 1_000_000) * r.output +
    (row.cache_read_tokens / 1_000_000) * r.cacheRead +
    (row.cache_create_tokens / 1_000_000) * r.cacheCreate
  const tier2Surcharge =
    ((row.tier2_input_tokens ?? 0) / 1_000_000) * r.input * 0.5 +
    ((row.tier2_output_tokens ?? 0) / 1_000_000) * r.output * 0.5 +
    ((row.tier2_cache_read_tokens ?? 0) / 1_000_000) * r.cacheRead * 0.5 +
    ((row.tier2_cache_create_tokens ?? 0) / 1_000_000) * r.cacheCreate * 0.5
  return base + tier2Surcharge
}

// --- /admin/observability — surface the SQLite tables that have no UI ---
//
// route_traces, rotations, and task_history(error rows) were CLI-only before
// this panel landed. The page is a read-only window over the same tables
// `agentx db routes / db rotations / db tasks --status error` already
// expose; the JSON API just makes them visible in the dashboard.
//
// Each request opens a short-lived read-only handle. The dashboard process
// doesn't keep one — the daemon owns the writes via WAL — so we don't fight
// for the SHM lock; concurrent reads are the WAL's whole point.

interface OpenedDb {
  db: Database.Database
  close: () => void
}

function openReadOnly(): OpenedDb | null {
  const path = resolve(process.cwd(), ".agentx/db.sqlite")
  if (!existsSync(path)) return null
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    return { db, close: () => db.close() }
  } catch {
    return null
  }
}

export function handleObservabilityGet(_req: IncomingMessage, res: ServerResponse, peers: TopbarPeer[] = []): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderObservabilityPage({ peers }))
}

interface QueryParams {
  limit: number
  agent?: string
}

function parseQuery(req: IncomingMessage): QueryParams {
  const url = new URL(req.url || "/", "http://_")
  const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50
  const agent = url.searchParams.get("agent") || undefined
  return { limit, agent: agent && agent.length > 0 ? agent : undefined }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

export async function handleObservabilityApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith("/api/admin/observability/")) return false
  const slug = path.replace(/^\/api\/admin\/observability\//, "").split("?")[0]

  const opened = openReadOnly()
  if (!opened) {
    sendJson(res, 503, { error: "operational SQLite not available", rows: [] })
    return true
  }

  try {
    const { limit, agent } = parseQuery(req)
    if (slug === "routing") {
      const where: string[] = []
      const params: Record<string, unknown> = { limit }
      if (agent) { where.push("agent_id = @agent"); params.agent = agent }
      const sql = `
        SELECT at, channel, chat_id, account_id, kind, deciding_stage, agent_id, reason
        FROM route_traces
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY at DESC LIMIT @limit
      `
      const rows = opened.db.prepare(sql).all(params)
      sendJson(res, 200, { rows })
      return true
    }
    if (slug === "rotations") {
      const where: string[] = []
      const params: Record<string, unknown> = { limit }
      if (agent) { where.push("agent_id = @agent"); params.agent = agent }
      const sql = `
        SELECT rotated_at, agent_id, channel, reason, last_turn_input_tokens
        FROM rotations
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY rotated_at DESC LIMIT @limit
      `
      const rows = opened.db.prepare(sql).all(params)
      sendJson(res, 200, { rows })
      return true
    }
    if (slug === "errors") {
      const where: string[] = ["status = 'error'"]
      const params: Record<string, unknown> = { limit }
      if (agent) { where.push("agent_id = @agent"); params.agent = agent }
      const sql = `
        SELECT started_at, agent_id, channel, message_preview, error
        FROM task_history
        WHERE ${where.join(" AND ")}
        ORDER BY started_at DESC LIMIT @limit
      `
      const rows = opened.db.prepare(sql).all(params) as Array<{ error?: string | null }>
      // Plain-English label for non-technical operators. Pattern-match the
      // common failure modes; fall through to the raw string for unknowns.
      const labelled = rows.map((r) => ({ ...r, plain: plainErrorLabel(r.error) }))
      sendJson(res, 200, { rows: labelled })
      return true
    }
    // The page calls `/overview`; legacy callers hit `/summary`. Same data.
    if (slug === "summary" || slug === "overview") {
      sendJson(res, 200, buildSummary(opened.db))
      return true
    }
    if (slug === "activity") {
      sendJson(res, 200, buildActivity(opened.db, { agent }))
      return true
    }
    if (slug === "cost") {
      sendJson(res, 200, buildCost(opened.db))
      return true
    }
    sendJson(res, 404, { error: "unknown observability slice", rows: [] })
    return true
  } catch (e: any) {
    sendJson(res, 500, { error: e?.message ?? String(e), rows: [] })
    return true
  } finally {
    opened.close()
  }
}

// --- Plain-English error labels --------------------------------------------

function plainErrorLabel(error: string | null | undefined): string {
  const e = String(error || "")
  if (!e) return "unknown failure"
  if (/timed out|SIGTERM|exit 143|maxExecutionMinutes/i.test(e)) return "Agent ran past its time limit"
  if (/ECONNREFUSED|fetch failed|getaddrinfo|ENOTFOUND/i.test(e)) return "Couldn't reach a service over the network"
  if (/401|403|Unauthorized|Forbidden|invalid token|missing scope/i.test(e)) return "Authentication or permission denied"
  if (/rate limit|429|too many requests/i.test(e)) return "Hit a rate limit (too many calls)"
  if (/quota|insufficient_quota/i.test(e)) return "Provider account out of quota or credits"
  if (/tier-?2|tier two|200K|200,000/i.test(e)) return "Hit Anthropic tier-2 billing threshold"
  if (/JSON|parse|unexpected token/i.test(e)) return "Got a response in the wrong shape"
  if (/permission denied|EACCES|EPERM/i.test(e)) return "File permission denied"
  if (/ENOENT|no such file/i.test(e)) return "Expected file is missing"
  if (/abort|cancel/i.test(e)) return "Task was cancelled before it finished"
  return e.split("\n")[0].slice(0, 80) + (e.length > 80 ? "…" : "")
}

// --- Summary (Overview tab) -------------------------------------------------

function buildSummary(db: Database.Database) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const yesterdayStart = new Date(now.getTime() - 86400_000)
  const yStart = new Date(yesterdayStart.getFullYear(), yesterdayStart.getMonth(), yesterdayStart.getDate()).toISOString()
  const last24 = new Date(now.getTime() - 86400_000).toISOString()

  const tasksToday = (db.prepare(`SELECT COUNT(*) AS n FROM task_history WHERE started_at >= ?`).get(todayStart) as { n: number }).n
  const tasksYesterday = (db.prepare(`SELECT COUNT(*) AS n FROM task_history WHERE started_at >= ? AND started_at < ?`).get(yStart, todayStart) as { n: number }).n
  const errorsToday = (db.prepare(`SELECT COUNT(*) AS n FROM task_history WHERE status='error' AND started_at >= ?`).get(todayStart) as { n: number }).n
  const avgDuration = (db.prepare(`SELECT AVG(duration_ms) AS d FROM task_history WHERE status='ok' AND started_at >= ?`).get(todayStart) as { d: number | null }).d ?? 0

  // p50/p95 via SQLite — manual from a small sample, cheap.
  const dRows = db.prepare(`SELECT duration_ms FROM task_history WHERE status='ok' AND started_at >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms ASC`).all(todayStart) as Array<{ duration_ms: number }>
  const p = (q: number) => dRows.length ? dRows[Math.min(dRows.length - 1, Math.floor(dRows.length * q))].duration_ms : 0
  const p50 = p(0.5)
  const p95 = p(0.95)

  // Spend today: sum cost across all usage_daily rows for today.
  const usageRows = db.prepare(`SELECT * FROM usage_daily WHERE day = date('now')`).all() as any[]
  const spendToday = usageRows.reduce((s, r) => s + rowCost(r), 0)
  const spendYesterday = (db.prepare(`SELECT * FROM usage_daily WHERE day = date('now', '-1 day')`).all() as any[])
    .reduce((s, r) => s + rowCost(r), 0)

  // Per-agent today (top 10 by tasks).
  const perAgent = db.prepare(`
    SELECT agent_id,
           COUNT(*) AS tasks,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
           ROUND(AVG(duration_ms)) AS avg_duration_ms,
           MAX(started_at) AS last_active
    FROM task_history
    WHERE started_at >= ?
    GROUP BY agent_id
    ORDER BY tasks DESC LIMIT 10
  `).all(todayStart)

  // Per-channel today.
  const perChannel = db.prepare(`
    SELECT COALESCE(channel, 'unknown') AS channel,
           COUNT(*) AS tasks,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
    FROM task_history
    WHERE started_at >= ?
    GROUP BY channel
    ORDER BY tasks DESC
  `).all(todayStart)

  // Idle agents — listed in usage_daily over the last 7 days but no activity in the last 24h.
  const knownAgents = (db.prepare(`SELECT DISTINCT agent_id FROM usage_daily WHERE day >= date('now', '-7 day')`).all() as Array<{ agent_id: string }>).map((r) => r.agent_id)
  const recentlyActive = new Set((db.prepare(`SELECT DISTINCT agent_id FROM task_history WHERE started_at >= ?`).all(last24) as Array<{ agent_id: string }>).map((r) => r.agent_id))
  const idleAgents = knownAgents.filter((a) => !recentlyActive.has(a))

  // Recent errors (last 24h, top 5).
  const recentErrors = db.prepare(`
    SELECT started_at, agent_id, channel, message_preview, error
    FROM task_history
    WHERE status='error' AND started_at >= ?
    ORDER BY started_at DESC LIMIT 5
  `).all(last24) as Array<{ error?: string | null }>
  const recentErrorsLabelled = recentErrors.map((r) => ({ ...r, plain: plainErrorLabel(r.error) }))

  return {
    kpis: {
      tasksToday,
      tasksDelta: tasksToday - tasksYesterday,
      errorsToday,
      errorRate: tasksToday > 0 ? errorsToday / tasksToday : 0,
      avgDurationMs: Math.round(avgDuration),
      p50DurationMs: p50,
      p95DurationMs: p95,
      spendToday,
      spendDelta: spendToday - spendYesterday,
      idleAgentCount: idleAgents.length,
    },
    perAgent,
    perChannel,
    idleAgents,
    recentErrors: recentErrorsLabelled,
  }
}

// --- Activity (Activity tab) ------------------------------------------------

function buildActivity(db: Database.Database, opts: { agent?: string }) {
  const last24 = new Date(Date.now() - 86400_000).toISOString()
  const last7d = new Date(Date.now() - 7 * 86400_000).toISOString()

  const where = opts.agent ? "AND agent_id = @agent" : ""
  const params = opts.agent ? { agent: opts.agent } : {}

  // Hourly buckets for last 24h.
  const hourly = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00', started_at) AS hour,
           COUNT(*) AS tasks,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
    FROM task_history
    WHERE started_at >= @since ${where}
    GROUP BY hour
    ORDER BY hour
  `).all({ since: last24, ...params })

  // Daily counts for last 7 days.
  const daily = db.prepare(`
    SELECT date(started_at) AS day,
           COUNT(*) AS tasks,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
    FROM task_history
    WHERE started_at >= @since ${where}
    GROUP BY day
    ORDER BY day
  `).all({ since: last7d, ...params })

  // Per-agent table (7d).
  const perAgent = db.prepare(`
    SELECT agent_id,
           COUNT(*) AS tasks_7d,
           SUM(CASE WHEN started_at >= @last24 THEN 1 ELSE 0 END) AS tasks_24h,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors_7d,
           ROUND(AVG(duration_ms)) AS avg_duration_ms,
           MAX(started_at) AS last_active
    FROM task_history
    WHERE started_at >= @since
    GROUP BY agent_id
    ORDER BY tasks_24h DESC, tasks_7d DESC
  `).all({ since: last7d, last24 })

  return { hourly, daily, perAgent }
}

// --- Cost (Cost tab) --------------------------------------------------------

function buildCost(db: Database.Database) {
  const usageAll = db.prepare(`
    SELECT day, agent_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
           tier2_input_tokens, tier2_output_tokens, tier2_cache_read_tokens, tier2_cache_create_tokens,
           tasks
    FROM usage_daily
    WHERE day >= date('now', '-30 day')
    ORDER BY day
  `).all() as any[]

  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const last7Cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)

  let spendToday = 0, spendYesterday = 0, spend7d = 0, spend30d = 0
  let tier2Today = 0, tier2_7d = 0
  const byDay: Record<string, number> = {}
  const byAgent: Record<string, { spend: number; tasks: number; tier2: number }> = {}

  for (const r of usageAll) {
    const c = rowCost(r)
    spend30d += c
    if (r.day >= last7Cutoff) spend7d += c
    if (r.day === today) spendToday += c
    if (r.day === yesterday) spendYesterday += c
    byDay[r.day] = (byDay[r.day] || 0) + c

    const family = modelFamily(r.model)
    const rate = RATE_PER_M[family]
    const tier2Surcharge =
      ((r.tier2_input_tokens || 0) / 1e6) * rate.input * 0.5 +
      ((r.tier2_output_tokens || 0) / 1e6) * rate.output * 0.5 +
      ((r.tier2_cache_read_tokens || 0) / 1e6) * rate.cacheRead * 0.5 +
      ((r.tier2_cache_create_tokens || 0) / 1e6) * rate.cacheCreate * 0.5
    if (r.day === today) tier2Today += tier2Surcharge
    if (r.day >= last7Cutoff) tier2_7d += tier2Surcharge

    const a = byAgent[r.agent_id] || (byAgent[r.agent_id] = { spend: 0, tasks: 0, tier2: 0 })
    a.spend += c
    a.tasks += r.tasks || 0
    a.tier2 += tier2Surcharge
  }

  const perAgent = Object.entries(byAgent)
    .map(([agent_id, v]) => ({ agent_id, spend: v.spend, tasks: v.tasks, tier2: v.tier2 }))
    .sort((a, b) => b.spend - a.spend)

  const trend = Object.entries(byDay)
    .map(([day, spend]) => ({ day, spend }))
    .sort((a, b) => (a.day < b.day ? -1 : 1))

  return {
    kpis: {
      spendToday,
      spendYesterday,
      spend7d,
      spend30d,
      tier2Today,
      tier2_7d,
      tier2PctToday: spendToday > 0 ? tier2Today / spendToday : 0,
    },
    trend,
    perAgent,
  }
}
