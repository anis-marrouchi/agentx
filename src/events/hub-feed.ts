import type { EventEnvelope } from "./envelope"
import type { TypedEventBus } from "./bus"
import type { WakeJournal, WakeRecord, WakeStatus } from "./wake-journal"

// --- The Hub's events feed (#1648) ---
//
// Broadcasts and who answered them. Two halves:
//   nodeEventsFeed()  one daemon's share, served at GET /events/hub: the
//                     named events and announcements in its ring (its own
//                     and those its mesh feed took in) and its wake journal.
//   groupEventsFeed() pure: merges the shares of every machine that
//                     answered and builds the threads the Hub shows.
//
// A thread is one event nobody's reply caused, its wakes, and the events
// sent in reply under it, each with its own wakes. A reply is linked to the
// event that caused it, in this order:
//   1. its parentId names a feed event (an emit from a woken turn carries
//      the event that woke it);
//   2. its sender was woken by a feed event with the same root;
//   3. the latest earlier feed event in the same root from someone else.
// Every field is a bounded summary: no prompt and no answer is kept.

/** Kinds the feed lists: named events and mesh announcements. */
export const FEED_KINDS = ["custom", "announce"]
export const EVENTS_FEED_DEFAULT = 50
export const EVENTS_FEED_MAX = 200
/** Most events and wakes one machine sends. */
const NODE_EVENTS_MAX = 500

/** One wake as the Hub shows it. */
export interface FeedWake {
  agentId: string
  /** The machine the subscriber is on. */
  node: string
  status: WakeStatus
  reason?: string
  decidedAt: number
  startedAt?: number
  endedAt?: number
  /** How long it waited before its turn began (ms): a slot, or a hold.
   *  For a wake that never began, how long it has waited so far. */
  waitedMs?: number
  attempts: number
  taskId?: string
  error?: string
}

export interface FeedItem {
  event: EventEnvelope
  wakes: FeedWake[]
}

export interface FeedThread extends FeedItem {
  replies: FeedItem[]
}

/** One machine's share: what GET /events/hub answers. */
export interface NodeEventsShare {
  node: string
  events: EventEnvelope[]
  wakes: Array<WakeRecord & { node?: string }>
}

export function nodeEventsFeed(bus: Pick<TypedEventBus, "recent" | "nodeName">, journal: WakeJournal | null | undefined): NodeEventsShare {
  const node = bus.nodeName
  const events = bus.recent().filter((e) => FEED_KINDS.includes(e.kind)).slice(-NODE_EVENTS_MAX)
  const wakes = (journal?.list() ?? []).slice(-NODE_EVENTS_MAX).map((w) => ({ ...w, node }))
  return { node, events, wakes }
}

export interface GroupedFeed {
  threads: FeedThread[]
  /** Threads before the limit. */
  total: number
  counts: { events: number; wakes: number; ran: number; waiting: number; timedOut: number; failed: number; skipped: number }
}

