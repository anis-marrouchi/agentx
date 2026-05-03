import type Database from "better-sqlite3"
import { newEventId } from "@/intent/ulid"

// --- Task trace store ---
//
// Improvement plan #2 — per-task observability backed by SQLite. One
// task_traces row per executeTask invocation, an append-only stream of
// task_trace_steps inside it. The store is intentionally dumb: it stores
// what callers give it. Callers (capture sites in src/agents/runtime.ts)
// are responsible for byte-capping large step payloads so the daemon
// memory stays bounded under tool-heavy turns.
//
// Why a separate store layer (vs writing inline in runtime.ts)?
//   - Tests can exercise the trace lifecycle against a temp SQLite without
//     spinning up the agent runtime.
//   - The HTTP endpoints (GET /task/:id/trace) read through the same
//     functions producers write through, so there's a single source of
//     truth on field names + semantics.
//   - Future capture sites (sdk tier, orchestrator tier) reuse this API
//     without copying SQL.
//
// Why ULID for task_id?
//   - URL-safe in HTTP routes (GET /task/:id/trace).
//   - Time-sortable, so listTraces ORDER BY started_at and ORDER BY
//     task_id agree without an explicit timestamp column index.
//   - Already in-tree (src/intent/ulid.ts); no new dep.
//
// Cross-DB FK note:
//   intent_event_id and intent_decided_by are logical foreign keys into
//   the intent ledger at .agentx/intent/ledger.sqlite. better-sqlite3
//   doesn't enforce cross-database FKs and we don't ATTACH the ledger
//   here on purpose — the rescue plan's append-only contract on the
//   ledger is honoured by routing all writes through src/intent/ledger.ts.
//   Joins happen at the HTTP / CLI layer when needed.

export interface TraceStartInput {
  agentId: string
  channel?: string | null
  chatId?: string | null
  messagePreview?: string | null
  workflowRunId?: string | null
  workflowId?: string | null
  workflowNodeId?: string | null
  intentEventId?: string | null
  intentDecidedBy?: string | null
  resumeSessionId?: string | null
  model?: string | null
}

export interface TraceEndInput {
  status: "ok" | "error" | "timeout"
  finalSessionId?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheCreateTokens?: number | null
  error?: string | null
}

export interface TraceStepInput {
  /** Coarse step kind. Conventional values: "tool_use" | "tool_result" |
   *  "llm_message" | "session_rotation" | "error" | "preflight". Free-form
   *  strings allowed so future capture sites don't need a schema bump. */
  name: string
  /** Fine-grained name within the kind. For "tool_use", this is the tool
   *  name (e.g. "Bash", "Edit"). Optional. */
  action?: string | null
  status?: "ok" | "error" | "in-flight" | null
  /** JSON-stringified input or human-readable summary. Caller-byte-capped. */
  inputSummary?: string | null
  outputSummary?: string | null
  error?: string | null
  /** Step duration when known. Optional — many step kinds are point-in-time. */
  ms?: number | null
}

export interface TraceRecord {
  taskId: string
  agentId: string
  channel: string | null
  chatId: string | null
  workflowRunId: string | null
  workflowId: string | null
  workflowNodeId: string | null
  intentEventId: string | null
  intentDecidedBy: string | null
  resumeSessionId: string | null
  finalSessionId: string | null
  model: string | null
  status: string
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreateTokens: number | null
  error: string | null
  messagePreview: string | null
}

export interface TraceStepRecord {
  taskId: string
  seq: number
  name: string
  action: string | null
  status: string | null
  inputSummary: string | null
  outputSummary: string | null
  error: string | null
  ms: number | null
  startedAt: number
}

export interface ListTracesFilters {
  agentId?: string
  channel?: string
  chatId?: string
  workflowRunId?: string
  status?: string
  /** ms epoch */
  since?: number
  /** ms epoch */
  until?: number
  /** Default 100, capped at 1000. */
  limit?: number
}

/**
 * Insert an in-flight trace row and return its ULID. Callers thread the
 * returned id through the executor and call recordTraceEnd at finish time.
 *
 * `taskId` is optional — when supplied, the caller has already allocated
 * a ULID upstream (e.g. registry.execute generating it before the bus
 * event so the runtime can capture per-step rows under the same id).
 * When omitted, a fresh ULID is allocated here.
 */
export function recordTraceStart(
  db: Database.Database,
  input: TraceStartInput,
  taskId: string = newEventId(),
): string {
  db.prepare(`
    INSERT INTO task_traces (
      task_id, agent_id, channel, chat_id, workflow_run_id, workflow_id,
      workflow_node_id, intent_event_id, intent_decided_by, resume_session_id,
      model, status, started_at, message_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in-flight', ?, ?)
  `).run(
    taskId,
    input.agentId,
    input.channel ?? null,
    input.chatId ?? null,
    input.workflowRunId ?? null,
    input.workflowId ?? null,
    input.workflowNodeId ?? null,
    input.intentEventId ?? null,
    input.intentDecidedBy ?? null,
    input.resumeSessionId ?? null,
    input.model ?? null,
    Date.now(),
    input.messagePreview ?? null,
  )
  return taskId
}

/**
 * Finalize a trace. duration_ms is computed from finished_at - started_at
 * inside the UPDATE so the two columns can never disagree. Idempotent —
 * calling twice on the same task_id overwrites the prior end values; the
 * second call's status wins. (Soft-overwrite is intentional: timeout
 * handlers may write before a late stream-completion arrives.)
 */
