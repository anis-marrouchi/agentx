import { AsyncLocalStorage } from "async_hooks"
import { randomUUID } from "crypto"

// --- Event envelope ---
//
// Every event on the bus, whatever its source, is described by one
// envelope. It is deliberately small: a bounded summary plus a `ref` to
// the durable record (trace id, run id, task id) for anything longer.
// Full prompts and answers never ride in an envelope; subscribers that
// need them (the SQLite writer) read the typed lifecycle payload instead.

export interface EventEnvelope {
  id: string
  /** The entry point this event descends from (inbound message, cron fire,
   *  webhook, mesh task). Events with no known entry point are their own
   *  root. Carried across mesh forwards so peers share it. */
  rootId: string
  /** The event that directly caused this one, when known (for example the
   *  mesh forward on the sending node). */
  parentId?: string
  /** Node that published the event. */
  node: string
  agentId?: string
  /** Coarse family: message, agent, run, task, signal, mesh, channel, status. */
  kind: string
  /** Specific event within the family, for example "task:started" or "failed". */
  type: string
  at: string
  /** Human-readable, at most SUMMARY_MAX characters. */
  summary: string
  /** Pointer to the durable record: a trace id, run id or task id. */
  ref?: string
}

export const SUMMARY_MAX = 280

export function capSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= SUMMARY_MAX ? flat : flat.slice(0, SUMMARY_MAX - 1) + "…"
}

export function newEventId(): string {
  return randomUUID()
}

// --- Root context ---
//
// The root id follows the async call chain from an entry point, so the
// router, registry, dispatcher and mesh client never pass it by hand.
// Entry points start a fresh root; mesh /task adopts the sender's.

export interface RootContext {
  rootId: string
  parentId?: string
}

const rootStore = new AsyncLocalStorage<RootContext>()

export function currentRoot(): RootContext | undefined {
  return rootStore.getStore()
}

/** Run `fn` under an explicit root (for example one received from a peer). */
export function withRoot<T>(ctx: RootContext, fn: () => T): T {
  return rootStore.run(ctx, fn)
}

/** Run `fn` as a new entry point with a fresh root id. */
export function withNewRoot<T>(fn: () => T): T {
  return rootStore.run({ rootId: newEventId() }, fn)
}

// --- Ring buffer ---
//
// Short, bounded memory of recent envelopes so a late reader can catch up.
// The run and trace stores remain the durable record.

export interface RecentQuery {
  /** An event id (returns events after it) or an ISO timestamp. */
  since?: string
  kind?: string
  agent?: string
  limit?: number
}

export const DEFAULT_RING_SIZE = 1000

export class EventRing {
  private items: EventEnvelope[] = []

  constructor(private capacity: number = DEFAULT_RING_SIZE) {}

  resize(capacity: number): void {
    this.capacity = Math.max(1, Math.floor(capacity))
    if (this.items.length > this.capacity) this.items = this.items.slice(-this.capacity)
  }

  push(e: EventEnvelope): void {
    this.items.push(e)
    if (this.items.length > this.capacity) this.items.shift()
  }

  clear(): void {
    this.items = []
  }

  recent(q: RecentQuery = {}): EventEnvelope[] {
    let out = this.items
    if (q.since) {
      const idx = out.findIndex((e) => e.id === q.since)
      if (idx >= 0) out = out.slice(idx + 1)
      else {
        const t = Date.parse(q.since)
        if (!Number.isNaN(t)) out = out.filter((e) => Date.parse(e.at) > t)
      }
    }
    if (q.kind) out = out.filter((e) => e.kind === q.kind)
    if (q.agent) out = out.filter((e) => e.agentId === q.agent)
    const limit = q.limit && q.limit > 0 ? q.limit : this.capacity
    return out.slice(-limit)
  }
}
