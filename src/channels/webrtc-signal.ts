import type { ServerResponse } from "http"

// --- WebRTC signal broker ---
//
// AgentX itself never carries audio/video frames. This broker only relays the
// control-plane messages (SDP offer/answer + ICE candidates + hangup) between a
// local browser and a remote peer's browser — the media connection is negotiated
// directly between the two browsers via WebRTC (SRTP over UDP).
//
// Flow:
//   Alice's browser -- SSE + POST --> agentx-A -- HTTP /webrtc/signal --> agentx-B -- SSE --> Bob's browser
//
// Subscribers index by (callId, recipient). A call is two-sided so there are
// typically two subscribers per callId: one on each daemon.

export type WebRtcSignalKind = "offer" | "answer" | "ice" | "hangup" | "ring"

export interface WebRtcSignal {
  kind: WebRtcSignalKind
  callId: string
  /** Agent/peer name the signal is FROM (which daemon sent it). */
  from: string
  /** Agent/peer name the signal is FOR (which local subscriber should receive). */
  to: string
  /** SDP blob for offer/answer. */
  sdp?: string
  /** ICE candidate payload. */
  candidate?: {
    candidate: string
    sdpMid: string | null
    sdpMLineIndex: number | null
    usernameFragment?: string | null
  }
  /** Optional short reason for hangup/ring. */
  reason?: string
}

/** A subscriber may be either an SSE-backed browser (we write the raw event
 *  stream into its ServerResponse) OR an in-process consumer like the
 *  WebRtcBot (we just call its callback). One Set, two delivery shapes. */
type SubscriberSink =
  | { kind: "sse"; res: ServerResponse }
  | { kind: "callback"; deliver: (signal: WebRtcSignal) => void }

interface Subscriber {
  callId: string
  recipient: string
  sink: SubscriberSink
}

interface BufferedSignal {
  signal: WebRtcSignal
  expiresAt: number
}

/** How long (ms) to hold a signal that arrived with no matching subscriber.
 *  30s comfortably covers the "caller offered before callee joined" race
 *  without keeping stale ICE around long enough to confuse a later call. */
const BUFFER_TTL_MS = 30_000

export interface WebRtcSignalForwarder {
  /** POST the signal to the named mesh peer's /webrtc/signal endpoint.
   *  Returns true on 2xx. */
  (peerName: string, signal: WebRtcSignal): Promise<boolean>
}

export interface RingHandler {
  /** Invoked when a ring signal arrives from a remote peer. The broker
   *  dedups by callId so this fires at most once per call over a short TTL. */
  (signal: WebRtcSignal): void | Promise<void>
}

/** Dedup window for ring notifications. A single call shouldn't ping the
 *  callee's channels twice, but two distinct calls on the same day must
 *  each notify. Five minutes comfortably covers retry-after-missed-call
 *  without muting legitimate repeat dials. */
const RING_DEDUP_TTL_MS = 5 * 60_000

