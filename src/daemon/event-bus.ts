// --- Event bus ---
//
// Single in-process fanout for operator-observable daemon events. Each
// event is typed (run / task / signal / mesh / channel / status) and
// carries a small structured payload. Subscribers register a filter —
// by kind, by workflow id, by actor, by channel — and receive events
// that match.
//
// Wire-level shape emitted over SSE:
//   event: <kind>
//   data: <JSON payload>
//
// Not persistent beyond the shared ring buffer. Run jsonl is the durable
// audit trail; this is a live observability surface.
//
// This class is a filtered view over the one process bus (src/events/bus.ts):
// publish() becomes an envelope there, and subscribe() reads envelopes back
// that carry this legacy shape. Each event on the wire also gains the
// envelope's rootId and node.

import { randomUUID } from "crypto"
import { TypedEventBus } from "@/events/bus"

export type EventKind =
  | "run"      // workflow run transitions (created, node ok/failed/paused/resumed, completed)
  | "task"     // user-task lifecycle (created, submitted, canceled)
  | "signal"   // signal emissions
  | "mesh"     // peer state deltas (healthy/unhealthy, skills change)
  | "channel"  // incoming / outgoing channel messages
  | "status"   // daemon-level status (legacy /events shape kept for compatibility)

export interface BaseEvent {
  kind: EventKind
  /** Monotonic-ish identifier; just for debug/replay. */
  id: string
  /** ISO-8601 emit time. */
  at: string
  /** Entry point this event descends from (set by the bus). */
  rootId?: string
  /** Node that published the event (set by the bus). */
  node?: string
}

export interface RunEvent extends BaseEvent {
  kind: "run"
  runId: string
  workflowId: string
  /** Node that just transitioned. Optional for run-created events. */
  nodeId?: string
  /** "created" | "ok" | "failed" | "paused" | "resumed" | "skipped" | "completed" | "timeout". */
  phase: string
  /** Current run status after the transition. */
  status?: string
  homeNode?: string
  note?: string
}

export interface TaskEvent extends BaseEvent {
  kind: "task"
  taskId: string
  workflowId: string
  runId: string
  phase: "created" | "submitted" | "canceled"
  assignedTo?: string[]
  title?: string
  submittedBy?: string
}

export interface SignalEvent extends BaseEvent {
  kind: "signal"
  name: string
  scope: "workflow" | "global"
  workflowId?: string
  payload?: Record<string, unknown>
}

export interface MeshEvent extends BaseEvent {
  kind: "mesh"
  peer: string
  healthy: boolean
  skills?: string[]
  delta: "recovered" | "lost" | "skills-changed" | "added" | "removed"
}

export interface ChannelEvent extends BaseEvent {
  kind: "channel"
  channel: string            // telegram, whatsapp, slack, gitlab, ...
  direction: "in" | "out"
  chatId?: string
  sender?: string            // for inbound
  agentId?: string           // for outbound
  textPreview?: string       // first 140 chars, redacted
  messageId?: string
}

export interface StatusEvent extends BaseEvent {
  kind: "status"
  message: string
  meta?: Record<string, unknown>
}

export type DaemonEvent = RunEvent | TaskEvent | SignalEvent | MeshEvent | ChannelEvent | StatusEvent

export interface SubscriptionFilter {
  /** Match only these kinds. Empty / omitted = all kinds. */
  kinds?: EventKind[]
  /** Workflow id filter (applies to run/task/signal events). */
  workflowId?: string
  /** Actor id filter (task.assignedTo includes this, or task.submittedBy equals). */
  actor?: string
  /** Channel filter (for channel events). */
  channel?: string
  /** Run id filter (run events for a specific run). */
  runId?: string
}

type Listener = (e: DaemonEvent) => void

/** Filtered publish/subscribe over the process bus. Subscribers see events
 *  in publish order; listener callbacks run synchronously and a throwing
 *  listener cannot break the fanout. Pass the shared bus in production;
 *  the default gives each instance a private one (tests). */
