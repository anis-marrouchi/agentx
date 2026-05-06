import type Database from "better-sqlite3"
import { getEventBus, type AgentXEvents } from "@/events/bus"
import { recordTraceStart, recordTraceEnd, recordTraceStep } from "@/storage/traces"

// --- Bus subscribers that persist to SQLite ---
//
// Move 2 wires the daemon's lifecycle events (Move 1) to SQLite tables
// without touching the hot path. Each subscriber is a tiny function that
// translates an event payload into a prepared-statement run.
//
// Idempotency: every subscriber uses INSERT OR REPLACE / UPSERT so
// replays don't double-count. Cheap: better-sqlite3 prepared statements
// run in microseconds, well under any agent turn's lifetime.

interface Stmts {
  insertTaskHistory: Database.Statement
  upsertUsageDaily: Database.Statement
  insertRotation: Database.Statement
  insertRouteTrace: Database.Statement
}

function prepare(db: Database.Database): Stmts {
  return {
    insertTaskHistory: db.prepare(`
      INSERT OR REPLACE INTO task_history (
        id, agent_id, channel, chat_id, status, message_preview, error,
        duration_ms, input_tokens, output_tokens,
        cache_read_tokens, cache_create_tokens,
        started_at, finished_at
      ) VALUES (
        @id, @agent_id, @channel, @chat_id, @status, @message_preview, @error,
        @duration_ms, @input_tokens, @output_tokens,
        @cache_read_tokens, @cache_create_tokens,
        @started_at, @finished_at
      )
    `),
    upsertUsageDaily: db.prepare(`
      INSERT INTO usage_daily (
        agent_id, model, day,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        tier2_input_tokens, tier2_output_tokens,
        tier2_cache_read_tokens, tier2_cache_create_tokens,
        tasks
      ) VALUES (
        @agent_id, @model, @day,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_create_tokens,
        @tier2_input_tokens, @tier2_output_tokens,
        @tier2_cache_read_tokens, @tier2_cache_create_tokens,
        1
      )
      ON CONFLICT(agent_id, model, day) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_create_tokens = cache_create_tokens + excluded.cache_create_tokens,
        tier2_input_tokens = tier2_input_tokens + excluded.tier2_input_tokens,
        tier2_output_tokens = tier2_output_tokens + excluded.tier2_output_tokens,
        tier2_cache_read_tokens = tier2_cache_read_tokens + excluded.tier2_cache_read_tokens,
        tier2_cache_create_tokens = tier2_cache_create_tokens + excluded.tier2_cache_create_tokens,
        tasks = tasks + 1
    `),
    insertRotation: db.prepare(`
      INSERT INTO rotations (agent_id, channel, chat_id, reason, last_turn_input_tokens, rotated_at)
      VALUES (@agent_id, @channel, @chat_id, @reason, @last_turn_input_tokens, @rotated_at)
    `),
    insertRouteTrace: db.prepare(`
      INSERT INTO route_traces (channel, chat_id, msg_id, account_id, kind, deciding_stage, agent_id, reason, at)
      VALUES (@channel, @chat_id, @msg_id, @account_id, @kind, @deciding_stage, @agent_id, @reason, @at)
    `),
  }
}

interface PendingTask {
  agentId: string
  channel: string
  chatId: string
  startedAt: string
  messagePreview: string
}

/**
 * Wire all SQLite subscribers to the global event bus. Returns a
 * disposer that removes them — used by tests, not by the daemon.
 *
 * The pending-task map matches `task:started` to its corresponding
 * `task:completed` so we record one row with both starts and ends. Lost
 * starts (daemon crash mid-task) just won't have a row; that's fine —
 * task_history is observability, not source of truth.
 */
