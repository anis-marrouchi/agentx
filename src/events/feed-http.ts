import type { IncomingMessage, ServerResponse } from "http"
import type { TypedEventBus } from "./bus"
import type { EventEnvelope } from "./envelope"

// --- Envelope feed over HTTP ---
//
// The server half of the mesh event feed (#166). A peer's follower reads
// this node's envelopes through two routes:
//
//   GET /events?format=envelope   live stream, one `event: envelope` frame
//                                 per envelope
//   GET /events/recent            the ring buffer, for catch-up
//
// Both take the same filter. `origin=local` keeps only envelopes this node
// published itself. Followers always ask for it, so an event that reached
// this node from a peer is never served on to another peer: in a triangle
// A-B-C, A hears B's events from B only, never again through C.

export interface FeedQuery {
  /** "local": only envelopes this node published. */
  origin?: "local"
  /** Only these kinds (comma list on the wire). */
  kinds?: string[]
  /** Drop these types (comma list on the wire), for example task:step. */
  skipTypes?: string[]
  agent?: string
}

function list(raw: string | null): string[] | undefined {
  const parts = (raw || "").split(",").map((s) => s.trim()).filter(Boolean)
  return parts.length ? parts : undefined
}

export function parseFeedQuery(q: URLSearchParams): FeedQuery {
  return {
    origin: q.get("origin") === "local" ? "local" : undefined,
    kinds: list(q.get("kind")),
    skipTypes: list(q.get("skip")),
    agent: q.get("agent") || undefined,
  }
}

export function feedMatches(q: FeedQuery, e: EventEnvelope, localNode: string): boolean {
  if (q.origin === "local" && e.node !== localNode) return false
  if (q.kinds && !q.kinds.includes(e.kind)) return false
  if (q.skipTypes && q.skipTypes.includes(e.type)) return false
  if (q.agent && e.agentId !== q.agent) return false
  return true
}

export interface RecentFeed {
  events: EventEnvelope[]
  /** Set when `since` was an event id this node no longer holds: older
   *  events may be missing, and `events` starts at the oldest it has. */
  gap?: true
}

/** Answer for GET /events/recent. `since` is an event id or an ISO time. */
export function recentFeed(bus: TypedEventBus, q: URLSearchParams): RecentFeed {
  const since = q.get("since") || undefined
  const filter = parseFeedQuery(q)
  const limit = parseInt(q.get("limit") || "", 10)
  const node = bus.nodeName
  let events = bus.recent({ since }).filter((e) => feedMatches(filter, e, node))
  if (Number.isFinite(limit) && limit > 0) events = events.slice(-limit)
  const lost = !!since && Number.isNaN(Date.parse(since)) && !bus.hasRecent(since)
  return lost ? { events, gap: true } : { events }
}

/** Response header that marks a real envelope stream. A peer without the
 *  feed ignores `format=envelope` and answers with its legacy /events
 *  stream, which lacks it; followers use its absence to tell "this peer
 *  has no feed" from "this peer is down". */
export const FEED_HEADER = "x-agentx-feed"

/** How often an idle envelope stream sends a comment line. Followers treat
 *  a stream silent for three of these as dead. */
export const FEED_HEARTBEAT_MS = 15_000

/** Serve GET /events?format=envelope. The caller has already checked auth. */
export function streamEnvelopes(
  bus: TypedEventBus, req: IncomingMessage, res: ServerResponse, q: URLSearchParams,
  opts: { heartbeatMs?: number } = {},
): void {
  const filter = parseFeedQuery(q)
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    [FEED_HEADER]: "1",
  })
  // An opening comment flushes the headers, so the follower knows the
  // stream is up before the first event arrives.
  res.write(`: feed ${bus.nodeName}\n\n`)
  const stop = bus.subscribe((e) => {
    if (!feedMatches(filter, e, bus.nodeName)) return
    try { res.write(`event: envelope\ndata: ${JSON.stringify(e)}\n\n`) } catch { /* closed below */ }
  })
  const beat = setInterval(() => { try { res.write(": ping\n\n") } catch { /* closed below */ } }, opts.heartbeatMs ?? FEED_HEARTBEAT_MS)
  beat.unref?.()
  const close = () => { stop(); clearInterval(beat) }
  req.on("close", close)
  res.on("close", close)
}