export function recordTraceEnd(db: Database.Database, taskId: string, input: TraceEndInput): void {
  const finishedAt = Date.now()
  db.prepare(`
    UPDATE task_traces SET
      status = ?,
      final_session_id = ?,
      input_tokens = ?,
      output_tokens = ?,
      cache_read_tokens = ?,
      cache_create_tokens = ?,
      error = ?,
      finished_at = ?,
      duration_ms = ? - started_at
    WHERE task_id = ?
  `).run(
    input.status,
    input.finalSessionId ?? null,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    input.cacheReadTokens ?? null,
    input.cacheCreateTokens ?? null,
    input.error ?? null,
    finishedAt,
    finishedAt,
    taskId,
  )
}

/**
 * Append a step. seq is auto-allocated as MAX(seq)+1 within a transaction
 * so concurrent step writes for the same task_id can't collide. Returns
 * the assigned seq, useful for downstream correlation.
 */
export function recordTraceStep(db: Database.Database, taskId: string, input: TraceStepInput): number {
  const startedAt = Date.now()
  const allocateAndInsert = db.transaction((): number => {
    const row = db
      .prepare("SELECT MAX(seq) AS max_seq FROM task_trace_steps WHERE task_id = ?")
      .get(taskId) as { max_seq: number | null } | undefined
    const seq = ((row?.max_seq ?? -1) as number) + 1
    db.prepare(`
      INSERT INTO task_trace_steps (
        task_id, seq, name, action, status, input_summary, output_summary, error, ms, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      seq,
      input.name,
      input.action ?? null,
      input.status ?? null,
      input.inputSummary ?? null,
      input.outputSummary ?? null,
      input.error ?? null,
      input.ms ?? null,
      startedAt,
    )
    return seq
  })
  return allocateAndInsert()
}

function rowToTrace(row: Record<string, unknown>): TraceRecord {
  return {
    taskId: row.task_id as string,
    agentId: row.agent_id as string,
    channel: (row.channel as string) ?? null,
    chatId: (row.chat_id as string) ?? null,
    workflowRunId: (row.workflow_run_id as string) ?? null,
    workflowId: (row.workflow_id as string) ?? null,
    workflowNodeId: (row.workflow_node_id as string) ?? null,
    intentEventId: (row.intent_event_id as string) ?? null,
    intentDecidedBy: (row.intent_decided_by as string) ?? null,
    resumeSessionId: (row.resume_session_id as string) ?? null,
    finalSessionId: (row.final_session_id as string) ?? null,
    model: (row.model as string) ?? null,
    status: row.status as string,
    startedAt: row.started_at as number,
    finishedAt: (row.finished_at as number) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    inputTokens: (row.input_tokens as number) ?? null,
    outputTokens: (row.output_tokens as number) ?? null,
    cacheReadTokens: (row.cache_read_tokens as number) ?? null,
    cacheCreateTokens: (row.cache_create_tokens as number) ?? null,
    error: (row.error as string) ?? null,
    messagePreview: (row.message_preview as string) ?? null,
  }
}

function rowToStep(row: Record<string, unknown>): TraceStepRecord {
  return {
    taskId: row.task_id as string,
    seq: row.seq as number,
    name: row.name as string,
    action: (row.action as string) ?? null,
    status: (row.status as string) ?? null,
    inputSummary: (row.input_summary as string) ?? null,
    outputSummary: (row.output_summary as string) ?? null,
    error: (row.error as string) ?? null,
    ms: (row.ms as number) ?? null,
    startedAt: row.started_at as number,
  }
}

/** Fetch a trace + its ordered steps. Returns null if no such task_id. */
export function getTrace(
  db: Database.Database,
  taskId: string,
): { task: TraceRecord; steps: TraceStepRecord[] } | null {
  const row = db.prepare("SELECT * FROM task_traces WHERE task_id = ?").get(taskId) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const stepRows = db
    .prepare("SELECT * FROM task_trace_steps WHERE task_id = ? ORDER BY seq")
    .all(taskId) as Record<string, unknown>[]
  return { task: rowToTrace(row), steps: stepRows.map(rowToStep) }
}

/** Triage / dashboard surface — list traces newest-first, filtered. */
export function listTraces(db: Database.Database, filters: ListTracesFilters = {}): TraceRecord[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filters.agentId) { where.push("agent_id = ?"); params.push(filters.agentId) }
  if (filters.channel) { where.push("channel = ?"); params.push(filters.channel) }
  if (filters.chatId) { where.push("chat_id = ?"); params.push(filters.chatId) }
  if (filters.workflowRunId) { where.push("workflow_run_id = ?"); params.push(filters.workflowRunId) }
  if (filters.status) { where.push("status = ?"); params.push(filters.status) }
  if (filters.since !== undefined) { where.push("started_at >= ?"); params.push(filters.since) }
  if (filters.until !== undefined) { where.push("started_at <= ?"); params.push(filters.until) }

  const limit = Math.max(1, Math.min(filters.limit ?? 100, 1000))
  const sql = `
    SELECT * FROM task_traces
    ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY started_at DESC
    LIMIT ?
  `
  params.push(limit)
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToTrace)
}
