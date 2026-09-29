import type Database from "better-sqlite3"
import { dirname } from "path"
import { elevenLabsKey } from "@/voice/speaker"
import { detectSttHost, elevenLabsScribe, localWhisper, sttEngines, type SttSetting } from "@/voice/transcribe"
import type { WhatsappTriageConfig } from "./config"
import { sendWithWacli } from "./drafts"
import { mediaDescriber } from "./media"
import { TriageService, type TriageDeps } from "./service"
import { TriageStore } from "./store"

// --- The daemon's triage service, with this computer's wacli and STT ---

/** Voice note to words with the engines voice input uses, or null. */
export function transcriber(setting: () => SttSetting, log: (m: string) => void) {
  return async (file: string, mime: string): Promise<string | null> => {
    const host = detectSttHost(elevenLabsKey())
    for (const engine of sttEngines(setting(), host)) {
      try {
        return engine === "elevenlabs"
          ? await elevenLabsScribe(file, mime, host.key!)
          : await localWhisper(engine, engine === "mlx-whisper" ? host.mlx! : host.whisper!, file, host.ffmpeg!, dirname(file))
      } catch (e: any) {
        log(`[whatsapp-triage] ${engine} transcription failed: ${String(e?.message ?? e).split("\n")[0]}`)
      }
    }
    return null
  }
}

export function createTriageService(opts: {
  db: Database.Database
  root: string
  config: () => WhatsappTriageConfig
  stt: () => SttSetting
  execute: TriageDeps["execute"]
  notify: TriageDeps["notify"]
  log: (m: string) => void
}): TriageService {
  return new TriageService({
    root: opts.root,
    store: new TriageStore(opts.db),
    config: opts.config,
    execute: opts.execute,
    notify: opts.notify,
    send: sendWithWacli,
    describeMedia: mediaDescriber({
      root: opts.root,
      wacli: () => opts.config().wacli,
      transcribe: transcriber(opts.stt, opts.log),
    }),
    log: opts.log,
  })
}
