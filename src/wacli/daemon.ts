import type Database from "better-sqlite3"
import { createCard, type CardAction } from "@/approvals/cards"
import type { DaemonConfig } from "@/daemon/config"
import { elevenLabsKey } from "@/voice/speaker"
import { AUDIO_LIMITS, detectSttHost, elevenLabsScribe, localWhisper, measureSeconds, sttEngines } from "@/voice/transcribe"
import { dirname } from "path"
import { wacliDownloadMedia, wacliSend } from "./cli"
import { prepareMedia } from "./media"
import { WacliService } from "./service"
import { WacliStore } from "./store"

// --- The daemon's side of WhatsApp triage: wiring only ---

export function wacliSecret(cfg: DaemonConfig["wacli"]): string | undefined {
  return cfg.secret || process.env[cfg.secretEnv] || undefined
}

export function wacliCliOptions(cfg: DaemonConfig["wacli"]): { binary?: string; account?: string } {
  return { binary: cfg.binary, account: cfg.account }
}

/** Send an approved card's action. The only kind today is a WhatsApp reply. */
export async function runWacliAction(action: CardAction, cfg: DaemonConfig["wacli"]): Promise<void> {
  if (action.kind !== "wacli.send") throw new Error(`unknown action ${action.kind}`)
  await wacliSend(action, wacliCliOptions(cfg))
}

/** A voice note's words with this computer's speech to text (voice.stt). */
async function transcribe(file: string, mime: string, stt: DaemonConfig["voice"]["stt"]): Promise<string | null> {
  const host = detectSttHost(elevenLabsKey())
  const engines = sttEngines(stt, host)
  if (!engines.length) return null
  if (host.ffmpeg) {
    const secs = await measureSeconds(file, host.ffmpeg)
    if (secs == null || secs * 1000 > AUDIO_LIMITS.ms) return null
  }
  for (const engine of engines) {
    try {
      const text = engine === "elevenlabs"
        ? await elevenLabsScribe(file, mime, host.key!)
        : await localWhisper(engine, engine === "mlx-whisper" ? host.mlx! : host.whisper!, file, host.ffmpeg!, dirname(file))
      if (text.trim()) return text.trim()
    } catch { /* next engine */ }
  }
  return null
}

export interface WacliDaemonDeps {
  db: Database.Database
  root: string
  config: () => DaemonConfig
  hasAgent: (id: string) => boolean
  execute: (agentId: string, message: string, chatId: string) => Promise<{ content?: string; error?: string }>
  notifyOwner: (title: string, message: string, from: string) => Promise<void>
  log: (line: string) => void
}

export function createWacliService(d: WacliDaemonDeps): WacliService {
  const cfg = () => d.config().wacli
  return new WacliService({
    store: new WacliStore(d.db),
    settings: cfg,
    hasAgent: d.hasAgent,
    execute: d.execute,
    prepare: (batch) => prepareMedia(batch, {
      enabled: cfg().media,
      download: (chat, id, output) => wacliDownloadMedia(chat, id, output, wacliCliOptions(cfg())),
      transcribe: (file, mime) => transcribe(file, mime, d.config().voice.stt),
    }),
    createCard: (input, action) => createCard(d.root, input, { settings: d.config().approvals, action }),
    send: (action) => runWacliAction(action, cfg()),
    notifyOwner: d.notifyOwner,
    log: d.log,
  })
}