export class EventBus {
  private count = 0

  constructor(private core: TypedEventBus = new TypedEventBus()) {}

  subscribe(filter: SubscriptionFilter, fn: Listener): () => void {
    this.count++
    const stop = this.core.subscribe((env, data) => {
      if (!data || !LEGACY_KINDS.includes(data.kind as EventKind)) return
      const e = { ...data, rootId: env.rootId, node: env.node } as DaemonEvent
      if (matches(filter, e)) fn(e)
    })
    let active = true
    return () => { if (active) { active = false; this.count--; stop() } }
  }

  /** Publish an event. The `id` and `at` fields are filled in if absent.
   *  We deliberately accept a loose input shape — callers construct the
   *  per-kind literal and we trust them; runtime validation happens at
   *  the SSE serialisation layer. */
  publish(event: { kind: EventKind } & Record<string, unknown>): void {
    const full = {
      id: typeof event.id === "string" ? event.id : randomUUID(),
      at: typeof event.at === "string" ? event.at : new Date().toISOString(),
      ...event,
    } as DaemonEvent
    const { type, summary, ref, agentId } = describe(full)
    this.core.publish({
      id: full.id, at: full.at, kind: full.kind, type, summary, ref, agentId,
      rootId: typeof event.rootId === "string" ? event.rootId : undefined,
      data: full as unknown as Record<string, unknown>,
    })
  }

  /** Active subscriber count — useful for health endpoints. */
  get size(): number { return this.count }
}

const LEGACY_KINDS: EventKind[] = ["run", "task", "signal", "mesh", "channel", "status"]

/** Envelope type, summary and ref for a legacy event. */
function describe(e: DaemonEvent): { type: string; summary: string; ref?: string; agentId?: string } {
  switch (e.kind) {
    case "run":
      return { type: e.phase, ref: e.runId, summary: [e.workflowId, e.nodeId, e.phase, e.note].filter(Boolean).join(" ") }
    case "task":
      return { type: e.phase, ref: e.taskId, summary: `${e.title ?? e.taskId} ${e.phase}` }
    case "signal":
      return { type: "emitted", summary: `signal ${e.name} (${e.scope})` }
    case "mesh":
      return { type: e.delta, summary: `peer ${e.peer} ${e.delta}` }
    case "channel":
      return { type: e.direction, ref: e.messageId, agentId: e.agentId, summary: `${e.channel} ${e.direction === "in" ? "inbound" : "outbound"}` }
    case "status":
      return { type: "status", summary: e.message }
  }
}

export function matches(filter: SubscriptionFilter, e: DaemonEvent): boolean {
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(e.kind)) return false
  if (filter.workflowId) {
    if (e.kind === "run" && e.workflowId !== filter.workflowId) return false
    if (e.kind === "task" && e.workflowId !== filter.workflowId) return false
    if (e.kind === "signal" && e.workflowId && e.workflowId !== filter.workflowId) return false
  }
  if (filter.runId) {
    if (e.kind === "run" && e.runId !== filter.runId) return false
    if (e.kind === "task" && e.runId !== filter.runId) return false
  }
  if (filter.actor) {
    if (e.kind !== "task") return false
    const hit = (e.assignedTo?.includes(filter.actor)) || e.submittedBy === filter.actor
    if (!hit) return false
  }
  if (filter.channel) {
    if (e.kind !== "channel" || e.channel !== filter.channel) return false
  }
  return true
}

/** Parse the ?type=run,task,... query-string param into an EventKind[].
 *  Unknown values are dropped silently (forward-compat with future kinds). */
export function parseKindsParam(raw: string | null | undefined): EventKind[] | undefined {
  if (!raw) return undefined
  const known: EventKind[] = ["run", "task", "signal", "mesh", "channel", "status"]
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean) as EventKind[]
  const kept = parts.filter((p) => known.includes(p))
  return kept.length ? kept : undefined
}
