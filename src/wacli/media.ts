import { mkdir, mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { WacliMessage } from "./rules"
import type { PreparedMessage } from "./triage"

// --- Images and voice notes, made readable for the agent ---
//
// An image is downloaded to a private temp folder and its path goes in the
// prompt, so the agent can open it. A voice note is transcribed when this
// computer has speech to text, and deleted. Everything is removed after
// the turn. Other media (video, documents) is named, not opened.

export interface MediaDeps {
  enabled: boolean
  download: (chat: string, id: string, output: string) => Promise<void>
  /** Words from an audio file, or null when speech to text isn't set up. */
  transcribe: (file: string, mime: string) => Promise<string | null>
}

const IMAGE = /^(image|sticker)$/i
const AUDIO = /^(audio|ptt|voice)$/i

export async function prepareMedia(batch: WacliMessage[], deps: MediaDeps): Promise<{ messages: PreparedMessage[]; cleanup: () => Promise<void> }> {
  if (!batch.some((m) => m.Media)) return { messages: batch.map((msg) => ({ msg })), cleanup: async () => {} }
  const dir = deps.enabled ? await mkdtemp(join(tmpdir(), "agentx-wacli-")) : null
  const cleanup = async () => { if (dir) await rm(dir, { recursive: true, force: true }) }
  const messages: PreparedMessage[] = []
  for (const [i, msg] of batch.entries()) {
    const type = msg.Media?.Type ?? ""
    if (!msg.Media || !(IMAGE.test(type) || AUDIO.test(type))) { messages.push({ msg }); continue }
    if (!dir) { messages.push({ msg, mediaNote: "(not downloaded: wacli.media is off)" }); continue }
    const into = join(dir, String(i))
    try {
      await mkdir(into)
      await deps.download(msg.Chat, msg.ID, into)
      const [name] = await readdir(into)
      if (!name) throw new Error("wacli saved no file")
      const file = join(into, name)
      if (IMAGE.test(type)) { messages.push({ msg, file }); continue }
      const words = await deps.transcribe(file, msg.Media.MimeType || "audio/ogg")
      messages.push(words ? { msg, transcript: words } : { msg, mediaNote: "(voice note; speech to text isn't set up on this computer)" })
    } catch (e: any) {
      messages.push({ msg, mediaNote: `(couldn't be downloaded: ${String(e?.message ?? e).slice(0, 160)})` })
    }
  }
  return { messages, cleanup }
}
