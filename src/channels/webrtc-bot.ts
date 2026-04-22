import wrtcPkg from "@roamhq/wrtc"
import type { WebRtcSignalBroker, WebRtcSignal } from "./webrtc-signal"

// --- Server-side WebRTC bot peer ---
//
// Joins a call as a third participant by running RTCPeerConnection on the
// daemon side via @roamhq/wrtc (libwebrtc Node bindings). Same wire protocol
// as a browser tab — same offer/answer/ICE/hangup signal kinds, same
// deterministic-caller role, same mesh routing. The difference is that
// instead of subscribing to /webrtc/events over SSE the bot uses the
// in-process broker.subscribeInternal callback, and instead of POSTing to
// /webrtc/signal/out it calls broker.handleOutgoing directly.
//
// v1 scope: receive-only audio. The bot does not produce media — it adds an
// audio receiver via setLocalDescription/createOffer with offerToReceiveAudio,
// and consumes inbound audio frames through RTCAudioSink (PCM Int16Array).

const { RTCPeerConnection, nonstandard } = wrtcPkg as any
const { RTCAudioSink } = nonstandard as { RTCAudioSink: any }

export interface AudioFrame {
  /** Interleaved (or mono) signed 16-bit PCM samples. */
  samples: Int16Array
  sampleRate: number
  channelCount: number
  /** Timestamp (ms since epoch) when the frame was received. */
  receivedAt: number
}

export interface WebRtcBotOptions {
  callId: string
  /** Name we identify ourselves as. Convention: `bot:<agentId>`. Used in
   *  signals' `from` field, in subscriber registration, and for the
   *  deterministic caller comparison. */
  botName: string
  /** Primary human peer to negotiate with. If a call has two humans and one
   *  bot, the bot only connects to the inviting browser in v1. */
  target: string
  iceServers: RTCIceServer[]
  broker: WebRtcSignalBroker
  log: (...args: unknown[]) => void
  /** Fired for each remote audio buffer. Bot consumes only — no echo back. */
  onAudioFrame: (frame: AudioFrame) => void
  /** Fired when the remote ends the call (hangup signal received) or when
   *  the connection enters a terminal state. Idempotent. */
  onClosed?: (reason: string) => void
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

export class WebRtcBot {
  private pc?: any  // RTCPeerConnection from @roamhq/wrtc — lib types disagree with DOM lib
  private sinks: Set<{ stop: () => void }> = new Set()
  private unsubscribe?: () => void
  private closed = false
  private opts: WebRtcBotOptions

  constructor(opts: WebRtcBotOptions) {
    this.opts = opts
  }

  /** Open a peer connection, register as an in-process subscriber, and
   *  initiate the offer if our deterministic-caller role says we should. */
  async start(): Promise<void> {
    if (this.pc) throw new Error("WebRtcBot already started")
    const { broker, callId, botName, target, iceServers, log } = this.opts

    this.pc = new RTCPeerConnection({ iceServers })

    this.pc.ontrack = (ev: any) => {
      if (this.closed) return
      const track = ev.track
      if (track.kind !== "audio") {
        log(`[bot:${botName}] non-audio track received (kind=${track.kind}) — ignored in v1`)
        return
      }
      log(`[bot:${botName}] audio track received from ${target}`)
      this.tapAudio(track)
    }

    this.pc.onicecandidate = (ev: any) => {
      if (!ev.candidate || this.closed) return
      void this.send({
        kind: "ice",
        callId, from: botName, to: target,
        candidate: {
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          usernameFragment: ev.candidate.usernameFragment,
        },
      })
    }

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState
      log(`[bot:${botName}] pc state: ${s}`)
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this.close(`pc state ${s}`)
      }
    }

    // Register as an in-process subscriber so signals flow back without HTTP.
    this.unsubscribe = broker.subscribeInternal(callId, botName, (sig) => this.handleSignal(sig))

    // Tell the human we're calling them so any channel-side ring fires.
    await this.send({ kind: "ring", callId, from: botName, to: target })

    // Deterministic caller role: smaller normalized name offers.
    const isCaller = norm(botName) < norm(target)
    if (isCaller) {
      // We need to RECEIVE audio from the human; make the receiver explicit.
      // @roamhq/wrtc honors createOffer({ offerToReceiveAudio: true }).
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false })
      await this.pc.setLocalDescription(offer)
      await this.send({ kind: "offer", callId, from: botName, to: target, sdp: offer.sdp })
      log(`[bot:${botName}] role=caller, offer sent to ${target}`)
    } else {
      log(`[bot:${botName}] role=callee, waiting for offer from ${target}`)
    }
  }

  private async send(signal: WebRtcSignal): Promise<void> {
    const result = await this.opts.broker.handleOutgoing(signal)
    if (!result.ok) {
      this.opts.log(`[bot:${this.opts.botName}] send ${signal.kind} -> ${signal.to} failed: ${result.error}`)
    }
  }

  private async handleSignal(sig: WebRtcSignal): Promise<void> {
    if (this.closed || !this.pc) return
    if (sig.callId !== this.opts.callId) return
    try {
      if (sig.kind === "offer") {
        await this.pc.setRemoteDescription({ type: "offer", sdp: sig.sdp })
        const ans = await this.pc.createAnswer()
        await this.pc.setLocalDescription(ans)
        await this.send({
          kind: "answer",
          callId: this.opts.callId,
          from: this.opts.botName,
          to: sig.from,
          sdp: ans.sdp,
        })
      } else if (sig.kind === "answer") {
        await this.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp })
      } else if (sig.kind === "ice") {
        await this.pc.addIceCandidate(sig.candidate)
      } else if (sig.kind === "hangup") {
        this.close(`hangup from ${sig.from}`)
      }
    } catch (e: any) {
      this.opts.log(`[bot:${this.opts.botName}] signal ${sig.kind} from ${sig.from} failed: ${e.message}`)
    }
  }

  /** Wire RTCAudioSink to the inbound track and forward PCM frames upstream. */
  private tapAudio(track: any): void {
    const sink = new RTCAudioSink(track)
    sink.ondata = (data: { samples: Int16Array; sampleRate: number; channelCount: number }) => {
      if (this.closed) return
      this.opts.onAudioFrame({
        samples: data.samples,
        sampleRate: data.sampleRate,
        channelCount: data.channelCount,
        receivedAt: Date.now(),
      })
    }
    this.sinks.add({ stop: () => { try { sink.stop() } catch { /* */ } } })
  }

  /** Tear down: stop sinks, close PC, unsubscribe from the broker.
   *  Idempotent — called from track handlers, signal handlers, or BotManager. */
  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.opts.log(`[bot:${this.opts.botName}] closing (${reason})`)
    for (const s of this.sinks) s.stop()
    this.sinks.clear()
    try { this.unsubscribe?.() } catch { /* */ }
    try { this.pc?.close() } catch { /* */ }
    this.pc = undefined
    this.opts.onClosed?.(reason)
  }
}