export function attachSqliteSubscribers(db: Database.Database, model = "claude-opus-4-7"): () => void {
  const bus = getEventBus()
  const stmts = prepare(db)
  const pending = new Map<string, PendingTask>()
  // Parallel map: key → ULID task_id assigned at task:started, looked up at
  // task:completed / session:rotated to attach end-state and step rows.
  // Separate from `pending` because PendingTask carries fields task_history
  // needs; this one carries only what task_traces needs.
  const pendingTraceIds = new Map<string, string>()

  const onStarted = (p: AgentXEvents["task:started"]) => {
    const key = `${p.agentId}:${p.channel}:${p.chatId}`
    pending.set(key, {
      agentId: p.agentId,
      channel: p.channel,
      chatId: p.chatId,
      startedAt: p.at,
      messagePreview: p.messagePreview,
    })

    // Improvement plan #2 — open a trace row at start so per-step capture
    // sites have a target. Workflow context derived from the chatId
    // convention (`workflow:${runId}`) so we don't need a payload bump
    // on the bus event.
    let workflowRunId: string | null = null
    if (typeof p.chatId === "string" && p.chatId.startsWith("workflow:")) {
      workflowRunId = p.chatId.slice("workflow:".length) || null
    }
    try {
      // Honour an upstream-allocated taskId when present. Lets the
      // runtime emit per-step rows under the same id without a second
      // round-trip. When absent, allocate one ourselves.
      const taskId = recordTraceStart(
        db,
        {
          agentId: p.agentId,
          channel: p.channel,
          chatId: p.chatId,
          messagePreview: p.messagePreview,
          // Migration v8 — full untruncated message persisted so
          // `agentx trace replay <taskId>` can re-fire the exact request.
          // Falls back to messagePreview on the storage-write side when
          // not present (older emitters); this branch is the new path.
          originalMessage: p.fullMessage ?? p.messagePreview,
          workflowRunId,
        },
        p.taskId,
      )
      pendingTraceIds.set(key, taskId)
    } catch { /* observability best-effort */ }
  }

  const onCompleted = (p: AgentXEvents["task:completed"]) => {
    const key = `${p.agentId}:${p.channel}:${p.chatId}`
    const start = pending.get(key)
    pending.delete(key)
    // Prefer the explicit taskId in the event when present — eliminates
    // the corruption mode where two overlapping tasks on the same
    // (agentId, channel, chatId) overwrite each other in the map and
    // strand the earlier task as in-flight forever (caught in the live
    // smoke test 2026-05-03). Fall back to the pending-map lookup for
    // legacy emitters.
    const traceTaskId = p.taskId ?? pendingTraceIds.get(key)
    pendingTraceIds.delete(key)
    const id = `${p.agentId}:${p.channel}:${p.chatId}:${p.at}`
    const status = p.error ? "error" : "ok"

    // Finalize the trace row — same status/tokens task_history records,
    // plus duration computed inside the UPDATE.
    if (traceTaskId) {
      try {
        recordTraceEnd(db, traceTaskId, {
          status: p.error ? "error" : "ok",
          inputTokens: p.inputTokens ?? null,
          outputTokens: p.outputTokens ?? null,
          cacheReadTokens: p.cacheReadTokens ?? null,
          cacheCreateTokens: p.cacheCreateTokens ?? null,
          error: p.error ?? null,
          // Migration v8 — final response captured so `replay --diff` can
          // show original vs current output without reconstructing from
          // step events.
          finalResponse: p.finalResponse ?? null,
        })
      } catch { /* */ }
    }

    try {
      stmts.insertTaskHistory.run({
        id,
        agent_id: p.agentId,
        channel: p.channel,
        chat_id: p.chatId,
        status,
        message_preview: start?.messagePreview ?? null,
        error: p.error ?? null,
        duration_ms: p.durationMs,
        input_tokens: p.inputTokens ?? null,
        output_tokens: p.outputTokens ?? null,
        cache_read_tokens: p.cacheReadTokens ?? null,
        cache_create_tokens: p.cacheCreateTokens ?? null,
        started_at: start?.startedAt ?? p.at,
        finished_at: p.at,
      })
    } catch { /* best-effort observability */ }

    // Upsert into usage_daily when ANY token bucket — tier1 or tier2 —
    // saw activity. A tier2-only request still counts as a billable task,
    // and the previous "(p.inputTokens || p.outputTokens)" gate would
    // silently drop it.
    const hasUsage =
      p.inputTokens || p.outputTokens || p.cacheReadTokens || p.cacheCreateTokens ||
      p.tier2InputTokens || p.tier2OutputTokens || p.tier2CacheReadTokens || p.tier2CacheCreateTokens
    if (!p.error && hasUsage) {
      const day = p.at.slice(0, 10)
      try {
        stmts.upsertUsageDaily.run({
          agent_id: p.agentId,
          model,
          day,
          input_tokens: p.inputTokens ?? 0,
          output_tokens: p.outputTokens ?? 0,
          cache_read_tokens: p.cacheReadTokens ?? 0,
          cache_create_tokens: p.cacheCreateTokens ?? 0,
          tier2_input_tokens: p.tier2InputTokens ?? 0,
          tier2_output_tokens: p.tier2OutputTokens ?? 0,
          tier2_cache_read_tokens: p.tier2CacheReadTokens ?? 0,
          tier2_cache_create_tokens: p.tier2CacheCreateTokens ?? 0,
        })
      } catch { /* */ }
    }
  }

  const onStep = (p: AgentXEvents["task:step"]) => {
    // task:step fires from inside the streaming parser per tool_use /
    // tool_result block. Persist directly under the supplied taskId
    // — no pending-map lookup needed since the producer already knows
    // its trace id. Failures are swallowed so a hot inner loop can't
    // crash the agent from observability.
    try {
      recordTraceStep(db, p.taskId, {
        name: p.name,
        action: p.action ?? null,
        status: p.status ?? null,
        inputSummary: p.inputSummary ?? null,
        outputSummary: p.outputSummary ?? null,
        error: p.error ?? null,
        ms: p.ms ?? null,
      })
    } catch { /* */ }
  }

  const onRotated = (p: AgentXEvents["session:rotated"]) => {
    try {
      stmts.insertRotation.run({
        agent_id: p.agentId,
        channel: p.channel,
        chat_id: p.chatId,
        reason: p.reason,
        last_turn_input_tokens: p.lastTurnInputTokens ?? null,
        rotated_at: p.at,
      })
    } catch { /* */ }

    // Record session_rotation as a step on the in-flight trace, when one
    // exists. Rotations between turns (no active task) are captured only
    // in the rotations table above. Prefer p.taskId when emitted; fall
    // back to the pending-map lookup for emitters that don't carry it.
    const traceKey = `${p.agentId}:${p.channel}:${p.chatId}`
    const traceTaskId = p.taskId ?? pendingTraceIds.get(traceKey)
    if (traceTaskId) {
      try {
        recordTraceStep(db, traceTaskId, {
          name: "session_rotation",
          action: p.reason,
          inputSummary: p.lastTurnInputTokens != null
            ? `last_turn_input_tokens=${p.lastTurnInputTokens}`
            : null,
        })
      } catch { /* */ }
    }
  }

  const onMatched = (p: AgentXEvents["message:matched"]) => {
    try {
      stmts.insertRouteTrace.run({
        channel: p.channel,
        chat_id: p.chatId,
        msg_id: p.msgId,
        account_id: p.accountId ?? null,
        kind: "match",
        deciding_stage: p.decidingStage,
        agent_id: p.agentId,
        reason: null,
        at: p.at,
      })
    } catch { /* */ }
  }

  const onDropped = (p: AgentXEvents["message:dropped"]) => {
    try {
      stmts.insertRouteTrace.run({
        channel: p.channel,
        chat_id: p.chatId,
        msg_id: p.msgId,
        account_id: p.accountId ?? null,
        kind: "drop",
        deciding_stage: p.decidingStage,
        agent_id: null,
        reason: p.reason,
        at: p.at,
      })
    } catch { /* */ }
  }

  bus.on("task:started", onStarted)
  bus.on("task:completed", onCompleted)
  bus.on("task:step", onStep)
  bus.on("session:rotated", onRotated)
  bus.on("message:matched", onMatched)
  bus.on("message:dropped", onDropped)

  return () => {
    bus.off("task:started", onStarted)
    bus.off("task:completed", onCompleted)
    bus.off("task:step", onStep)
    bus.off("session:rotated", onRotated)
    bus.off("message:matched", onMatched)
    bus.off("message:dropped", onDropped)
  }
}
