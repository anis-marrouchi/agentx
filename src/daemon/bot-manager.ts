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
}

export class BotManager {
  private opts: BotManagerOptions
  private bots: Map<string, ActiveBot> = new Map()
  private whisper: Whisper

  constructor(opts: BotManagerOptions) {
    this.opts = opts
    this.whisper = new Whisper({
      backend: opts.whisperBackend,
      model: opts.whisperModel,
      language: opts.whisperLanguage,
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
    })
    return { ok: true }
  }

  /** Close the bot for a call (manual hangup, peer disconnect, or timeout). */
  tearDown(callId: string): void {
    const active = this.bots.get(callId)
    if (!active) return
    this.bots.delete(callId)
    clearTimeout(active.timeoutTimer)
    try { active.bot.close("manager teardown") } catch { /* */ }
    try { active.chunker.shutdown() } catch { /* */ }
    this.opts.log(`[bot-manager] tore down bot for call=${callId} (was up ${Math.round((Date.now() - active.startedAt) / 1000)}s)`)
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

  /** Tear down every active bot (daemon shutdown). */
  shutdown(): void {
    for (const callId of [...this.bots.keys()]) this.tearDown(callId)
  }
}
