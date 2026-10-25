import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { resolve } from "path"

// --- Voice samples: the owner's past posts, in the agent's workspace ---
//
// The owner drops past posts into <workspace>/voice/, one post per
// .md or .txt file. The agent reads the ones closest to the topic before it
// writes, and every draft names the files it followed (drafts.ts refuses a
// draft that names none, or names a file that is not there).

export const VOICE_DIR = "voice"

const SAMPLE_EXT = /\.(md|markdown|txt)$/i
const MAX_SAMPLES = 200
const MAX_SAMPLE_BYTES = 20_000
const EXCERPT = 240

export interface VoiceSample {
  /** File name inside voice/. */
  file: string
  text: string
}

export interface PickedSample {
  file: string
  /** Words the sample shares with the topic. */
  score: number
  excerpt: string
}

export function voiceDir(workspace: string): string {
  return resolve(workspace, VOICE_DIR)
}

/** Every sample in voice/, by file name. Missing folder: none. */
export function listSamples(workspace: string): VoiceSample[] {
  const dir = voiceDir(workspace)
  if (!existsSync(dir)) return []
  const out: VoiceSample[] = []
  for (const file of readdirSync(dir).filter((f) => SAMPLE_EXT.test(f) && !f.startsWith(".")).sort()) {
    const path = resolve(dir, file)
    try {
      if (!statSync(path).isFile()) continue
      const text = readFileSync(path, "utf-8").slice(0, MAX_SAMPLE_BYTES).trim()
      if (text) out.push({ file, text })
    } catch { /* unreadable: skip */ }
    if (out.length >= MAX_SAMPLES) break
  }
  return out
}

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []))
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat
}

/**
 * The samples to follow for a topic: the ones sharing the most words with
 * it, then by file name. With no topic, the first `n` by file name.
 */
export function pickSamples(workspace: string, topic = "", n = 3): PickedSample[] {
  const want = words(topic)
  return listSamples(workspace)
    .map((s) => {
      const have = words(s.text)
      let score = 0
      for (const w of want) if (have.has(w)) score++
      return { file: s.file, score, excerpt: excerpt(s.text) }
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, Math.max(1, n))
}

/** The named files that are not samples in voice/. */
export function missingSamples(workspace: string, files: string[]): string[] {
  const have = new Set(listSamples(workspace).map((s) => s.file))
  return files.filter((f) => !have.has(f))
}
