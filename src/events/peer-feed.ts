import type { TypedEventBus } from "./bus"
import { newEventId, type EventEnvelope } from "./envelope"
import { FeedIdleError, FeedUnsupportedError, httpFeedTransport, type FeedTransport } from "./feed-transport"

// --- Mesh peer event feed (#166) ---
//
// Each node follows the live envelope stream of every healthy mesh peer and
// takes those envelopes into its own bus with the peer's `node` intact.
// Nothing is pushed to all nodes and nothing is re-broadcast: the follower
// asks each peer for `origin=local`, so it hears only what that peer
// published itself (feed-http.ts), and the bus refuses an envelope that
// claims to come from this node or that it has already taken in.
//
// Per peer, one loop:
//   1. open the live stream,
//   2. read the peer's ring buffer after the last event seen from it
//      (or a short backfill on first contact); report a gap when that
//      event has already left the peer's buffer,
//   3. take in the live stream until it ends, then reconnect with
//      exponential backoff.
//
// A peer that can't be reached is published as a `mesh` event on each
// change (`feed:down`, `feed:up`), so "quiet" and "down" look different.
// First contact that succeeds is not news and publishes nothing.
//
// Only real failures count as down: a refused or failed connect, an error
// answer, a broken stream. A stream that went quiet past the idle limit
// is reconnected without a word, and a peer running an AgentX without
// the feed (mid rolling upgrade) is left alone quietly and retried every
// `unsupportedRetryMs`; neither publishes anything.

export interface FeedPeerInfo {
  name: string
  url: string
  healthy: boolean
  headers: Record<string, string>
}

export interface PeerFeedOptions {
  bus: TypedEventBus
  /** Current mesh roster, read on every reconcile (peers join and leave). */
  peers: () => FeedPeerInfo[]
  /** Event types the peer should leave out, for example task:step. */
  skipTypes?: () => string[]
  /** Checked on every reconcile; false stops every link. */
  enabled?: () => boolean
  transport?: FeedTransport
  log?: (msg: string) => void
  backoff?: { minMs: number; maxMs: number }
  reconcileMs?: number
  /** Events read from a peer's buffer on first contact. */
  backfill?: number
  /** How often to look again at a peer that has no feed. */
  unsupportedRetryMs?: number
  /** A session shorter than this that ends cleanly still grows the
   *  backoff, so a proxy that drops every stream at once can't make the
   *  follower reconnect every second. */
  shortSessionMs?: number
}

/** Most events one catch-up read takes. More missed than this is a gap. */
export const CATCHUP_LIMIT = 500

interface PeerLink {
  abort: AbortController
  delay: number
}

interface PeerCursor {
  lastId?: string
  /** undefined until the first attempt settles. */
  up?: boolean
  /** The peer answered without a feed (older AgentX). */
  unsupported?: boolean
  /** The node name the peer's events carry, pinned at first sight. */
  node?: string
  /** Set once a mismatch has been logged, so the log isn't flooded. */
  warned?: boolean
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const t = setTimeout(done, ms)
  function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve() }
  signal.addEventListener("abort", done)
})

export class MeshFeedFollower {
  private links = new Map<string, PeerLink>()
  private cursors = new Map<string, PeerCursor>()
  private timer?: ReturnType<typeof setInterval>
  private transport: FeedTransport
  private minMs: number
  private maxMs: number

  constructor(private opts: PeerFeedOptions) {
    this.transport = opts.transport ?? httpFeedTransport()
    this.minMs = opts.backoff?.minMs ?? 1000
    this.maxMs = opts.backoff?.maxMs ?? 60_000
  }

