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

interface Subscriber {
  callId: string
  recipient: string
  res: ServerResponse
}

export interface WebRtcSignalForwarder {
  /** POST the signal to the named mesh peer's /webrtc/signal endpoint.
   *  Returns true on 2xx. */
  (peerName: string, signal: WebRtcSignal): Promise<boolean>
}

export class WebRtcSignalBroker {
  private subs: Set<Subscriber> = new Set()
  private log: (...args: unknown[]) => void
  private forwarder?: WebRtcSignalForwarder
  /** Local peer/agent name — used when a browser client identifies as "us". */
  private localName: string
  /** Peer names allowed to initiate *inbound* calls. Empty means allow all. */
  private allowedCallers: Set<string>

  constructor(
    localName: string,
    allowedCallers: string[] = [],
    log: (...args: unknown[]) => void = console.error.bind(console, "[webrtc]"),
  ) {
    this.localName = localName
    this.allowedCallers = new Set(allowedCallers)
    this.log = log
  }

  setForwarder(fn: WebRtcSignalForwarder): void {
    this.forwarder = fn
  }

  /** Register an SSE subscriber. Returns an unsubscribe fn. */
  subscribe(callId: string, recipient: string, res: ServerResponse): () => void {
    const sub: Subscriber = { callId, recipient, res }
    this.subs.add(sub)
    this.log(`subscribe call=${callId} as=${recipient} (${this.subs.size} total)`)
    return () => {
      this.subs.delete(sub)
      this.log(`unsubscribe call=${callId} as=${recipient} (${this.subs.size} remaining)`)
    }
  }

  /** Called when a browser POSTs a signal. Forwards to the remote peer by name. */
  async handleOutgoing(signal: WebRtcSignal): Promise<{ ok: boolean; error?: string }> {
    if (!this.forwarder) {
      return { ok: false, error: "mesh forwarder not wired" }
    }
    // If the signal is addressed to ourselves (loopback / same-node test),
    // fan it out locally instead of bouncing through the mesh.
    if (signal.to === this.localName) {
      this.fanOut(signal)
      return { ok: true }
    }
    const ok = await this.forwarder(signal.to, signal)
    return ok ? { ok } : { ok: false, error: `forward to "${signal.to}" failed` }
  }

  /** Called when the daemon receives a signal from a remote peer via /webrtc/signal. */
  handleIncoming(signal: WebRtcSignal): { ok: boolean; error?: string } {
    // Enforce allowedCallers on the *first* signal of a call (offer or ring).
    // Answers/ICE/hangup for an already-established call go through — the
    // authoritative gate is the offer.
    if ((signal.kind === "offer" || signal.kind === "ring") && this.allowedCallers.size > 0) {
      if (!this.allowedCallers.has(signal.from)) {
        this.log(`reject inbound ${signal.kind} from "${signal.from}": not in allowedCallers`)
        return { ok: false, error: "caller not allowed" }
      }
    }
    const delivered = this.fanOut(signal)
    if (delivered === 0) {
      // Not an error per se — the callee just hasn't opened their page yet.
      // We drop the signal; the caller will retry via trickle ICE or timeout.
      this.log(`no subscriber for call=${signal.callId} to=${signal.to} kind=${signal.kind}`)
    }
    return { ok: true }
  }

  private fanOut(signal: WebRtcSignal): number {
    let delivered = 0
    const payload = `event: signal\ndata: ${JSON.stringify(signal)}\n\n`
    for (const sub of this.subs) {
      if (sub.callId !== signal.callId) continue
      if (sub.recipient !== signal.to) continue
      try {
        sub.res.write(payload)
        delivered++
      } catch {
        this.subs.delete(sub)
      }
    }
    return delivered
  }

  /** Active subscriber count — for /mesh or admin diagnostics. */
  get subscriberCount(): number {
    return this.subs.size
  }

  /** Close every open SSE stream (daemon shutdown). */
  shutdown(): void {
    for (const sub of this.subs) {
      try { sub.res.end() } catch { /* already closed */ }
    }
    this.subs.clear()
  }
}
