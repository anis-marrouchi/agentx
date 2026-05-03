import { WebRtcBot, type WebRtcBotOptions, type AudioFrame } from "@/channels/webrtc-bot"
import { AudioChunker } from "@/channels/webrtc-audio"
import { Whisper, type WhisperBackend } from "@/whisper"
import type { WebRtcSignalBroker } from "@/channels/webrtc-signal"

// --- Per-call AI participant lifecycle ---
//
// Spawned by POST /webrtc/bot/invite with { callId, target, agentId }.
// Wires WebRtcBot → AudioChunker → Whisper → onTranscript(text). The actual
// "do something with the text" step is provided by the daemon (e.g. send to
// Telegram, append to wiki) so this manager stays UI-agnostic.

export interface BotInvite {
  callId: string
  /** The peer name we're transcribing from (the human's normalized name). */
  target: string
  /** Agent id to attribute the transcript to. */
  agentId: string
}

export interface BotManagerOptions {
  broker: WebRtcSignalBroker
  iceServers: RTCIceServer[]
  whisperBackend: WhisperBackend
  whisperModel?: string
  whisperLanguage?: string
  /** Absolute path override for mlx_whisper. */
  mlxBinary?: string
  /** Hard cap to stop runaway bots. */
  maxCallMinutes: number
  log: (...args: unknown[]) => void
  /** Fired with each transcribed chunk. Empty/null transcripts are filtered
   *  out before this hook is called. */
  onTranscript: (event: { invite: BotInvite; text: string; durationMs: number }) => void | Promise<void>
}

interface ActiveBot {
  invite: BotInvite
  bot: WebRtcBot
  chunker: AudioChunker
  startedAt: number
  timeoutTimer: ReturnType<typeof setTimeout>
  /** Number of transcript chunks dispatched so far. Surfaces in the
   *  session-history ring buffer so /webrtc/history can show how
   *  much speech actually happened on a call. */
  transcriptChunks: number
}

/** Completed-session snapshot kept in a small ring buffer for the
 *  admin /webrtc/history view. Persistence to disk is deliberately
 *  deferred — operators wanting an audit trail enable a transcript
 *  log via the `webrtcBot.transcriptChannel` config (separate flow). */
export interface CompletedBotSession {
  callId: string
  agentId: string
  target: string
  startedAt: number
  endedAt: number
  durationSec: number
  transcriptChunks: number
  reason: string
}

const HISTORY_RING_SIZE = 50

export class BotManager {
  private opts: BotManagerOptions
  private bots: Map<string, ActiveBot> = new Map()
  private whisper: Whisper
  /** Ring buffer of recently-completed sessions. Surfaced via history(). */
  private completed: CompletedBotSession[] = []

  constructor(opts: BotManagerOptions) {
    this.opts = opts
    this.whisper = new Whisper({
      backend: opts.whisperBackend,
      model: opts.whisperModel,
      language: opts.whisperLanguage,
      mlxBinary: opts.mlxBinary,
      log: opts.log,
    })
  }

  /** Spawn a bot for a call. Idempotent — if one is already running for this
   *  callId it's reused instead of duplicated. */
  async invite(invite: BotInvite): Promise<{ ok: boolean; error?: string }> {
    const existing = this.bots.get(invite.callId)
    if (existing) {
      this.opts.log(`[bot-manager] bot already active for call=${invite.callId} agent=${existing.invite.agentId}`)
      return { ok: true }
    }

    const botName = `bot:${invite.agentId}`
    this.opts.log(`[bot-manager] spawning ${botName} for call=${invite.callId} target=${invite.target}`)

    const chunker = new AudioChunker({
      log: this.opts.log,
      onChunk: async (wav, durationMs) => {
        const text = await this.whisper.transcribe(wav)
        if (!text) return
        this.recordTranscriptChunk(invite.callId)
        try {
          await this.opts.onTranscript({ invite, text, durationMs })
        } catch (e: any) {
          this.opts.log(`[bot-manager] onTranscript hook threw: ${e.message}`)
        }
      },
    })

    const botOpts: WebRtcBotOptions = {
      callId: invite.callId,
      botName,
      target: invite.target,
      iceServers: this.opts.iceServers,
      broker: this.opts.broker,
      log: this.opts.log,
      onAudioFrame: (frame: AudioFrame) => chunker.push(frame),
      onClosed: (reason) => {
        this.opts.log(`[bot-manager] bot for call=${invite.callId} closed (${reason})`)
        this.tearDown(invite.callId)
      },
    }
    const bot = new WebRtcBot(botOpts)
    try {
      await bot.start()
    } catch (e: any) {
      this.opts.log(`[bot-manager] bot.start failed: ${e.message}`)
      chunker.shutdown()
      return { ok: false, error: e.message }
    }

    const timeoutTimer = setTimeout(() => {
      this.opts.log(`[bot-manager] hard-cap reached for call=${invite.callId} (${this.opts.maxCallMinutes}min) — closing`)
      this.tearDown(invite.callId)
    }, this.opts.maxCallMinutes * 60_000)

    this.bots.set(invite.callId, {
      invite, bot, chunker, startedAt: Date.now(), timeoutTimer,
      transcriptChunks: 0,
    })
    return { ok: true }
  }

  /** Close the bot for a call (manual hangup, peer disconnect, or timeout). */
  tearDown(callId: string, reason: string = "teardown"): void {
    const active = this.bots.get(callId)
    if (!active) return
    this.bots.delete(callId)
    clearTimeout(active.timeoutTimer)
    try { active.bot.close("manager teardown") } catch { /* */ }
    try { active.chunker.shutdown() } catch { /* */ }
    const endedAt = Date.now()
    const durationSec = Math.round((endedAt - active.startedAt) / 1000)
    this.opts.log(`[bot-manager] tore down bot for call=${callId} (was up ${durationSec}s)`)
    // Push to ring buffer.
    this.completed.unshift({
      callId,
      agentId: active.invite.agentId,
      target: active.invite.target,
      startedAt: active.startedAt,
      endedAt,
      durationSec,
      transcriptChunks: active.transcriptChunks,
      reason,
    })
    if (this.completed.length > HISTORY_RING_SIZE) this.completed.length = HISTORY_RING_SIZE
  }

  /** Snapshot for /health or admin UI. */
  active(): Array<{ callId: string; agentId: string; target: string; uptimeSec: number }> {
    const now = Date.now()
    return [...this.bots.values()].map(b => ({
      callId: b.invite.callId,
      agentId: b.invite.agentId,
      target: b.invite.target,
      uptimeSec: Math.round((now - b.startedAt) / 1000),
    }))
  }

  /** Recently-completed sessions (ring buffer, newest first). Used by the
   *  admin /webrtc/history view to surface call activity even after the
   *  bot has torn down. Persistence to disk is deferred — opt in via the
   *  webrtcBot.transcriptChannel config to also push transcripts to a
   *  channel. */
  history(): CompletedBotSession[] {
    return [...this.completed]
  }

  /** Increment the transcript-chunk counter for an active call. Wired
   *  from the onTranscript hook so /webrtc/history shows how much
   *  speech actually happened on a call. */
  recordTranscriptChunk(callId: string): void {
    const active = this.bots.get(callId)
    if (active) active.transcriptChunks++
  }

  /** Tear down every active bot (daemon shutdown). */
  shutdown(): void {
    for (const callId of [...this.bots.keys()]) this.tearDown(callId, "shutdown")
  }
}
