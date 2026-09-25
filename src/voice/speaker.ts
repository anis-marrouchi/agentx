// --- Speaking out loud on the daemon's host, one line at a time ---
//
// With the system provider (the default) a line is spoken by `say` in the
// agent's macOS voice and nothing leaves the machine. With ElevenLabs, each
// line is sent the moment it is known, so its audio is usually ready
// before the line ahead of it finishes playing; lines still play strictly
// in order. `stop()` silences everything at once: the line
// playing is killed and queued ones are dropped. Talk mode and task
// narration share one SpeechOut, so two voices never talk over each other.

import { spawn, type ChildProcess } from "child_process"
import { readFileSync, writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { warnOnce } from "./system-voices"
import { ensureSiriSay, isSiriVoice, siriSupported, type SiriHost } from "./siri"
import { detectLanguage } from "./language"

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
}

export interface Utterance {
  voice: VoiceRef
  text: string
  /** Called when this line starts playing. */
  onStart?: () => void
}

/** Audio for a line: an mp3 file, or null to speak it with the system voice. */
export type Synth = (u: Utterance, signal: AbortSignal) => Promise<string | null>
/** Start playing; the returned process exits when playback ends. */
export type Play = (file: string | null, u: Utterance) => ChildProcess

export interface SpeechEvents {
  onStart?: (u: Utterance, at: number) => void
  onEnd?: (u: Utterance, at: number, completed: boolean) => void
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
        body: JSON.stringify({ text: u.text, model_id: "eleven_flash_v2_5" }),
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
  return id && !isSiriVoice(id) ? ["-v", id] : []
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
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
    p.stdin?.on("error", () => {})
    p.stdin?.end(u.text)
    return p
  }
  const p = process.platform === "darwin"
    ? spawn("afplay", [file], { stdio: "ignore" })
    : spawn("mpg123", ["-q", file], { stdio: "ignore" })
  p.on("exit", () => { try { unlinkSync(file) } catch { /* already gone */ } })
  return p
}

export class SpeechOut {
  private tail: Promise<unknown> = Promise.resolve()
  /** Bumped by stop(): lines queued under an older generation are dropped. */
  private gen = 0
  private aborter = new AbortController()
  private playing: ChildProcess | null = null
  private pending = 0

  constructor(
    private synth: Synth = elevenLabsSynth(),
    private play: Play = systemPlay,
    public events: SpeechEvents = {},
    private limitMs: (text: string) => number = speakLimitMs,
  ) {}

  /** True while anything is playing or waiting to play. */
  get busy(): boolean { return this.pending > 0 }

  /** Queue a line. Resolves true once it has played in full, false if it
   *  was stopped or failed. */
  say(u: Utterance): Promise<boolean> {
    const gen = this.gen
    const signal = this.aborter.signal
    // Start synthesis now; the catch keeps an early failure from being
    // reported as unhandled before this line's turn comes.
    const audio = this.synth(u, signal).then((f) => ({ f }), (e) => ({ e }))
    this.pending++
    const done = this.tail.then(async () => {
      try {
        const got = await audio
        if (gen !== this.gen) return false
        if ("e" in got) throw got.e
        return await this.playOne(got.f, u, gen)
      } catch {
        return false
      } finally {
        this.pending--
      }
    })
    this.tail = done
    return done
  }

  /** Silence now: kill what is playing and drop everything queued. */
  stop(): void {
    this.gen++
    this.aborter.abort()
    this.aborter = new AbortController()
    this.playing?.kill()
  }

  private playOne(file: string | null, u: Utterance, gen: number): Promise<boolean> {
    if (gen !== this.gen) return Promise.resolve(false)
    return new Promise((resolve) => {
      const p = this.play(file, u)
      this.playing = p
      this.events.onStart?.(u, Date.now())
      u.onStart?.()
      let ended = false
      // A player that never exits (a hung `say`) must not hold every
      // later line: past its bound it is killed and the line fails.
      const watchdog = setTimeout(() => { if (!ended) p.kill() }, this.limitMs(u.text))
      const finish = (completed: boolean) => {
        if (ended) return
        ended = true
        clearTimeout(watchdog)
        if (this.playing === p) this.playing = null
        this.events.onEnd?.(u, Date.now(), completed)
        resolve(completed)
      }
      // A player that cannot start (not installed) may never emit close.
      p.on("error", () => finish(false))
      p.on("close", (code) => finish(code === 0 && gen === this.gen))
    })
  }
}
