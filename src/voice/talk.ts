// --- Talk mode: two agents talking out loud, with a door for the listener ---
//
// The first prototype ran a full agent turn per line and waited for the
// whole reply and the whole audio before the next speaker began: long
// silences. Here each line comes from a fast tool-less model, is cut into
// sentences as it streams, and each sentence goes to speech at once. The
// next speaker writes its reply while the current one is still talking,
// one turn ahead at most, so the hand-over is a breath, not a wait.
//
// The door: the listener may speak at any moment. Whoever is talking stops
// at once, queued lines are dropped, and the next reply answers the
// listener first. "stop" ends the talk.

import { SentenceCutter, speakable } from "./sentences"
import type { LineModel } from "./talk-model"
import type { SpeechOut, VoiceRef } from "./speaker"

export interface TalkSpeaker {
  agentId: string
  name: string
  voice: VoiceRef
  /** Who this agent is, in a few sentences. */
  persona: string
  /** From introInstruction(): introduce yourself, or talk casually. */
  introLine?: string
}

export interface TalkOpts {
  topic: string
  context?: string
  speakers: [TalkSpeaker, TalkSpeaker]
  speech: SpeechOut
  model: (speaker: TalkSpeaker, system: string) => LineModel
  listener?: string
  maxTurns?: number
  /** Silence after hush() with nothing said, before the talk carries on. */
  holdMs?: number
}

export type TalkEvent =
  | { type: "line"; turn: number; agentId: string; name: string; text: string }
  | { type: "gap"; turn: number; ms: number }
  /** From the listener's words arriving to the reply's first audio. */
  | { type: "answered"; turn: number; ms: number }
  | { type: "door"; text: string }
  | { type: "hush" }
  | { type: "end"; reason: string }
  | { type: "error"; error: string }

