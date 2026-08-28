import type Database from "better-sqlite3"
import { classifyCause, dayBounds, type CauseId } from "./mesh-analytics"

// --- Drill-down reads behind the mesh page's thread → run → step path ---
//
// Deliberately content-free. A run row carries timing, status and token
// counts; a step row carries the tool NAME and outcome, never its input or
// output. That is enough to answer "what did this run actually touch?" —
// the question that separates real work from a zombie — without shipping
// prompt or file contents across the mesh.

export interface RunRow {
  taskId: string
  startedAt: number
  durationMs: number | null
  status: string
  outputTokens: number | null
  inputTokens: number | null
  model: string | null
  cause: CauseId | null
  steps: number
}

export function listThreadRuns(
  db: Database.Database,
  args: { agent: string; channel: string; chatId: string; limit?: number },
): RunRow[] {
  const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 120)))
  const rows = db.prepare(`
    SELECT t.task_id taskId, t.started_at startedAt, t.duration_ms durationMs,
           t.status, t.output_tokens outputTokens, t.input_tokens inputTokens,
           t.model, t.error,
           (SELECT COUNT(*) FROM task_trace_steps s WHERE s.task_id = t.task_id) steps
    FROM task_traces t
    WHERE t.agent_id = @agent
      AND COALESCE(t.channel,'unknown') = @channel
      AND COALESCE(t.chat_id,'-') = @chatId
    ORDER BY t.started_at DESC LIMIT @limit
  `).all({ ...args, limit }) as Array<Record<string, any>>
  return rows.map((r) => ({
    taskId: r.taskId, startedAt: r.startedAt, durationMs: r.durationMs,
    status: r.status, outputTokens: r.outputTokens, inputTokens: r.inputTokens,
    model: r.model, steps: r.steps,
    cause: r.status === "ok" ? null : classifyCause(r.error),
  }))
}

/** Same shape for a recurring job, keyed the way buildMeshAnalytics keys it. */
export function listJobRuns(
  db: Database.Database,
  args: { kind: "cron" | "workflow"; key: string; limit?: number },
): RunRow[] {
  const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 120)))
  const where = args.kind === "cron"
    ? "t.channel = 'cron' AND t.chat_id = @key"
    : "t.channel = 'workflow' AND t.workflow_id = @key"
  const key = args.kind === "cron" ? `cron:${args.key}` : args.key
  const rows = db.prepare(`
    SELECT t.task_id taskId, t.started_at startedAt, t.duration_ms durationMs,
           t.status, t.output_tokens outputTokens, t.input_tokens inputTokens,
           t.model, t.error,
           (SELECT COUNT(*) FROM task_trace_steps s WHERE s.task_id = t.task_id) steps
    FROM task_traces t WHERE ${where}
    ORDER BY t.started_at DESC LIMIT @limit
  `).all({ key, limit }) as Array<Record<string, any>>
  return rows.map((r) => ({
    taskId: r.taskId, startedAt: r.startedAt, durationMs: r.durationMs,
    status: r.status, outputTokens: r.outputTokens, inputTokens: r.inputTokens,
    model: r.model, steps: r.steps,
    cause: r.status === "ok" ? null : classifyCause(r.error),
  }))
}

