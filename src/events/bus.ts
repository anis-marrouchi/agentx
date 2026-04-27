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

  /** A task is about to be dispatched to the agent runtime. */
  "task:started": {
    agentId: string
    channel: string
    chatId: string
    messagePreview: string // first ~200 chars
    at: string
  }

  /** Task finished — success or failure. Includes usage so subscribers
   *  can write to billing, sqlite, or analytics without re-querying. */
  "task:completed": {
    agentId: string
    channel: string
    chatId: string
    durationMs: number
    error?: string
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreateTokens?: number
    at: string
  }

  /** Claude session rotation fired (stale / max-turns / tier-2). */
  "session:rotated": {
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
