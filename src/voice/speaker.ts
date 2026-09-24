// --- Speaking out loud on the daemon's host, one line at a time ---
//
// Each line is sent to ElevenLabs the moment it is known, so its audio is
// usually ready before the line ahead of it finishes playing; lines still
// play strictly in order. `stop()` silences everything at once: the line
// playing is killed and queued ones are dropped. Talk mode and task
// narration share one SpeechOut, so two voices never talk over each other.

import { spawn, type ChildProcess } from "child_process"
import { readFileSync, writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

export interface Utterance {
  voiceId: string
  text: string
  /** Called when this line starts playing. */
  onStart?: () => void
}

/** Audio for a line: an mp3 file, or null to fall back to the OS voice. */
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
    if (!key) return null
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${u.voiceId}/stream?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: u.text, model_id: "eleven_flash_v2_5" }),
      signal,
    })
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 160)}`)
    const file = join(tmpdir(), `agentx-say-${process.pid}-${++n}.mp3`)
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return file
  }
}

/** afplay on macOS, mpg123 elsewhere; `say` when there is no audio file. */
export const systemPlay: Play = (file, u) => {
  if (!file) return spawn("say", [u.text], { stdio: "ignore" })
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
      const finish = (completed: boolean) => {
        if (ended) return
        ended = true
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