export interface RunShape {
  taskId: string
  found: boolean
  agent?: string
  channel?: string
  chatId?: string
  startedAt?: number
  durationMs?: number | null
  status?: string
  model?: string | null
  cause?: CauseId | null
  outputTokens?: number | null
  /** Tool name → { used, failed }. The "what it touched" evidence. */
  tools: Array<{ tool: string; used: number; failed: number }>
  /** Ordered step skeleton: kind, tool, outcome, elapsed. No payloads. */
  steps: Array<{ seq: number; name: string; action: string | null; status: string | null; ms: number | null }>
  /** True when the trace exists but its steps were pruned by retention. */
  stepsPruned: boolean
  writes: number
  reads: number
  sends: number
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"])
const SEND_TOOLS = new Set(["SendMessage", "channel_send", "Artifact", "PushNotification"])

export function getRunShape(db: Database.Database, taskId: string, stepCap = 300): RunShape {
  const t = db.prepare(`
    SELECT agent_id agent, channel, chat_id chatId, started_at startedAt,
           duration_ms durationMs, status, model, error, output_tokens outputTokens
    FROM task_traces WHERE task_id = ?
  `).get(taskId) as Record<string, any> | undefined
  if (!t) return { taskId, found: false, tools: [], steps: [], stepsPruned: false, writes: 0, reads: 0, sends: 0 }

  const rows = db.prepare(`
    SELECT seq, name, action, status, ms FROM task_trace_steps
    WHERE task_id = ? ORDER BY seq LIMIT ?
  `).all(taskId, Math.max(1, Math.min(2000, stepCap))) as Array<Record<string, any>>

  const tally = new Map<string, { used: number; failed: number }>()
  let writes = 0, reads = 0, sends = 0
  for (const r of rows) {
    if (r.name !== "tool_use") continue
    const tool = r.action || "unknown"
    const e = tally.get(tool) || { used: 0, failed: 0 }
    e.used++
    if (r.status === "error") e.failed++
    tally.set(tool, e)
    if (WRITE_TOOLS.has(tool)) writes++
    else if (SEND_TOOLS.has(tool)) sends++
    else if (READ_TOOLS.has(tool)) reads++
  }
  // tool_result rows carry the real outcome; fold their failures back onto
  // the preceding tool_use so a green tool with a red result reads as red.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].name !== "tool_result" || rows[i].status !== "error") continue
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].name !== "tool_use") continue
      const e = tally.get(rows[j].action || "unknown")
      if (e) e.failed++
      break
    }
  }

  return {
    taskId, found: true,
    agent: t.agent, channel: t.channel, chatId: t.chatId,
    startedAt: t.startedAt, durationMs: t.durationMs, status: t.status,
    model: t.model, outputTokens: t.outputTokens,
    cause: t.status === "ok" ? null : classifyCause(t.error),
    tools: [...tally.entries()].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.used - a.used),
    steps: rows.map((r) => ({ seq: r.seq, name: r.name, action: r.action, status: r.status, ms: r.ms })),
    stepsPruned: rows.length === 0,
    writes, reads, sends,
  }
}

// --- Day drill: "what actually ran on this column?" --------------------
//
// Reached by clicking one activity column. Same content rules as the rest
// of this module: counts, timings and identifiers, never a payload.

export interface DayConversation {
  key: string
  agent: string
  channel: string
  chatId: string
  turns: number
  errors: number
  ms: number
  inputTokens: number
  outputTokens: number
  firstAt: number
  lastAt: number
}

export interface DayActivity {
  day: string
  totals: { runs: number; errors: number; ms: number; inputTokens: number; outputTokens: number }
  origins: Array<{ channel: string; runs: number; errors: number; ms: number }>
  causes: Array<{ cause: CauseId; count: number }>
  conversations: DayConversation[]
}

