import type { EventEnvelope } from "./envelope"
import { formatEventLine, matchesFilters, matchesSubscription, subscriptionsFor, type SubscriptionInput } from "./subscriptions"

// --- Wake on event ---
//
// A `wake` subscription starts a turn for the subscribing agent when a
// matching event is published. It is opt-in and guarded three ways:
//   1. Loop guard: never on the agent's own events, and never on an event
//      whose rootId the agent has already worked under. A woken turn runs
//      under the event's root, so anything it causes shares that root and
//      cannot wake it again.
//   2. Dedup: one wake per rootId, however many matching events it has.
//   3. Rate limit: each wake subscription wakes the agent at most its
//      `maxPerHour` times in a sliding hour.
// Every skipped wake is logged with its reason.

export type WakeOutcome =
  | { agentId: string; eventId: string; woke: true }
  | { agentId: string; eventId: string; woke: false; reason: "own-event" | "own-root" | "duplicate-root" | "rate-limit" }

export interface WakeDeps {
  /** Current agent definitions (read on every event, so reloads apply). */
  agents: () => Record<string, { subscriptions?: SubscriptionInput[] }>
  /** Start the turn. Called asynchronously, off the publish path. */
  dispatch: (agentId: string, e: EventEnvelope) => Promise<unknown> | void
  log: (msg: string) => void
  now?: () => number
}

const HOUR_MS = 60 * 60 * 1000
/** How long a root stays remembered for dedup and the loop guard. */
const ROOT_TTL_MS = 24 * HOUR_MS
/** Roots remembered per agent, oldest dropped first. */
const ROOT_CAP = 2000

export class EventWaker {
  private wakes = new Map<string, number[]>()
  /** Per agent: rootId → last time seen. `own` holds roots the agent's own
   *  events carried; `woken` holds roots it was woken for. */
  private own = new Map<string, Map<string, number>>()
  private woken = new Map<string, Map<string, number>>()
  private readonly now: () => number

  constructor(private deps: WakeDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Decide, and dispatch, the wakes one envelope causes. */
  handle(e: EventEnvelope): WakeOutcome[] {
    const out: WakeOutcome[] = []
    const agents = this.deps.agents()
    const t = this.now()
    for (const [agentId, def] of Object.entries(agents)) {
      const subs = subscriptionsFor(def.subscriptions, "wake")
      if (subs.length === 0) continue
      // An agent's own event never wakes it. Its root is remembered, so a
      // later event under the same root is recognised as its own doing.
      if (e.agentId === agentId) {
        remember(this.own, agentId, e.rootId, t)
        // Not logged: an agent's own steps would flood the log.
        if (subs.some((s) => matchesFilters({ ...s, agents: undefined }, e))) {
          out.push({ agentId, eventId: e.id, woke: false, reason: "own-event" })
        }
        continue
      }
      // Wake subscriptions that match, by their index in the agent's list:
      // each has its own rate bucket.
      const hits = (def.subscriptions ?? [])
        .map((s, index) => ({ s, index }))
        .filter(({ s }) => s.delivery === "wake" && matchesSubscription(s, e, agentId))
      if (hits.length === 0) continue
      const outcome = this.decide(agentId, e, hits, t)
      out.push(outcome)
      if (!outcome.woke) {
        this.deps.log(`[events] wake skipped for ${agentId}: ${outcome.reason} — ${formatEventLine(e)} root=${e.rootId.slice(0, 8)}`)
        continue
      }
      this.deps.log(`[events] waking ${agentId} — ${formatEventLine(e)} root=${e.rootId.slice(0, 8)}`)
      setImmediate(() => {
        try {
          Promise.resolve(this.deps.dispatch(agentId, e)).catch((err: any) =>
            this.deps.log(`[events] wake of ${agentId} failed: ${err?.message ?? err}`))
        } catch (err: any) {
          this.deps.log(`[events] wake of ${agentId} failed: ${err?.message ?? err}`)
        }
      })
    }
    return out
  }

  private decide(agentId: string, e: EventEnvelope, hits: Array<{ s: SubscriptionInput; index: number }>, t: number): WakeOutcome {
    const base = { agentId, eventId: e.id }
    if (seen(this.own, agentId, e.rootId, t)) return { ...base, woke: false, reason: "own-root" }
    if (seen(this.woken, agentId, e.rootId, t)) return { ...base, woke: false, reason: "duplicate-root" }
    // The first matching subscription with room in its own hourly bucket
    // takes the wake; when every bucket is full the wake is skipped.
    for (const { s, index } of hits) {
      const key = `${agentId}#${index}`
      const recent = (this.wakes.get(key) ?? []).filter((w) => t - w < HOUR_MS)
      if (recent.length >= (s.maxPerHour ?? 4)) { this.wakes.set(key, recent); continue }
      recent.push(t)
      this.wakes.set(key, recent)
      remember(this.woken, agentId, e.rootId, t)
      return { ...base, woke: true }
    }
    return { ...base, woke: false, reason: "rate-limit" }
  }

  /** Subscribe to a bus; returns the unsubscribe function. */
  attach(bus: { subscribe(fn: (e: EventEnvelope) => void): () => void }): () => void {
    return bus.subscribe((e) => { this.handle(e) })
  }
}

function remember(store: Map<string, Map<string, number>>, agentId: string, rootId: string, t: number): void {
  let roots = store.get(agentId)
  if (!roots) { roots = new Map(); store.set(agentId, roots) }
  roots.delete(rootId)
  roots.set(rootId, t)
  if (roots.size > ROOT_CAP) roots.delete(roots.keys().next().value as string)
}

function seen(store: Map<string, Map<string, number>>, agentId: string, rootId: string, t: number): boolean {
  const at = store.get(agentId)?.get(rootId)
  return at !== undefined && t - at < ROOT_TTL_MS
}

/** The message a woken turn receives: what happened, and where to read more. */
export function wakeMessage(e: EventEnvelope): string {
  return [
    "[Event] A subscription of yours matched:",
    formatEventLine(e),
    `Event id ${e.id}, root ${e.rootId}. Call agentx_events for the surrounding events. Act on it if it needs you; otherwise reply briefly that no action is needed.`,
  ].join("\n")
}
