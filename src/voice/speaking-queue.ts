// --- The host's one speaking queue ---
//
// Everything the daemon says aloud waits here, one line at a time: a
// spoken answer, task narration, a talk, a lesson. Lines play strictly in
// order; each is synthesised the moment it is queued, so its audio is
// usually ready before the line ahead of it ends.
//
// The listener comes first: pause() (the door opening) cuts the line
// playing and holds the queue; resume() plays that line again from the
// start, then the rest. A held queue resumes by itself after `holdMs`, so
// a door that never closes cannot silence the host for good. stop() drops
// everything. Every change is reported through `events.onChange`.

import type { ChildProcess } from "child_process"
import { unlinkSync } from "fs"
import { elevenLabsSynth, speakLimitMs, systemPlay, type Play, type SpeechEvents, type Synth, type Utterance, type VoiceRef } from "./speaker"

export type SpeechKind = "answer" | "narration" | "talk" | "lesson" | "line"

export interface QueueItem {
  id: string
  agentId: string | null
  kind: SpeechKind
  text: string
  voice: VoiceRef
  enqueuedAt: number
}

export interface QueueView {
  paused: boolean
  playing: QueueItem | null
  waiting: QueueItem[]
  /** Lines played in full, newest first, so one can be replayed. */
  recent: QueueItem[]
}

type Audio = { f: string | null } | { e: unknown }

interface Entry {
  item: QueueItem
  u: Utterance
  audio: Promise<Audio>
  ac: AbortController
  started: boolean
  done: (played: boolean) => void
}

const RECENT = 10
const RANK = { high: 0, normal: 1, low: 2 } as const

export class SpeechOut {
  private waiting: Entry[] = []
  private current: Entry | null = null
  private playing: ChildProcess | null = null
  private recent: QueueItem[] = []
  private held = false
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped whenever the current line changes hands: a player or a
   *  synthesis that finishes under an older run is ignored. */
  private run = 0
  private seq = 0

  constructor(
    private synth: Synth = elevenLabsSynth(),
    private play: Play = systemPlay,
    public events: SpeechEvents & { onChange?: (view: QueueView) => void } = {},
    private limitMs: (text: string) => number = speakLimitMs,
    private holdMs = 60_000,
  ) {}

  /** True while anything is playing or waiting to play. */
  get busy(): boolean { return !!this.current || this.waiting.length > 0 }

  get paused(): boolean { return this.held }

  /** Queue a line. Resolves true once it has played in full, false if it
   *  was skipped, stopped or failed. */
  say(u: Utterance): Promise<boolean> { return this.enqueue(u).done }

  /** Queue a line and get its item; `front` puts it next in line. */
  enqueue(u: Utterance, front = false): { item: QueueItem; done: Promise<boolean> } {
    const ac = new AbortController()
    const item: QueueItem = {
      id: `s${Date.now().toString(36)}-${++this.seq}`,
      agentId: u.agentId ?? null, kind: u.kind ?? "line", text: u.text, voice: u.voice, enqueuedAt: Date.now(),
    }
    let done!: (played: boolean) => void
    const played = new Promise<boolean>((r) => { done = r })
    // The catch keeps an early failure from being reported as unhandled
    // before this line's turn comes.
    const audio = this.synth(u, ac.signal).then((f) => ({ f }), (e) => ({ e }))
    const entry: Entry = { item, u, audio, ac, started: false, done }
    if (front) this.waiting.unshift(entry)
    else {
      // A "high" agent's line goes ahead of waiting normal and low ones,
      // a normal one ahead of low ones; equals keep arrival order.
      const mine = RANK[u.voice.priority ?? "normal"]
      const at = this.waiting.findIndex((e) => RANK[e.u.voice.priority ?? "normal"] > mine)
      if (at < 0) this.waiting.push(entry)
      else this.waiting.splice(at, 0, entry)
    }
    this.changed()
    this.next()
    return { item, done: played }
  }

  view(): QueueView {
    return { paused: this.held, playing: this.current?.item ?? null, waiting: this.waiting.map((e) => e.item), recent: [...this.recent] }
  }

  /** Drop one line, playing or waiting; the rest keep their order. */
  skip(id: string): boolean {
    if (this.current?.item.id === id) {
      this.drop(this.detach()!)
      this.changed()
      this.next()
      return true
    }
    const i = this.waiting.findIndex((e) => e.item.id === id)
    if (i < 0) return false
    this.drop(this.waiting.splice(i, 1)[0])
    this.changed()
    return true
  }