export function getDayActivity(
  db: Database.Database,
  args: { day: string; tzOffsetMinutes?: number; limit?: number },
): DayActivity {
  const { start, end } = dayBounds(args.day, (args.tzOffsetMinutes ?? 0) * 60_000)
  const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 40)))
  const p = { start, end, limit }
  const ERR = "SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END)"
  const WINDOW = "started_at >= @start AND started_at < @end"

  const totals = db.prepare(`
    SELECT COUNT(*) runs, ${ERR} errors, SUM(COALESCE(duration_ms,0)) ms,
           SUM(COALESCE(input_tokens,0)) inTok, SUM(COALESCE(output_tokens,0)) outTok
    FROM task_traces WHERE ${WINDOW}
  `).get(p) as Record<string, any>

  const origins = (db.prepare(`
    SELECT COALESCE(channel,'unknown') channel, COUNT(*) runs, ${ERR} errors,
           SUM(COALESCE(duration_ms,0)) ms
    FROM task_traces WHERE ${WINDOW} GROUP BY 1 ORDER BY runs DESC LIMIT 20
  `).all(p) as Record<string, any>[])

  const errRows = db.prepare(`
    SELECT COALESCE(error,'') error, COUNT(*) c FROM task_traces
    WHERE ${WINDOW} AND status IN ('error','timeout') GROUP BY 1 ORDER BY c DESC LIMIT 200
  `).all(p) as Record<string, any>[]
  const causeMap = new Map<CauseId, number>()
  for (const r of errRows) {
    const id = classifyCause(r.error)
    causeMap.set(id, (causeMap.get(id) || 0) + r.c)
  }

  const conversations = (db.prepare(`
    SELECT agent_id agent, COALESCE(channel,'unknown') channel, COALESCE(chat_id,'-') chatId,
           COUNT(*) turns, ${ERR} errors, SUM(COALESCE(duration_ms,0)) ms,
           SUM(COALESCE(input_tokens,0)) inTok, SUM(COALESCE(output_tokens,0)) outTok,
           MIN(started_at) firstAt, MAX(started_at) lastAt
    FROM task_traces WHERE ${WINDOW}
    GROUP BY 1, 2, 3 ORDER BY ms DESC, turns DESC LIMIT @limit
  `).all(p) as Record<string, any>[]).map((r) => ({
    key: `${r.agent}|${r.channel}|${r.chatId}`,
    agent: r.agent, channel: r.channel, chatId: r.chatId,
    turns: r.turns, errors: r.errors, ms: r.ms,
    inputTokens: r.inTok, outputTokens: r.outTok,
    firstAt: r.firstAt, lastAt: r.lastAt,
  }))

  return {
    day: args.day,
    totals: {
      runs: totals.runs || 0, errors: totals.errors || 0, ms: totals.ms || 0,
      inputTokens: totals.inTok || 0, outputTokens: totals.outTok || 0,
    },
    origins: origins.map((o) => ({ channel: o.channel, runs: o.runs, errors: o.errors, ms: o.ms })),
    causes: [...causeMap.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count),
    conversations,
  }
}

// --- Conversation summary ---------------------------------------------
//
// The whole life of one (agent, channel, chat) thread, over ALL history
// rather than the selected window — "how many turns has this conversation
// taken and what has it cost" is not a question about the last 30 days.
// Token totals come from the trace rows, so cache reads are separated from
// fresh input: a long thread is mostly cache, and collapsing them would
// make every conversation look equally expensive.

export interface ConversationSummary {
  found: boolean
  agent: string
  channel: string
  chatId: string
  turns: number
  ok: number
  errors: number
  firstAt: number
  lastAt: number
  /** Calendar days between first and last turn, inclusive. */
  spanDays: number
  /** Days on which at least one turn ran — a thread can be 60 days old
   *  and only have been used on 4 of them. */
  activeDays: number
  totalMs: number
  avgMs: number
  maxMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  models: Array<{ model: string; turns: number }>
  cuts: { total: number; byReason: Array<{ reason: string; count: number }> }
  causes: Array<{ cause: CauseId; count: number }>
  /** Tool usage aggregated over the runs whose steps survived retention. */
  tools: Array<{ tool: string; used: number }>
  toolRunsCounted: number
  busiestDay: { day: string; turns: number } | null
}