export function groupEventsFeed(shares: NodeEventsShare[], opts: { limit?: number; now?: number } = {}): GroupedFeed {
  const now = opts.now ?? Date.now()
  const limit = Math.max(1, Math.min(EVENTS_FEED_MAX, Math.floor(opts.limit || EVENTS_FEED_DEFAULT)))
  // The same event can reach several machines through the mesh feed: keep it once.
  const byId = new Map<string, EventEnvelope>()
  for (const s of shares) for (const e of s.events) {
    if (FEED_KINDS.includes(e.kind) && !byId.has(e.id)) byId.set(e.id, e)
  }
  const events = [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))

  const wakesBy = new Map<string, FeedWake[]>()
  const wokenBy = new Map<string, Array<{ eventId: string; at: number }>>()
  const seen = new Set<string>()
  for (const s of shares) for (const w of s.wakes) {
    const node = w.node || s.node
    const key = `${node}#${w.agentId}#${w.eventId}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = wakesBy.get(w.eventId) ?? []
    list.push(feedWake(w, node, now))
    wakesBy.set(w.eventId, list)
    if (w.status !== "skipped") {
      const k = `${w.agentId}#${w.rootId}`
      const at = wokenBy.get(k) ?? []
      at.push({ eventId: w.eventId, at: w.decidedAt })
      wokenBy.set(k, at)
    }
  }
  for (const list of wakesBy.values()) list.sort((a, b) => a.decidedAt - b.decidedAt || a.agentId.localeCompare(b.agentId))

  // The event each reply answers, then the thread it belongs to.
  const parent = new Map<string, string>()
  const earlier: EventEnvelope[] = []
  for (const e of events) {
    const p = parentOf(e, byId, wokenBy, earlier)
    if (p && p !== e.id) parent.set(e.id, p)
    earlier.push(e)
  }
  const topOf = (id: string): string => {
    let cur = id
    for (let i = 0; i < 50; i++) { const p = parent.get(cur); if (!p) return cur; cur = p }
    return cur
  }
  const threads = new Map<string, FeedThread>()
  const item = (e: EventEnvelope): FeedItem => ({ event: e, wakes: wakesBy.get(e.id) ?? [] })
  for (const e of events) {
    const top = topOf(e.id)
    if (top === e.id) threads.set(e.id, { ...item(e), replies: [] })
    else threads.get(top)?.replies.push(item(e))
  }
  // Newest activity first: a thread with a fresh reply moves up.
  const latest = (t: FeedThread) => Math.max(Date.parse(t.event.at), ...t.replies.map((r) => Date.parse(r.event.at)))
  const all = [...threads.values()].sort((a, b) => latest(b) - latest(a))

  const wakes = [...wakesBy.values()].flat()
  const count = (s: WakeStatus[]) => wakes.filter((w) => s.includes(w.status)).length
  return {
    threads: all.slice(0, limit),
    total: all.length,
    counts: {
      events: events.length,
      wakes: wakes.length,
      ran: count(["ran"]),
      waiting: count(["waiting", "held", "running"]),
      timedOut: count(["timed-out", "dropped"]),
      failed: count(["failed"]),
      skipped: count(["skipped"]),
    },
  }
}

function parentOf(
  e: EventEnvelope,
  byId: Map<string, EventEnvelope>,
  wokenBy: Map<string, Array<{ eventId: string; at: number }>>,
  earlier: EventEnvelope[],
): string | undefined {
  if (e.parentId && byId.has(e.parentId)) return e.parentId
  const t = Date.parse(e.at)
  if (e.agentId) {
    const woke = (wokenBy.get(`${e.agentId}#${e.rootId}`) ?? [])
      .filter((w) => w.eventId !== e.id && byId.has(w.eventId) && Date.parse(byId.get(w.eventId)!.at) <= t)
      .sort((a, b) => b.at - a.at)[0]
    if (woke) return woke.eventId
  }
  // An event that is its own root started something; it answers nothing.
  if (e.rootId === e.id) return undefined
  for (let i = earlier.length - 1; i >= 0; i--) {
    const p = earlier[i]
    if (p.rootId === e.rootId && (p.agentId ?? p.node) !== (e.agentId ?? e.node)) return p.id
  }
  return undefined
}

function feedWake(w: WakeRecord, node: string, now: number): FeedWake {
  const out: FeedWake = { agentId: w.agentId, node, status: w.status, decidedAt: w.decidedAt, attempts: w.attempts }
  if (w.reason) out.reason = w.reason
  if (w.startedAt) out.startedAt = w.startedAt
  if (w.endedAt) out.endedAt = w.endedAt
  if (w.taskId) out.taskId = w.taskId
  if (w.error) out.error = w.error
  if (w.status !== "skipped") {
    const until = w.startedAt ?? w.endedAt ?? now
    out.waitedMs = Math.max(0, until - w.decidedAt)
  }
  return out
}
