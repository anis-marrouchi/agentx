import type { EventEnvelope } from "./envelope"

// --- Wake journal (#1648) ---
//
// What each wake did, per event and subscriber, so the Hub can show a
// broadcast and who answered it without the daemon log. EventWaker
// (wake.ts) writes it as it decides, holds, starts and finishes a wake;
// the daemon notes when the woken turn actually began (task:started on
// the `events` channel), which tells a wake that waited for a slot from
// one that ran at once.
//
// In memory and bounded, like the event ring: it starts empty when the
// daemon restarts. Every text field is short (a reason, a capped error);
// no prompt or answer is kept.

export type WakeStatus =
  /** Decided; the turn has not started yet (waiting for a slot). */
  | "waiting"
  /** The dispatch cap held it; a retry is queued. */
  | "held"
  /** The woken turn is running. */
  | "running"
  /** The woken turn finished without an error. */
  | "ran"
  /** The woken turn ended with an error. */
  | "failed"
  /** A deadline ended it: the slot wait, or the run itself. */
  | "timed-out"
  /** Given up: too many retries, or the retry queue was full. */
  | "dropped"
  /** Not woken: own-root, duplicate-root or rate-limit. */
  | "skipped"

export interface WakeRecord {
  agentId: string
  /** The event that caused it, and that event's machine and root. */
  eventId: string
  eventNode: string
  rootId: string
  status: WakeStatus
  /** Why it was skipped, held or dropped. */
  reason?: string
  /** When the wake was decided (ms). */
  decidedAt: number
  /** When the woken turn started (ms): later than decidedAt by the time it
   *  waited for a slot or a hold. */
  startedAt?: number
  endedAt?: number
  /** Dispatch tries: 1 plus every retry after a hold. */
  attempts: number
  /** The woken turn's trace id, once it started. */
  taskId?: string
  /** The error it ended with, capped. */
  error?: string
}

export const WAKE_JOURNAL_SIZE = 500
const ERROR_MAX = 200

const cap = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…")

export class WakeJournal {
  private items = new Map<string, WakeRecord>()

  constructor(private capacity = WAKE_JOURNAL_SIZE, private now: () => number = Date.now) {}

  private key(agentId: string, eventId: string): string {
    return `${agentId}#${eventId}`
  }

  private put(r: WakeRecord): WakeRecord {
    const k = this.key(r.agentId, r.eventId)
    this.items.delete(k)
    this.items.set(k, r)
    while (this.items.size > this.capacity) this.items.delete(this.items.keys().next().value as string)
    return r
  }

  private get(agentId: string, eventId: string): WakeRecord | undefined {
    return this.items.get(this.key(agentId, eventId))
  }

  /** A wake was decided: woken (waiting for its turn) or skipped. */
  decided(agentId: string, e: EventEnvelope, skipped?: string): void {
    this.put({
      agentId, eventId: e.id, eventNode: e.node, rootId: e.rootId,
      status: skipped ? "skipped" : "waiting",
      ...(skipped ? { reason: skipped } : {}),
      decidedAt: this.now(), attempts: skipped ? 0 : 1,
    })
  }

  /** The dispatch cap held it; `retrying` false when it was given up. */
  held(agentId: string, eventId: string, reason: string, retrying: boolean): void {
    const r = this.get(agentId, eventId)
    if (!r) return
    r.status = retrying ? "held" : "dropped"
    r.reason = cap(reason, ERROR_MAX)
  }

  /** A retry of a held wake is being dispatched. */
  retrying(agentId: string, eventId: string): void {
    const r = this.get(agentId, eventId)
    if (!r) return
    r.status = "waiting"
    r.attempts++
  }

  /** The woken turn began. Matched by agent and root: the turn runs under
   *  the event's root (wake dispatch). The oldest wake not yet started
   *  takes it. */
  started(agentId: string, rootId: string, taskId?: string): void {
    for (const r of this.items.values()) {
      if (r.agentId !== agentId || r.rootId !== rootId || r.status !== "waiting") continue
      r.status = "running"
      r.startedAt = this.now()
      if (taskId) r.taskId = taskId
      return
    }
  }

  /** The woken turn returned. `error` set: it failed or timed out. */
  finished(agentId: string, eventId: string, error?: string): void {
    const r = this.get(agentId, eventId)
    if (!r) return
    const t = this.now()
    r.endedAt = t
    if (error) {
      r.status = /timed out|timeout/i.test(error) ? "timed-out" : "failed"
      r.error = cap(error.replace(/\s+/g, " ").trim(), ERROR_MAX)
    } else {
      r.status = "ran"
      delete r.error
    }
    // A turn that returned without ever starting (a slot wait that timed
    // out) has no start time: it waited the whole time.
  }

  /** The event that woke the turn with this trace id, when it was a wake:
   *  what a reply emitted from that turn answers. */
  eventForTask(taskId: string): string | undefined {
    for (const r of this.items.values()) if (r.taskId === taskId) return r.eventId
    return undefined
  }

  /** Every record, oldest decision first. */
  list(): WakeRecord[] {
    return [...this.items.values()].map((r) => ({ ...r }))
  }
}