/** Normalize a peer/node name for tolerant matching: lowercase and strip any
 *  non-alphanumeric characters. This papers over the fact that a node's
 *  self-reported `node.name` and the name other peers use for it in their
 *  `mesh.peers[].name` list frequently disagree on case, spaces, or hyphens
 *  ("MacBook-Local" vs "macbook-local" vs "macbook_local"). Signaling is
 *  looser than agent dispatch because a single call is a tight two-party
 *  negotiation where ambiguity is vanishingly unlikely. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export class WebRtcSignalBroker {
  private subs: Set<Subscriber> = new Set()
  private log: (...args: unknown[]) => void
  private forwarder?: WebRtcSignalForwarder
  /** Local peer/agent name — used when a browser client identifies as "us". */
  private localName: string
  /** Peer names allowed to initiate *inbound* calls. Empty means allow all.
   *  Stored pre-normalized so every comparison is apples-to-apples. */
  private allowedCallers: Set<string>
  /** Signals that arrived before their matching subscriber showed up.
   *  Keyed by `${callId}|${normalizedRecipient}`; flushed on subscribe. */
  private pending: Map<string, BufferedSignal[]> = new Map()
  private cleanupTimer?: ReturnType<typeof setInterval>
  /** Ring notification callback (set by daemon wiring). */
  private ringHandler?: RingHandler
  /** Recent ring callIds, for dedup. Value is the expiry timestamp. */
  private recentRings: Map<string, number> = new Map()

  constructor(
    localName: string,
    allowedCallers: string[] = [],
    log: (...args: unknown[]) => void = console.error.bind(console, "[webrtc]"),
  ) {
    this.localName = localName
    this.allowedCallers = new Set(allowedCallers.map(normalizeName))
    this.log = log
    // Sweep expired buffered signals every 10s.
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 10_000)
  }

  private pendingKey(callId: string, recipient: string): string {
    return `${callId}|${normalizeName(recipient)}`
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const [key, bucket] of this.pending) {
      const kept = bucket.filter(b => b.expiresAt > now)
      if (kept.length === 0) this.pending.delete(key)
      else if (kept.length !== bucket.length) this.pending.set(key, kept)
    }
    for (const [callId, expiry] of this.recentRings) {
      if (expiry <= now) this.recentRings.delete(callId)
    }
  }

  setForwarder(fn: WebRtcSignalForwarder): void {
    this.forwarder = fn
  }

  setRingHandler(fn: RingHandler): void {
    this.ringHandler = fn
  }

  /** Register an SSE subscriber (a browser tab). Returns an unsubscribe fn. */
  subscribe(callId: string, recipient: string, res: ServerResponse): () => void {
    return this.addSubscriber(callId, recipient, { kind: "sse", res })
  }

  /** Register an in-process subscriber (a server-side bot). The callback fires
   *  for every signal addressed to `recipient` on `callId`. Returns unsubscribe. */
  subscribeInternal(callId: string, recipient: string, deliver: (signal: WebRtcSignal) => void): () => void {
    return this.addSubscriber(callId, recipient, { kind: "callback", deliver })
  }

  private addSubscriber(callId: string, recipient: string, sink: SubscriberSink): () => void {
    const sub: Subscriber = { callId, recipient, sink }
    this.subs.add(sub)
    const tag = sink.kind === "sse" ? "sse" : "internal"
    this.log(`subscribe[${tag}] call=${callId} as=${recipient} (${this.subs.size} total)`)

    // Flush any signals that arrived before this subscriber. Common race: the
    // caller offers before the callee opens its page, or SSE connects slightly
    // after the POST that sent the offer.
    const key = this.pendingKey(callId, recipient)
    const buffered = this.pending.get(key)
    if (buffered && buffered.length) {
      const now = Date.now()
      const fresh = buffered.filter(b => b.expiresAt > now)
      for (const { signal } of fresh) {
        this.deliverTo(sub, signal)
      }
      this.pending.delete(key)
      if (fresh.length) this.log(`flushed ${fresh.length} buffered signal(s) to new subscriber call=${callId} as=${recipient}`)
    }

    return () => {
      this.subs.delete(sub)
      this.log(`unsubscribe[${tag}] call=${callId} as=${recipient} (${this.subs.size} remaining)`)
    }
  }

  /** Deliver a single signal to a subscriber, regardless of sink kind.
   *  Returns false if the sink looks dead (caller should drop the sub). */
  private deliverTo(sub: Subscriber, signal: WebRtcSignal): boolean {
    try {
      if (sub.sink.kind === "sse") {
        sub.sink.res.write(`event: signal\ndata: ${JSON.stringify(signal)}\n\n`)
      } else {
        sub.sink.deliver(signal)
      }
      return true
    } catch {
      return false
    }
  }

  /** Called when a browser POSTs a signal. Routes locally if the target is
   *  this node OR matches a local in-process subscriber (e.g. the AI bot
   *  peer); otherwise forwards through the mesh. */
  async handleOutgoing(signal: WebRtcSignal): Promise<{ ok: boolean; error?: string }> {
    // Local fan-out: addressed to ourselves (loopback) OR addressed to a
    // peer we're hosting in-process (the bot subscribes via callback, not via
    // mesh — its name like "bot:atlas" isn't in mesh.peers[]).
    const wantRecipient = normalizeName(signal.to)
    const hasLocalSub = wantRecipient === normalizeName(this.localName) || this.hasSubscriberFor(signal.callId, wantRecipient)
    if (hasLocalSub) {
      this.fanOut(signal)
      return { ok: true }
    }
    if (!this.forwarder) {
      return { ok: false, error: "mesh forwarder not wired" }
    }
    const ok = await this.forwarder(signal.to, signal)
    return ok ? { ok } : { ok: false, error: `forward to "${signal.to}" failed` }
  }

  private hasSubscriberFor(callId: string, normalizedRecipient: string): boolean {
    for (const sub of this.subs) {
      if (sub.callId === callId && normalizeName(sub.recipient) === normalizedRecipient) return true
    }
    return false
  }

  /** Called when the daemon receives a signal from a remote peer via /webrtc/signal. */
  handleIncoming(signal: WebRtcSignal): { ok: boolean; error?: string } {
    // Enforce allowedCallers on the *first* signal of a call (offer or ring).
    // Answers/ICE/hangup for an already-established call go through — the
    // authoritative gate is the offer.
    if ((signal.kind === "offer" || signal.kind === "ring") && this.allowedCallers.size > 0) {
      if (!this.allowedCallers.has(normalizeName(signal.from))) {
        this.log(`reject inbound ${signal.kind} from "${signal.from}": not in allowedCallers`)
        return { ok: false, error: "caller not allowed" }
      }
    }

    // Rings are purely for out-of-band notification — don't fan out over SSE
    // or buffer (they'd be noise on the callee's page). Dedup by callId so
    // the same call only pings the callee's channels once.
    if (signal.kind === "ring") {
      const now = Date.now()
      const expiry = this.recentRings.get(signal.callId)
      if (expiry && expiry > now) {
        this.log(`dedup ring for call=${signal.callId} (already notified)`)
        return { ok: true }
      }
      this.recentRings.set(signal.callId, now + RING_DEDUP_TTL_MS)
      if (this.ringHandler) {
        try { void this.ringHandler(signal) }
        catch (e: any) { this.log(`ringHandler threw: ${e.message}`) }
      } else {
        this.log(`ring received for call=${signal.callId} but no handler wired`)
      }
      return { ok: true }
    }

    const delivered = this.fanOut(signal)
    if (delivered === 0) {
      // Callee's page isn't up yet. Buffer the signal so the subscribe() call
      // that lands within BUFFER_TTL_MS replays it. Keeps the flow robust to
      // normal race conditions (SSE reconnects, slow first paint) without
      // forcing the caller to implement retry.
      const key = this.pendingKey(signal.callId, signal.to)
      const bucket = this.pending.get(key) || []
      bucket.push({ signal, expiresAt: Date.now() + BUFFER_TTL_MS })
      this.pending.set(key, bucket)
      this.log(`buffered ${signal.kind} for call=${signal.callId} to=${signal.to} (no subscriber yet, ${bucket.length} pending)`)
    }
    return { ok: true }
  }

  private fanOut(signal: WebRtcSignal): number {
    let delivered = 0
    const wantRecipient = normalizeName(signal.to)
    for (const sub of this.subs) {
      if (sub.callId !== signal.callId) continue
      if (normalizeName(sub.recipient) !== wantRecipient) continue
      if (this.deliverTo(sub, signal)) delivered++
      else this.subs.delete(sub)
    }
    return delivered
  }

  /** Active subscriber count — for /mesh or admin diagnostics. */
  get subscriberCount(): number {
    return this.subs.size
  }

  /** Close every open SSE stream (daemon shutdown). Internal subscribers
   *  are simply dropped — they're owned by the bot manager which has its own
   *  shutdown path. */
  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    for (const sub of this.subs) {
      if (sub.sink.kind === "sse") {
        try { sub.sink.res.end() } catch { /* already closed */ }
      }
    }
    this.subs.clear()
    this.pending.clear()
  }
}
