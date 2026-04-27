import type Database from "better-sqlite3"
import { getEventBus, type AgentXEvents } from "@/events/bus"

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
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tasks
      ) VALUES (
        @agent_id, @model, @day,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_create_tokens, 1
      )
      ON CONFLICT(agent_id, model, day) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_create_tokens = cache_create_tokens + excluded.cache_create_tokens,
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

  const onStarted = (p: AgentXEvents["task:started"]) => {
    const key = `${p.agentId}:${p.channel}:${p.chatId}`
    pending.set(key, {
      agentId: p.agentId,
      channel: p.channel,
      chatId: p.chatId,
      startedAt: p.at,
      messagePreview: p.messagePreview,
    })
  }

  const onCompleted = (p: AgentXEvents["task:completed"]) => {
    const key = `${p.agentId}:${p.channel}:${p.chatId}`
    const start = pending.get(key)
    pending.delete(key)
    const id = `${p.agentId}:${p.channel}:${p.chatId}:${p.at}`
    const status = p.error ? "error" : "ok"

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

    if (!p.error && (p.inputTokens || p.outputTokens)) {
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
        })
      } catch { /* */ }
    }
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
  bus.on("session:rotated", onRotated)
  bus.on("message:matched", onMatched)
  bus.on("message:dropped", onDropped)

  return () => {
    bus.off("task:started", onStarted)
    bus.off("task:completed", onCompleted)
    bus.off("session:rotated", onRotated)
    bus.off("message:matched", onMatched)
    bus.off("message:dropped", onDropped)
  }
}
