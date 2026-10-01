// --- Speaking out loud on the daemon's host, one line at a time ---
//
// With the system provider (the default) a line is spoken by `say` in the
// agent's macOS voice and nothing leaves the machine. With ElevenLabs, each
// line is sent the moment it is known, so its audio is usually ready
// before the line ahead of it finishes playing. The queue that orders the
// lines is SpeechOut (speaking-queue.ts): every voice on the daemon shares
// one, so two voices never talk over each other.

import { spawn, type ChildProcess } from "child_process"
import { readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { warnOnce } from "./system-voices"
import { ensureSiriSay, isSiriVoice, siriSupported, type SiriHost } from "./siri"
import { detectLanguage } from "./language"
import type { SpeechKind } from "./speaking-queue"

/** Which engine speaks a line, and in which voice. */
export interface VoiceRef {
  provider: "system" | "elevenlabs"
  /** ElevenLabs voice id; only used by the elevenlabs provider. */
  elevenlabs: string
  /** macOS voice identifier; null for the OS default voice. */
  system: string | null
  /** Identifiers per language ("fr", "ar"), for lines in that language. */
  languages?: Record<string, string | null>
  /** When ElevenLabs cannot speak, fall back to the system voice. */
  fallback: boolean
  /** Speaking speed, 1 (normal) when unset. */
  rate?: number
  /** Place in the speaking queue; normal when unset. */
  priority?: "high" | "normal" | "low"
}

/** Words a minute for `say` at this rate; its own default is about 175. */
export const sayRate = (rate?: number): number | null =>
  rate && rate !== 1 ? Math.round(175 * rate) : null

/** ElevenLabs' speed setting, which only accepts 0.7 to 1.2. */
export const elevenLabsSpeed = (rate?: number): number | null =>
  rate && rate !== 1 ? Math.min(1.2, Math.max(0.7, rate)) : null

export interface Utterance {
  voice: VoiceRef
  text: string
  /** Called when this line starts playing. */
  onStart?: () => void
  /** Who says it and why; shown in the speaking queue. */
  agentId?: string
  kind?: SpeechKind
}

/** Audio for a line: an mp3 file, or null to speak it with the system voice. */
export type Synth = (u: Utterance, signal: AbortSignal) => Promise<string | null>
/** Start playing; the returned process exits when playback ends. */
export type Play = (file: string | null, u: Utterance) => ChildProcess

/** Why a line that had started playing stopped: it played to the end,
 *  its player failed, it ran past its bound, the listener spoke (pause),
 *  or it was skipped, cancelled with its kind, or stopped with the queue. */
export type SpeechEndReason = "finished" | "failed" | "watchdog" | "paused" | "skipped" | "cancelled" | "stopped"

export interface SpeechEvents {
  onStart?: (u: Utterance, at: number) => void
  onEnd?: (u: Utterance, at: number, completed: boolean) => void
  /** Every end of a line that had started, with its reason and how long
   *  it had been playing. */
  onStopped?: (u: Utterance, reason: SpeechEndReason, playedMs: number) => void
}

export function elevenLabsKey(): string | null {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  for (const p of [`${process.env.HOME}/.elevenlabs/key`, `${process.env.HOME}/.agentx/elevenlabs-key.txt`]) {
    try {
      const v = readFileSync(p, "utf8").trim()
      if (v) return v
    } catch { /* next */ }
  }
  return null
}

/** ElevenLabs Flash: the lowest-latency model, fine for short lines. */
export function elevenLabsSynth(key: string | null = elevenLabsKey()): Synth {
  let n = 0
  return async (u, signal) => {
    if (u.voice.provider === "system") return null
    if (!key) {
      if (u.voice.fallback) return null
      throw new Error("ElevenLabs is the voice provider but no key is set")
    }
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${u.voice.elevenlabs}/stream?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: u.text, model_id: "eleven_flash_v2_5",
          ...(elevenLabsSpeed(u.voice.rate) ? { voice_settings: { speed: elevenLabsSpeed(u.voice.rate) } } : {}),
        }),
        signal,
      })
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 160)}`)
      const file = join(tmpdir(), `agentx-say-${process.pid}-${++n}.mp3`)
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      return file
    } catch (e: any) {
      if (signal.aborted || !u.voice.fallback) throw e
      warnOnce(`elevenlabs:${String(e?.message ?? e).slice(0, 40)}`, `[voice] ElevenLabs failed (${String(e?.message ?? e).slice(0, 160)}); speaking with the system voice`)
      return null
    }
  }
}

/** The system voice for a line: its language's voice, else the default. */
export function systemVoiceFor(v: VoiceRef, text: string): string | null {
  const lang = v.languages && detectLanguage(text)
  return lang && v.languages && lang in v.languages ? v.languages[lang] : v.system
}

/** The `say` arguments for a line. A line that opens with "-" must not be
 *  read as an option, so the text always comes from stdin. A Siri voice
 *  cannot be named to `say`; it speaks as the OS default. */
export const sayArgs = (v: VoiceRef, text = ""): string[] => {
  const id = systemVoiceFor(v, text)
  const wpm = sayRate(v.rate)
  return [...(id && !isSiriVoice(id) ? ["-v", id] : []), ...(wpm ? ["-r", String(wpm)] : [])]
}

/** The command that speaks a line. On macOS every line goes through the
 *  shared script: it switches the default for a Siri voice, holds the one
 *  speaker lock, bounds the line, and is what `stopAllSpeakers` reaches. */
export function sayCommand(v: VoiceRef, text: string, siriSay: string | null): [string, string[]] {
  if (!siriSay) return ["say", sayArgs(v, text)]
  const id = systemVoiceFor(v, text)
  return ["/bin/sh", [siriSay, ...(id ? [id] : [])]]
}

/** How long a line may play before it is taken for hung: its length's
 *  worth of speech with room to spare, capped. The shared script applies
 *  the same bound to its own `say`. */
export function speakLimitMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.min(300, 5 + Math.floor((words * 6) / 10)) * 1000
}

/** Silence every speaker on this host, AgentX Voice's lines included:
 *  the line holding the shared script's lock stops (the voice is
 *  restored) and every queued line is dropped. Never throws. */
export function stopAllSpeakers(script: string | null = siriSayScript()): void {
  if (!script) return
  try {
    const p = spawn("/bin/sh", [script, "--stop"], { stdio: "ignore" })
    p.on("error", () => {})
  } catch { /* nothing to stop */ }
}

/** Put back the Spoken Content voice a line killed outright (SIGKILL, a
 *  crash) left switched, instead of waiting for the next line to do it.
 *  Takes the shared lock like any line. Never throws. */
export function restoreSpokenVoice(script: string | null = siriSayScript()): void {
  if (!script) return
  try {
    const p = spawn("/bin/sh", [script, "--restore"], { stdio: "ignore" })
    p.on("error", () => {})
  } catch { /* the next line restores it */ }
}

/** The shared script's path on a Mac that can switch voices, written if
 *  needed; null elsewhere, or when it cannot be written (plain `say` still
 *  speaks). Nothing is written on a host that cannot switch. */
export function siriSayScript(host: SiriHost = {}, home?: string): string | null {
  if (!siriSupported(host)) return null
  try {
    return ensureSiriSay(home)
  } catch (e: any) {
    warnOnce("siri-say", `[voice] could not write the Siri voice script (${String(e?.message ?? e).split("\n")[0]}); Siri voices will not switch`)
    return null
  }
}

/** afplay on macOS, mpg123 elsewhere; `say` when there is no audio file. */
export const systemPlay: Play = (file, u) => {
  if (!file) {
    const [cmd, args] = sayCommand(u.voice, u.text, siriSayScript())
    // The shared script takes the rate from its environment.
    const wpm = sayRate(u.voice.rate)
    const env = wpm ? { ...process.env, AGENTX_SAY_RATE: String(wpm) } : process.env
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], env })
    p.stdin?.on("error", () => {})
    p.stdin?.end(u.text)
    return p
  }
  // The file is the queue's to delete: a paused line plays it again.
  return process.platform === "darwin"
    ? spawn("afplay", [file], { stdio: "ignore" })
    : spawn("mpg123", ["-q", file], { stdio: "ignore" })
}
