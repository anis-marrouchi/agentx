import { mkdirSync, readdirSync, statSync, unlinkSync } from "fs"
import { resolve } from "path"
import type { WacliSettings } from "./config"
import type { WaMessage } from "./message"
import { downloadMedia, type Runner } from "./wacli"

// --- A line about a message's picture, voice note or file ---
//
// Images are downloaded so the agent can open them. Voice notes are
// transcribed when this computer has speech to text. Files are kept a week.

const KEEP_MS = 7 * 86_400_000

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "video/mp4": "mp4", "application/pdf": "pdf",
}

function extFor(m: WaMessage): string {
  const mime = (m.media?.mime ?? "").split(";")[0].trim().toLowerCase()
  if (EXT[mime]) return EXT[mime]
  const fromName = m.media?.filename?.match(/\.([a-z0-9]{1,5})$/i)?.[1]
  return fromName ? fromName.toLowerCase() : "bin"
}

function prune(dir: string, now: number): void {
  for (const f of readdirSync(dir)) {
    const p = resolve(dir, f)
    try { if (now - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p) } catch { /* gone */ }
  }
}

export interface MediaDeps {
  root: string
  wacli: () => WacliSettings
  /** Speech to text for a file, or null when none is set up here. */
  transcribe?: (file: string, mime: string) => Promise<string | null>
  exec?: Runner
  now?: () => number
}

export function mediaDescriber(deps: MediaDeps): (m: WaMessage) => Promise<string | null> {
  return async (m) => {
    if (!m.media) return null
    const kind = m.media.type.toLowerCase()
    const dir = resolve(deps.root, ".agentx", "whatsapp-triage", "media")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    prune(dir, deps.now?.() ?? Date.now())
    const safeId = m.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)
    const file = resolve(dir, `${safeId}.${extFor(m)}`)
    if (!(await downloadMedia(deps.wacli(), m.chat, m.id, file, deps.exec))) return `[${kind}: could not be downloaded]`
    if (kind === "image" || kind === "sticker") return `[image saved at ${file}: open it and take what it shows into account]`
    if (kind === "audio" || kind === "voice" || kind === "ptt") {
      const words = deps.transcribe ? await deps.transcribe(file, m.media.mime ?? "audio/ogg").catch(() => null) : null
      return words ? `[voice note, transcript: "${words.trim()}"]` : `[voice note saved at ${file}; no speech-to-text is set up]`
    }
    return `[${kind}${m.media.filename ? ` "${m.media.filename}"` : ""} saved at ${file}]`
  }
}
