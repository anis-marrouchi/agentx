import type Database from "better-sqlite3"
import { classifyCause, type CauseId } from "./mesh-analytics"

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
