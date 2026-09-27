import type { EventEnvelope } from "./envelope"
import { FEED_HEARTBEAT_MS, type RecentFeed } from "./feed-http"

// --- Mesh feed transport ---
//
// The client half of the envelope feed (see feed-http.ts): open a peer's
// live stream, and read its ring buffer for catch-up. Separate from the
// follower so tests can run it against in-process servers, and so the
// follower's reconnect logic never touches fetch directly.

export interface FeedPeer {
  name: string
  url: string
  headers: Record<string, string>
}

export interface FeedTransport {
  /** Resolves once the stream is open (headers received). Iterating the
   *  result yields envelopes until the stream ends or fails. */
  open(peer: FeedPeer, query: string, signal: AbortSignal): Promise<AsyncIterable<EventEnvelope>>
  recent(peer: FeedPeer, query: string, signal: AbortSignal): Promise<RecentFeed>
}

const MAX_ID = 200

/** A peer's frame as an envelope, or null when it isn't one. The peer is
 *  trusted for mesh work, but a malformed frame must not reach the bus. */
export function toEnvelope(raw: unknown): EventEnvelope | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const str = (k: string) => typeof r[k] === "string" && (r[k] as string).length > 0
  if (!str("id") || !str("node") || !str("kind") || !str("type") || !str("at")) return null
  if ((r.id as string).length > MAX_ID || (r.node as string).length > MAX_ID) return null
  const e: EventEnvelope = {
    id: r.id as string,
    rootId: str("rootId") ? String(r.rootId).slice(0, MAX_ID) : (r.id as string),
    node: r.node as string,
    kind: String(r.kind).slice(0, 40),
    type: String(r.type).slice(0, 80),
    at: r.at as string,
    summary: typeof r.summary === "string" ? r.summary : "",
  }
  if (str("parentId")) e.parentId = String(r.parentId).slice(0, MAX_ID)
  if (str("agentId")) e.agentId = String(r.agentId).slice(0, MAX_ID)
  if (str("ref")) e.ref = String(r.ref).slice(0, MAX_ID)
  return e
}

/** Split an SSE byte stream into `event: envelope` payloads. Other event
 *  names are ignored, so an older peer that answers with its legacy
 *  stream contributes nothing rather than garbage. */
export async function* envelopeFrames(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<EventEnvelope> {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of chunks) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n")
    let idx: number
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let name = "message"
      const data: string[] = []
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
      if (name !== "envelope" || data.length === 0) continue
      try {
        const e = toEnvelope(JSON.parse(data.join("\n")))
        if (e) yield e
      } catch { /* skip a malformed frame */ }
    }
  }
}

/** Yield the chunks of `body`, failing when none arrives for `idleMs`. The
 *  server sends a heartbeat comment every FEED_HEARTBEAT_MS, so silence
 *  means a dead connection that TCP has not noticed yet. */
async function* withIdleTimeout(body: ReadableStream<Uint8Array>, idleMs: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no data for ${idleMs}ms`)), idleMs)
      })
      try {
        const { done, value } = await Promise.race([reader.read(), idle])
        if (done) return
        if (value) yield value
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

export function httpFeedTransport(opts: { idleMs?: number; fetchImpl?: typeof fetch } = {}): FeedTransport {
  const idleMs = opts.idleMs ?? FEED_HEARTBEAT_MS * 3
  const doFetch = opts.fetchImpl ?? fetch
  const base = (p: FeedPeer) => p.url.replace(/\/+$/, "")
  return {
    async open(peer, query, signal) {
      const r = await doFetch(`${base(peer)}/events?format=envelope${query ? `&${query}` : ""}`, {
        headers: { ...peer.headers, Accept: "text/event-stream" },
        signal,
      })
      if (!r.ok || !r.body) {
        await r.body?.cancel().catch(() => {})
        throw new Error(`feed stream answered ${r.status}`)
      }
      return envelopeFrames(withIdleTimeout(r.body, idleMs))
    },
    async recent(peer, query, signal) {
      const r = await doFetch(`${base(peer)}/events/recent${query ? `?${query}` : ""}`, { headers: peer.headers, signal })
      // A peer older than the event buffer has nothing to catch up from;
      // its live stream still counts.
      if (r.status === 404) { await r.body?.cancel().catch(() => {}); return { events: [] } }
      if (!r.ok) throw new Error(`feed catch-up answered ${r.status}`)
      const body = await r.json() as { events?: unknown[]; gap?: boolean }
      const events = (Array.isArray(body.events) ? body.events : []).map(toEnvelope).filter((e): e is EventEnvelope => !!e)
      return body.gap ? { events, gap: true } : { events }
    },
  }
}