  start(): this {
    this.reconcile()
    this.timer = setInterval(() => this.reconcile(), this.opts.reconcileMs ?? 5000)
    this.timer.unref?.()
    return this
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const link of this.links.values()) link.abort.abort()
    this.links.clear()
  }

  /** Peers currently followed, whether each is reachable, and whether it
   *  has a feed at all. */
  status(): Array<{ peer: string; up?: boolean; unsupported?: boolean; lastId?: string }> {
    return [...this.cursors].map(([peer, c]) => ({ peer, up: c.up, unsupported: c.unsupported, lastId: c.lastId }))
  }

  /** Start a loop for each new peer and stop the loops of peers that left. */
  reconcile(): void {
    const on = this.opts.enabled ? this.opts.enabled() : true
    const names = new Set(on ? this.opts.peers().map((p) => p.name) : [])
    for (const [name, link] of this.links) {
      if (!names.has(name)) { link.abort.abort(); this.links.delete(name); this.cursors.delete(name) }
    }
    for (const name of names) {
      if (this.links.has(name)) continue
      const link: PeerLink = { abort: new AbortController(), delay: this.minMs }
      this.links.set(name, link)
      void this.follow(name, link).finally(() => {
        if (this.links.get(name) === link) this.links.delete(name)
      })
    }
  }

  private cursor(name: string): PeerCursor {
    let c = this.cursors.get(name)
    if (!c) { c = {}; this.cursors.set(name, c) }
    return c
  }

  private async follow(name: string, link: PeerLink): Promise<void> {
    const signal = link.abort.signal
    while (!signal.aborted) {
      const peer = this.opts.peers().find((p) => p.name === name)
      if (!peer) return
      const c = this.cursor(name)
      if (c.unsupported && !peer.healthy) {
        // Nothing to follow and nothing to report: the mesh's own health
        // events already say this peer is down.
        await sleep(this.opts.unsupportedRetryMs ?? 600_000, signal)
        continue
      }
      if (!peer.healthy) {
        this.mark(name, false, "its health check is failing")
      } else {
        const began = Date.now()
        try {
          await this.session(peer, link, signal)
          await this.afterCleanEnd(link, began, signal)
          continue
        } catch (err: any) {
          if (signal.aborted) return
          if (err instanceof FeedUnsupportedError) {
            this.unsupported(name, err.message)
            await sleep(this.opts.unsupportedRetryMs ?? 600_000, signal)
            continue
          }
          if (err instanceof FeedIdleError) {
            // The peer answered correctly and then went quiet: reconnect.
            await this.afterCleanEnd(link, began, signal)
            continue
          }
          this.mark(name, false, err?.message || String(err))
        }
      }
      await sleep(link.delay, signal)
      link.delay = Math.min(link.delay * 2, this.maxMs)
    }
  }

  /** Wait before reconnecting after a stream ended without an error. A
   *  long session resets the backoff; a short one keeps growing it. */
  private async afterCleanEnd(link: PeerLink, began: number, signal: AbortSignal): Promise<void> {
    if (Date.now() - began >= (this.opts.shortSessionMs ?? 10_000)) link.delay = this.minMs
    await sleep(link.delay, signal)
    link.delay = Math.min(link.delay * 2, this.maxMs)
  }

  /** Note once that a peer has no feed. Its reachability state is dropped,
   *  so a later upgrade is a quiet first contact, not "reachable again". */
  private unsupported(peer: string, reason: string): void {
    const c = this.cursor(peer)
    if (c.unsupported) return
    c.unsupported = true
    c.up = undefined
    this.opts.log?.(`[feed] peer ${peer} not followed: ${reason}; looking again later`)
  }

  private async session(peer: FeedPeerInfo, link: PeerLink, signal: AbortSignal): Promise<void> {
    const skip = this.opts.skipTypes?.() ?? []
    const base = new URLSearchParams({ origin: "local" })
    if (skip.length) base.set("skip", skip.join(","))
    const stream = await this.transport.open(peer, base.toString(), signal)
    const c = this.cursor(peer.name)
    c.unsupported = false

    // Catch up before reading the live stream, so events arrive in order;
    // the stream buffers meanwhile, and ingest() drops any overlap.
    const since = c.lastId
    const limit = since ? CATCHUP_LIMIT : (this.opts.backfill ?? 100)
    const q = new URLSearchParams(base)
    if (since) q.set("since", since)
    q.set("limit", String(limit))
    const recent = await this.transport.recent(peer, q.toString(), signal)
    this.mark(peer.name, true)
    link.delay = this.minMs
    const events = recent.events.slice(-limit)
    if (since && (recent.gap || events.length >= CATCHUP_LIMIT)) {
      this.publish("feed:gap", `events from peer ${peer.name} may have been missed while it was out of reach`)
    }
    for (const e of events) this.take(peer.name, e)
    for await (const e of stream) {
      if (signal.aborted) return
      this.take(peer.name, e)
    }
  }

  /** Take one envelope from a peer. A link is pinned to the node name its
   *  first event carries, so a peer can't speak for a third node; an event
   *  under this node's own name means two nodes share a name. */
  private take(peer: string, e: EventEnvelope): void {
    const c = this.cursor(peer)
    c.lastId = e.id
    const own = e.node === this.opts.bus.nodeName
    if (!own) c.node ??= e.node
    if (own || e.node !== c.node) {
      if (!c.warned) {
        c.warned = true
        this.opts.log?.(own
          ? `[feed] peer ${peer} sends events named "${e.node}", this node's own name; give each node its own node.name`
          : `[feed] peer ${peer} sent an event as "${e.node}" after "${c.node}"; ignoring events under other names`)
      }
      return
    }
    this.opts.bus.ingest(e)
  }

  /** Publish a reachability change. Repeats of the same state are silent. */
  private mark(peer: string, up: boolean, reason = ""): void {
    const c = this.cursor(peer)
    if (c.up === up) return
    const first = c.up === undefined
    c.up = up
    if (up && first) return
    this.opts.log?.(`[feed] peer ${peer} ${up ? "reachable again" : `unreachable: ${reason}`}`)
    this.publish(up ? "feed:up" : "feed:down", up ? `peer ${peer} reachable again` : `peer ${peer} unreachable: ${reason}`)
  }

  /** A status event of this node's own, never tied to whatever root the
   *  caller happens to run under. */
  private publish(type: string, summary: string): void {
    const id = newEventId()
    this.opts.bus.publish({ id, rootId: id, kind: "mesh", type, summary })
  }
}