const DONE = /\bDONE\b\.?/g
const STOP = /^\s*(stop|stop talking|that'?s enough|end( the talk)?|enough)[\s.!]*$/i

/** "stop", "that's enough", "end the lesson": the listener wants quiet. */
export const isStop = (text: string) => STOP.test(text) || /^\s*end the (lesson|narration)[\s.!]*$/i.test(text)

interface Turn {
  n: number
  who: number
  text: string
  heard: string[]
  plays: Promise<boolean>[]
  started: Promise<void>
  aborted: boolean
  /** Its transcript row and the line relayed to the other speaker, both
   *  corrected if the listener cuts in before it is heard. */
  entry?: { name: string; text: string }
  relayed?: string
}

/** Who agents address when no `voice.listener` is configured. */
export const DEFAULT_LISTENER = "the user"

export function talkSystemPrompt(s: TalkSpeaker, listener: string): string {
  return [
    s.persona,
    "",
    "[TALK MODE] This is a spoken conversation, not a task. Talk like a colleague in the same office: " +
      "usually one or two short sentences, never more than three, in plain spoken words — no markdown, lists, URLs, emoji or stage directions. " +
      "Go longer only when something truly needs explaining. You have no tools here and take no actions; " +
      "if something should be done, say who will do it after the talk. Never invent status, numbers or facts " +
      `you were not told; say you would have to check. When ${listener} speaks, answer ${listener} first and ` +
      "follow that lead. When the topic is settled, say one short closing line and end with the word DONE.",
  ].join("\n")
}

export class Talk {
  readonly id = `talk-${Date.now().toString(36)}`
  readonly startedAt = Date.now()
  state: "running" | "held" | "ended" = "running"
  readonly transcript: Array<{ name: string; text: string }> = []
  readonly gaps: number[] = []

  private listener: string
  private models: LineModel[]
  private inbox: string[][] = [[], []]
  private ac = new AbortController()
  private doorQueue: string[] = []
  private wake: (() => void) | null = null
  private lastEndAt = 0
  private doorAt = 0
  /** The turn whose audio started most recently. */
  private playing: Turn | null = null
  private listeners: Array<(e: TalkEvent) => void> = []

  constructor(private opts: TalkOpts) {
    this.listener = opts.listener ?? DEFAULT_LISTENER
    this.models = opts.speakers.map((s) => opts.model(s, talkSystemPrompt(s, this.listener)))
    const setup = (i: number) => {
      const other = opts.speakers[1 - i].name
      return [
        `You are talking out loud with ${other} while ${this.listener} listens. Topic: ${opts.topic}`,
        opts.context ? `Context: ${opts.context}` : "",
        opts.speakers[i].introLine ?? "",
      ].filter(Boolean).join("\n")
    }
    this.inbox[0].push(setup(0), "You open.")
    this.inbox[1].push(setup(1))
  }

  on(fn: (e: TalkEvent) => void): void { this.listeners.push(fn) }

  /** The listener spoke. "stop" ends the talk; anything else is answered next. */
  door(text: string): void {
    if (this.state === "ended") return
    if (STOP.test(text)) return this.stop("stopped by the listener")
    this.silence()
    this.doorQueue.push(text.trim())
    this.doorAt = Date.now()
    this.state = "running"
    this.emit({ type: "door", text })
    this.poke()
  }

  /** The listener is about to speak: everyone goes quiet and listens. */
  hush(): void {
    if (this.state !== "running") return
    this.silence()
    this.state = "held"
    this.emit({ type: "hush" })
    this.poke()
  }

  stop(reason = "stopped"): void {
    if (this.state === "ended") return
    this.state = "ended"
    this.silence()
    for (const m of this.models) m.close()
    this.emit({ type: "end", reason })
    this.poke()
  }

  /** Runs the talk to its end. Never rejects; failures end it with an event. */
  async run(): Promise<void> {
    const max = this.opts.maxTurns ?? 10
    let who = 0
    let turns = 0
    try {
      let pending: Promise<Turn> = this.generate(who, turns++, turns >= max)
      while (!this.is("ended")) {
        const t = await pending
        if (this.is("ended")) break
        if (t.aborted || this.is("held") || this.doorQueue.length) {
          who = await this.afterInterruption(t)
          if (this.is("ended")) break
          pending = this.generate(who, turns++, turns >= max)
          continue
        }
        const settled = DONE.test(t.text) || turns >= max
        DONE.lastIndex = 0
        if (settled) {
          await Promise.all(t.plays)
          if (this.is("running") && !this.doorQueue.length) this.stop(turns >= max ? "turn limit" : "settled")
          else if (!this.is("ended")) { pending = Promise.resolve(Object.assign(t, { aborted: true })); continue }
          break
        }
        // One turn ahead at most: the next speaker writes while this one
        // talks, but not before this one has started.
        await Promise.race([t.started, this.poked()])
        if (!this.is("running") || this.doorQueue.length) { pending = Promise.resolve(Object.assign(t, { aborted: true })); continue }
        who = 1 - who
        pending = this.generate(who, turns++, turns >= max)
      }
    } catch (e: any) {
      this.emit({ type: "error", error: String(e?.message ?? e) })
      this.stop("error")
    }
  }

  // --- internals ---

  /** Write speaker `who`'s next reply, queueing each sentence for speech. */
  private async generate(who: number, n: number, last: boolean): Promise<Turn> {
    const sp = this.opts.speakers[who]
    const signal = this.ac.signal
    let startedResolve!: () => void
    const t: Turn = { n, who, text: "", heard: [], plays: [], started: new Promise((r) => { startedResolve = r }), aborted: false }
    const say = (raw: string) => {
      const text = speakable(raw.replace(DONE, ""))
      if (!text || signal.aborted) return
      const firstLine = !t.plays.length
      const p = this.opts.speech.say({ voice: sp.voice, text, onStart: firstLine ? () => this.turnStarted(t, startedResolve) : undefined })
      // Lines play strictly in order, so the last one to finish marks where
      // the next speaker's gap starts.
      t.plays.push(p.then((ok) => { if (ok) { t.heard.push(text); this.lastEndAt = Date.now() } return ok }))
    }
    if (last) this.inbox[who].push("This is the last turn: wrap up in a sentence or two and end with DONE.")
    const message = this.inbox[who].join("\n")
    this.inbox[who] = []
    const cutter = new SentenceCutter()
    for await (const d of this.models[who].reply(message, signal)) {
      t.text += d
      for (const s of cutter.push(d)) say(s)
    }
    if (signal.aborted) { t.aborted = true; startedResolve(); return t }
    for (const s of cutter.flush()) say(s)
    if (!t.plays.length) startedResolve()
    const line = speakable(t.text.replace(DONE, ""))
    t.entry = { name: sp.name, text: line }
    t.relayed = `${sp.name} said: ${line}`
    this.transcript.push(t.entry)
    this.inbox[1 - who].push(t.relayed)
    this.emit({ type: "line", turn: n, agentId: sp.agentId, name: sp.name, text: line })
    return t
  }

  private turnStarted(t: Turn, resolve: () => void): void {
    if (this.doorAt) {
      this.emit({ type: "answered", turn: t.n, ms: Date.now() - this.doorAt })
      this.doorAt = 0
    } else if (this.lastEndAt && t.n > 0) {
      const ms = Date.now() - this.lastEndAt
      this.gaps.push(ms)
      this.emit({ type: "gap", turn: t.n, ms })
    }
    this.playing = t
    resolve()
  }

  /** Wait out a hush, then tell both speakers what was actually heard and
   *  what the listener said. Returns who speaks next. */
  private async afterInterruption(pending: Turn): Promise<number> {
    const deadline = Date.now() + (this.opts.holdMs ?? 20_000)
    while (this.state === "held" && Date.now() < deadline) {
      await Promise.race([this.poked(), new Promise((r) => setTimeout(r, deadline - Date.now()))])
    }
    if (this.state === "ended") return pending.who
    this.state = "running"
    this.lastEndAt = 0
    const cut = this.playing ?? pending
    const notes: string[] = []
    for (const t of new Set([cut, pending])) {
      await Promise.allSettled(t.plays)
      const name = this.opts.speakers[t.who].name
      const heard = t.heard.join(" ")
      // Undo what was never heard: the other speaker must not answer it.
      if (t.relayed) this.inbox[1 - t.who] = this.inbox[1 - t.who].filter((m) => m !== t.relayed)
      if (t.entry) {
        if (heard) t.entry.text = `${heard} —`
        else if (this.transcript.includes(t.entry)) this.transcript.splice(this.transcript.indexOf(t.entry), 1)
      }
      if (heard && t.heard.length < t.plays.length) notes.push(`(${name} was cut off after saying: "${heard}")`)
      else if (!heard && (t.text || t.aborted)) notes.push(`(${name}'s last line was not heard.)`)
    }
    this.playing = null
    const said = this.doorQueue.splice(0).join(" / ")
    notes.push(said ? `${this.listener} just said: "${said}". Answer ${this.listener} first.` : "(There was a pause. Carry on.)")
    this.inbox[0].push(...notes)
    this.inbox[1].push(...notes)
    const named = this.opts.speakers.findIndex((s) => said && new RegExp(`\\b${escapeRe(s.name)}\\b`, "i").test(said))
    return named >= 0 ? named : cut.who
  }

  /** Stop speech and cancel the reply being written. */
  private silence(): void {
    this.opts.speech.stop()
    this.ac.abort()
    this.ac = new AbortController()
  }

  /** Read through a call: the state changes across awaits, which
   *  TypeScript's narrowing cannot see. */
  private is(state: Talk["state"]): boolean { return this.state === state }

  private poke(): void { const w = this.wake; this.wake = null; w?.() }
  private poked(): Promise<void> { return new Promise((r) => { this.wake = r }) }

  private emit(e: TalkEvent): void {
    for (const fn of this.listeners) { try { fn(e) } catch { /* a listener must not break the talk */ } }
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