export function getConversationSummary(
  db: Database.Database,
  args: { agent: string; channel: string; chatId: string; tzOffsetMinutes?: number },
): ConversationSummary {
  const tzOffsetMs = (args.tzOffsetMinutes ?? 0) * 60_000
  const p = { agent: args.agent, channel: args.channel, chatId: args.chatId, tzOffsetMs }
  // Two spellings of the same predicate: unqualified for single-table
  // reads, alias-qualified for the joins below. Written out rather than
  // derived, because a regex that rewrites SQL is a bug waiting to happen.
  const WHERE = `agent_id = @agent AND COALESCE(channel,'unknown') = @channel AND COALESCE(chat_id,'-') = @chatId`
  const WHERE_T = `t.agent_id = @agent AND COALESCE(t.channel,'unknown') = @channel AND COALESCE(t.chat_id,'-') = @chatId`

  const t = db.prepare(`
    SELECT COUNT(*) turns,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) ok,
           SUM(CASE WHEN status IN ('error','timeout') THEN 1 ELSE 0 END) errors,
           MIN(started_at) firstAt, MAX(started_at) lastAt,
           SUM(COALESCE(duration_ms,0)) totalMs, MAX(COALESCE(duration_ms,0)) maxMs,
           SUM(COALESCE(input_tokens,0)) inTok, SUM(COALESCE(output_tokens,0)) outTok,
           SUM(COALESCE(cache_read_tokens,0)) cacheRead, SUM(COALESCE(cache_create_tokens,0)) cacheCreate,
           COUNT(DISTINCT date((started_at + @tzOffsetMs)/1000,'unixepoch')) activeDays
    FROM task_traces WHERE ${WHERE}
  `).get(p) as Record<string, any>

  if (!t || !t.turns) {
    return {
      found: false, agent: args.agent, channel: args.channel, chatId: args.chatId,
      turns: 0, ok: 0, errors: 0, firstAt: 0, lastAt: 0, spanDays: 0, activeDays: 0,
      totalMs: 0, avgMs: 0, maxMs: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0, models: [],
      cuts: { total: 0, byReason: [] }, causes: [], tools: [], toolRunsCounted: 0, busiestDay: null,
    }
  }

  const models = (db.prepare(`
    SELECT COALESCE(model,'default') model, COUNT(*) turns FROM task_traces
    WHERE ${WHERE} GROUP BY 1 ORDER BY turns DESC LIMIT 10
  `).all(p) as Record<string, any>[]).map((r) => ({ model: r.model, turns: r.turns }))

  const cutRows = db.prepare(`
    SELECT reason, COUNT(*) c FROM rotations
    WHERE agent_id = @agent AND channel = @channel AND chat_id = @chatId
    GROUP BY 1 ORDER BY c DESC
  `).all(p) as Record<string, any>[]

  const errRows = db.prepare(`
    SELECT COALESCE(error,'') error, COUNT(*) c FROM task_traces
    WHERE ${WHERE} AND status IN ('error','timeout') GROUP BY 1 ORDER BY c DESC LIMIT 100
  `).all(p) as Record<string, any>[]
  const causeMap = new Map<CauseId, number>()
  for (const r of errRows) causeMap.set(classifyCause(r.error), (causeMap.get(classifyCause(r.error)) || 0) + r.c)

  const toolRows = db.prepare(`
    SELECT s.action tool, COUNT(*) used FROM task_trace_steps s
    JOIN task_traces t ON t.task_id = s.task_id
    WHERE ${WHERE_T} AND s.name = 'tool_use' AND s.action IS NOT NULL
    GROUP BY 1 ORDER BY used DESC LIMIT 20
  `).all(p) as Record<string, any>[]

  const toolRuns = db.prepare(`
    SELECT COUNT(*) n FROM task_traces t
    WHERE ${WHERE_T}
      AND EXISTS (SELECT 1 FROM task_trace_steps s WHERE s.task_id = t.task_id)
  `).get(p) as Record<string, any>

  const busiest = db.prepare(`
    SELECT date((started_at + @tzOffsetMs)/1000,'unixepoch') day, COUNT(*) turns
    FROM task_traces WHERE ${WHERE} GROUP BY 1 ORDER BY turns DESC, day DESC LIMIT 1
  `).get(p) as Record<string, any> | undefined

  return {
    found: true, agent: args.agent, channel: args.channel, chatId: args.chatId,
    turns: t.turns, ok: t.ok, errors: t.errors,
    firstAt: t.firstAt, lastAt: t.lastAt,
    spanDays: Math.max(1, Math.round((t.lastAt - t.firstAt) / 86_400_000) + 1),
    activeDays: t.activeDays || 0,
    totalMs: t.totalMs, avgMs: t.turns ? Math.round(t.totalMs / t.turns) : 0, maxMs: t.maxMs,
    inputTokens: t.inTok, outputTokens: t.outTok,
    cacheReadTokens: t.cacheRead, cacheCreateTokens: t.cacheCreate,
    models,
    cuts: { total: cutRows.reduce((v, r) => v + r.c, 0), byReason: cutRows.map((r) => ({ reason: r.reason, count: r.c })) },
    causes: [...causeMap.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count),
    tools: toolRows.map((r) => ({ tool: r.tool, used: r.used })),
    toolRunsCounted: toolRuns?.n || 0,
    busiestDay: busiest ? { day: busiest.day, turns: busiest.turns } : null,
  }
}
