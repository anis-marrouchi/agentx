import { EventEmitter } from "events"

// --- Internal event bus ---
//
// Typed pub/sub singleton. The router and registry emit lifecycle events
// instead of calling log / SSE / analytics inline; subscribers attach
// once at boot and observe without coupling to the hot path.
//
// Why a bus:
//   - Adding a new side-effect (audit log, dashboard SSE, plugin hook)
//     used to require editing router.ts or registry.ts. Now: subscribe.
//   - The Phase 1 traceRoute() function logs to a single sink; with the
//     bus, it's also published to anyone listening (dashboard, sqlite
//     writer, plugin). Same call site, more receivers.
//   - Plugin loader (Move 3) can subscribe; SQLite writer (Move 2) can
//     subscribe; nothing else changes.
//
// Why a singleton:
//   - The router + registry are themselves singletons inside the daemon
//     process. Passing the bus through every constructor would touch
//     every tier-A file for no benefit. The bus is a process-global,
//     same as `console` or the logger.
//
// Backward compat:
//   - Every existing log call stays put. The bus is ADDITIVE — emits
//     happen alongside existing logs, not in place of them. Future
//     commits can migrate inline `this.log(...)` → bus subscriber that
//     formats and logs.

/**
 * Lifecycle events the daemon emits. Keep this list narrow and stable
 * — every event becomes a public contract once a subscriber depends on
 * it. Add events sparingly and never remove or rename without a major
 * version bump.
 */
export interface AgentXEvents {
  /** Inbound message arrived at the router and was matched to an agent.
   *  Fired AFTER the routing pipeline produces a `match` decision. Drops
   *  fire `message:dropped` instead. */
  "message:matched": {
    channel: string
    chatId: string
    msgId: string
    accountId?: string
    agentId: string
    decidingStage: string
    at: string // ISO
  }

  /** Inbound message dropped by the routing pipeline. */
  "message:dropped": {
    channel: string
    chatId: string
    msgId: string
    accountId?: string
    decidingStage: string
    reason: string
    at: string
  }

  /** A task is about to be dispatched to the agent runtime.
   *
   *  taskId is the ULID for the per-execution trace
   *  (src/storage/traces.ts). Emitters generate it BEFORE firing this
   *  event so it can also be threaded into the runtime call chain;
   *  the SQLite subscriber uses it to open the trace row, and the
   *  streaming parser uses it to record per-step tool_use/tool_result
   *  rows. Optional for backward compatibility — emitters that haven't
   *  been updated still produce a valid event and the subscriber
   *  falls back to allocating its own id. */
  "task:started": {
    agentId: string
    channel: string
    chatId: string
    messagePreview: string // first ~200 chars
    /** Full untruncated message — used by SQLite subscriber to populate
     *  task_traces.original_message so `agentx trace replay <taskId>` can
     *  re-fire the exact original task. Optional for back-compat with
     *  older emitters that only carried the preview. */
    fullMessage?: string
    at: string
    taskId?: string
  }

  /** A single step inside an in-flight task — typically a tool call or
   *  tool result inside the Claude streaming response. Producer is the
   *  per-event callback inside registry.execute's streaming path; the
   *  SQLite subscriber persists each step into task_trace_steps under
   *  the task's ULID. inputSummary / outputSummary are caller-byte-
   *  capped (typically 8KB) so a runaway tool result can't blow up the
   *  bus payload or DB row size.
   *
   *  Conventional `name` values: "tool_use" | "tool_result" |
   *  "llm_message" | "session_rotation" | "error" | "preflight". Free-
   *  form strings are accepted to let future capture sites extend
   *  without a schema bump. */
  "task:step": {
    taskId: string
    agentId: string
    name: string
    action?: string
    status?: "ok" | "error" | "in-flight"
    inputSummary?: string
    outputSummary?: string
    error?: string
    ms?: number
    at: string
  }

  /** Task finished — success or failure. Includes usage so subscribers
   *  can write to billing, sqlite, or analytics without re-querying.
   *
   *  Tier-2 fields hold the portion of THIS task's tokens that fell into
   *  the "above-threshold" pricing tier (decided at record time by
   *  TokenTracker; see usage_daily v5 in src/storage/sqlite.ts). They are
   *  optional and additive — emitters that don't compute the split simply
   *  omit them and subscribers treat the missing values as 0. */
  "task:completed": {
    /** Trace ULID — when present, lets subscribers finalize the exact
     *  trace row that the matching task:started opened, eliminating the
     *  ambiguity when two tasks for the same (agent, channel, chatId)
     *  overlap. Optional for backward compatibility; subscribers fall
     *  back to a pending-map lookup when absent. */
    taskId?: string
    agentId: string
    channel: string
    chatId: string
    durationMs: number
    error?: string
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreateTokens?: number
    tier2InputTokens?: number
    tier2OutputTokens?: number
    tier2CacheReadTokens?: number
    tier2CacheCreateTokens?: number
    /** Agent's final reply text — recorded into task_traces.final_response
     *  so `replay --diff` can show original vs current output side-by-side.
     *  Optional for back-compat. */
    finalResponse?: string
    at: string
  }

  /** Claude session rotation fired (stale / max-turns / tier-2). */
  "session:rotated": {
    /** Trace ULID of the in-flight task at rotation time, when known.
     *  When set, the rotation is recorded as a step on that trace. */
    taskId?: string
    agentId: string
    channel: string
    chatId: string
    reason: "stale" | "max-turns" | "tier-2"
    lastTurnInputTokens?: number
    at: string
  }
}

type EventName = keyof AgentXEvents
type Listener<E extends EventName> = (payload: AgentXEvents[E]) => void

class TypedEventBus {
  private inner = new EventEmitter()

  constructor() {
    // Default listener cap is 10 — easy to hit when several subsystems
    // subscribe (dashboard SSE, sqlite writer, audit log, drift detector).
    // 50 is generous without masking real leaks.
    this.inner.setMaxListeners(50)
  }

  on<E extends EventName>(event: E, listener: Listener<E>): this {
    this.inner.on(event, listener as (...args: unknown[]) => void)
    return this
  }

  off<E extends EventName>(event: E, listener: Listener<E>): this {
    this.inner.off(event, listener as (...args: unknown[]) => void)
    return this
  }

  emit<E extends EventName>(event: E, payload: AgentXEvents[E]): boolean {
    return this.inner.emit(event, payload)
  }

  listenerCount<E extends EventName>(event: E): number {
    return this.inner.listenerCount(event)
  }

  /** Test/dev helper — drop every subscriber. */
  removeAllListeners(): this {
    this.inner.removeAllListeners()
    return this
  }
}

let _instance: TypedEventBus | undefined
export function getEventBus(): TypedEventBus {
  if (!_instance) _instance = new TypedEventBus()
  return _instance
}

export type { TypedEventBus }
