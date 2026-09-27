import type { EventSubscription } from "@/daemon/config"
import type { EventEnvelope } from "./envelope"

// --- Per-agent event subscriptions ---
//
// An agent lists the events it cares about in `agents.<id>.subscriptions`.
// This module is the pure half: does an envelope match, which envelopes
// does an agent get, and how a digest reads. Delivery lives elsewhere:
//   pull   — GET /agents/:id/events, the agentx_events MCP tool and
//            `agentx events` read eventsForAgent()
//   digest — the registry injects renderDigest() into FRESH sessions only
//   wake   — src/events/wake.ts starts a turn
// Every answer is bounded: envelopes already cap their summary, and each
// reader caps the count.

export type Delivery = EventSubscription["delivery"]

/** Most events one pull returns. */
export const PULL_MAX = 50
export const PULL_DEFAULT = 20
/** Most events a fresh-session digest lists. */
export const DIGEST_MAX = 10

/** Loose input shape: config output, or a hand-written object in tests. */
export type SubscriptionInput = Partial<EventSubscription> & { kinds: string[] }

/** Does `e` match `sub` for `self`? An agent never matches its own events
 *  unless the subscription names it in `agents` (and `wake` never does;
 *  see wake.ts). */
export function matchesSubscription(sub: SubscriptionInput, e: EventEnvelope, self: string): boolean {
  if (e.agentId === self && !sub.agents?.includes(self)) return false
  return matchesFilters(sub, e)
}

/** The subscription's own filters, with no regard to who is asking. */
export function matchesFilters(sub: SubscriptionInput, e: EventEnvelope): boolean {
  if (!sub.kinds.some((k) => k === "*" || k === e.kind || k === e.type)) return false
  if (sub.agents?.length && (!e.agentId || !sub.agents.includes(e.agentId))) return false
  if (sub.nodes?.length && !sub.nodes.includes(e.node)) return false
  if (sub.match && !e.summary.toLowerCase().includes(sub.match.toLowerCase())) return false
  return true
}

/** Subscriptions of one delivery mode. `pull` reads every subscription:
 *  digest and wake events can always be pulled too. */
export function subscriptionsFor(subs: SubscriptionInput[] | undefined, delivery: Delivery): SubscriptionInput[] {
  if (!subs?.length) return []
  return delivery === "pull" ? subs : subs.filter((s) => (s.delivery ?? "pull") === delivery)
}

/** Events from `events` (oldest first) that match any of `subs`. With no
 *  cursor the newest `limit` are kept. When `events` was already read after
 *  a cursor (`fromCursor`), the OLDEST `limit` are kept instead, so a reader
 *  that passes the last returned id back as `since` pages through every
 *  match without gaps. */
export function eventsForAgent(
  agentId: string,
  subs: SubscriptionInput[] | undefined,
  events: EventEnvelope[],
  opts: { delivery?: Delivery; limit?: number; fromCursor?: boolean } = {},
): EventEnvelope[] {
  const active = subscriptionsFor(subs, opts.delivery ?? "pull")
  if (active.length === 0) return []
  const limit = clampLimit(opts.limit)
  const hits = events.filter((e) => active.some((s) => matchesSubscription(s, e, agentId)))
  return opts.fromCursor ? hits.slice(0, limit) : hits.slice(-limit)
}

export function clampLimit(limit: number | undefined, fallback = PULL_DEFAULT): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return fallback
  return Math.min(Math.floor(limit), PULL_MAX)
}

/** The events a fresh session should hear about: digest subscriptions
 *  matched since the agent's last finished turn (the whole buffer when it
 *  has none), newest DIGEST_MAX. Returns the shown events and how many
 *  more matched. */
export function digestEvents(
  agentId: string,
  subs: SubscriptionInput[] | undefined,
  events: EventEnvelope[],
): { shown: EventEnvelope[]; more: number } {
  const active = subscriptionsFor(subs, "digest")
  if (active.length === 0) return { shown: [], more: 0 }
  let start = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].agentId === agentId && events[i].type === "task:completed") { start = i + 1; break }
  }
  const hits = events.slice(start).filter((e) => active.some((s) => matchesSubscription(s, e, agentId)))
  const shown = hits.slice(-DIGEST_MAX)
  return { shown, more: hits.length - shown.length }
}

/** One line per event: time, type, who and where, summary, ref. */
export function formatEventLine(e: EventEnvelope): string {
  const who = e.agentId ? `${e.agentId}@${e.node}` : e.node
  const ref = e.ref ? ` (ref ${e.ref})` : ""
  return `${e.at.slice(0, 16).replace("T", " ")} ${e.type} ${who}: ${e.summary}${ref}`
}

/** The context block for a fresh session, or undefined when nothing matched. */
export function renderDigest(shown: EventEnvelope[], more: number): string | undefined {
  if (shown.length === 0) return undefined
  const lines = [
    `[Events since your last turn — ${shown.length + more} matched your subscriptions${more ? `, newest ${shown.length} shown` : ""}. Call agentx_events for details or newer ones:]`,
    ...shown.map((e) => `- ${formatEventLine(e)}`),
  ]
  return lines.join("\n")
}