  /** Move a waiting line to the front: it plays after the current one. */
  front(id: string): boolean {
    if (this.current?.item.id === id) return true
    const i = this.waiting.findIndex((e) => e.item.id === id)
    if (i < 0) return false
    this.waiting.unshift(...this.waiting.splice(i, 1))
    this.changed()
    return true
  }

  /** Say a queued or recently played line again, next in line. */
  replay(id: string): QueueItem | null {
    const found = [this.current?.item, ...this.waiting.map((e) => e.item), ...this.recent].find((i) => i?.id === id)
    if (!found) return null
    return this.enqueue({ voice: found.voice, text: found.text, agentId: found.agentId ?? undefined, kind: found.kind }, true).item
  }

  /** The listener is speaking: cut the current line and hold the queue. */
  pause(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = setTimeout(() => this.resume(), this.holdMs)
    this.holdTimer.unref?.()
    if (this.held) return
    this.held = true
    const cut = this.detach()
    if (cut) this.waiting.unshift(cut)
    this.changed()
  }

  /** The listener's turn is over: the cut line plays again, then the rest. */
  resume(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
    if (!this.held) return
    this.held = false
    this.changed()
    this.next()
  }

  /** Drop every line of one kind — a talk or lesson silencing itself. */
  cancel(kind: SpeechKind): void {
    let dropped = false
    if (this.current?.item.kind === kind) { this.drop(this.detach()!); dropped = true }
    for (const e of this.waiting.filter((w) => w.item.kind === kind)) { this.drop(e); dropped = true }
    this.waiting = this.waiting.filter((w) => w.item.kind !== kind)
    if (!dropped) return
    this.changed()
    this.next()
  }

  /** Silence now: kill what is playing, drop everything, stop holding. */
  stop(): void {
    const all = [this.detach(), ...this.waiting.splice(0)].filter((e): e is Entry => !!e)
    for (const e of all) this.drop(e)
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
    const wasHeld = this.held
    this.held = false
    if (all.length || wasHeld) this.changed()
  }

  /** Start the next line, unless one is playing or the queue is held. */
  private next(): void {
    if (this.held || this.current || !this.waiting.length) return
    const e = this.waiting.shift()!
    this.current = e
    const run = ++this.run
    this.changed()
    void e.audio.then((got) => {
      if (run !== this.run) return
      if ("e" in got) return this.finish(e, false)
      this.playOne(e, got.f, run)
    })
  }

  private playOne(e: Entry, file: string | null, run: number): void {
    const p = this.play(file, e.u)
    this.playing = p
    if (!e.started) {
      e.started = true
      this.events.onStart?.(e.u, Date.now())
      e.u.onStart?.()
    }
    let ended = false
    // A player that never exits (a hung `say`) must not hold every later
    // line: past its bound it is killed and the line fails.
    const watchdog = setTimeout(() => { if (!ended) p.kill() }, this.limitMs(e.u.text))
    const end = (completed: boolean) => {
      if (ended) return
      ended = true
      clearTimeout(watchdog)
      if (this.playing === p) this.playing = null
      // Paused, skipped or stopped meanwhile: whoever did it owns the line.
      if (run !== this.run) return
      this.events.onEnd?.(e.u, Date.now(), completed)
      this.finish(e, completed)
    }
    // A player that cannot start (not installed) may never emit close.
    p.on("error", () => end(false))
    p.on("close", (code) => end(code === 0))
  }

  private finish(e: Entry, played: boolean): void {
    this.detach()
    if (played) this.recent = [e.item, ...this.recent].slice(0, RECENT)
    this.drop(e, played)
    this.changed()
    this.next()
  }

  /** Take the current line off the speakers; returns it. */
  private detach(): Entry | null {
    const e = this.current
    if (!e) return null
    this.current = null
    this.run++
    const p = this.playing
    this.playing = null
    p?.kill()
    return e
  }

  /** Settle a line for good and delete its audio file. */
  private drop(e: Entry, played = false): void {
    e.ac.abort()
    e.done(played)
    void e.audio.then((got) => {
      if ("f" in got && got.f) try { unlinkSync(got.f) } catch { /* already gone */ }
    })
  }

  private changed(): void {
    try { this.events.onChange?.(this.view()) } catch { /* a listener's failure is not the queue's */ }
  }
}
