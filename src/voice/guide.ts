// --- Guiding: the answering agent sends the character to something (#482) ---
//
// With `voice.look` "character", AgentX Voice draws the agent as a small
// creature. An agent that wants to show something sends a rectangle
// here; the app, which waits on next(), flies the character beside it
// and marks it. Nothing is clicked and the person's pointer is never
// moved: the character and its mark are drawn on the app's own layer.
//
// One command at a time, the newest: there is one character on screen.

import type { Presence, Rect } from "./presence"

export const GUIDE_MARKS = ["box", "circle", "underline", "none"] as const
export type GuideMark = (typeof GUIDE_MARKS)[number]

/** The states the character can be asked to show (#570): the nine of its
 *  pose sheet, by the names AgentX Voice knows them (CharacterMath.Mood). */
export const GUIDE_EXPRESSIONS = ["idle", "notices", "listening", "working", "speaking", "understood", "dozing", "calling", "asking"] as const
export type GuideExpression = (typeof GUIDE_EXPRESSIONS)[number]

export interface GuideCommand {
  /** Grows with every command, so a waiting app knows a new one. */
  seq: number
  agentId: string | null
  /** Accessibility coordinates: from the top-left of the primary display.
   *  Null sends the character back to where it rests. */
  rect: Rect | null
  mark: GuideMark
  /** What its bubble says while it stands there (#562). Null: no bubble. */
  text: string | null
  /** The state it shows meanwhile, in place of what the assistant is
   *  doing (#570). Null: its real state. */
  expression: GuideExpression | null
}

/** How long after its last wait ended the app still counts as there:
 *  the gap between one wait and the next. */
const GAP_MS = 5_000
/** A wait is answered within this, command or not, so a dead socket is noticed. */
export const GUIDE_WAIT_MS = 25_000
/** `agentx point` leaves the character at its target this long, unless told otherwise. */
export const GUIDE_HOLD = { default: 8, max: 120 } as const
/** The most its bubble says at a stop: one line of the pill, or two scrolled. */
export const GUIDE_TEXT_MAX = 120

/** A caption as the bubble shows it: one line, cut at the most; null when empty. */
export function guideText(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return null
  return line.length > GUIDE_TEXT_MAX ? `${line.slice(0, GUIDE_TEXT_MAX - 1).trimEnd()}…` : line
}

/** Added to a voice turn's system text while the character is on
 *  screen: the answering agent decides when to send it. */
export const GUIDE_INSTRUCTION =
  "[ON SCREEN] The listener sees you as a small character on their Mac. When pointing at something on " +
  "their screen would help, run `agentx point \"<the control or text, in a few words>\" --mark circle` " +
  "(or box, underline) before you answer: the character flies there and marks it. Add " +
  "`--text \"<a few words>\"` to have its bubble say why. It only points and never clicks. Do it when showing helps, not on every answer."

export class GuideFeed {
  private cmd: GuideCommand = { seq: 0, agentId: null, rect: null, mark: "none", text: null, expression: null }
  private waiters = new Set<() => void>()
  private waitedAt = -Infinity
  private holdTimer: NodeJS.Timeout | null = null

  constructor(private now: () => number = Date.now) {}

  /** The app is waiting for commands: the character is on screen. */
  get listening(): boolean {
    return this.waiters.size > 0 || this.now() - this.waitedAt < GAP_MS
  }

  get current(): GuideCommand { return this.cmd }

  /** Send the character to `rect`. With `holdSeconds` it goes home by
   *  itself after that long, unless a newer command came. Its bubble
   *  says `text` and it shows `expression` while it stands there. */
  show(agentId: string | null, rect: Rect, mark: GuideMark = "box", holdSeconds?: number, text: string | null = null,
       expression: GuideExpression | null = null): GuideCommand {
    return this.held(this.push({ agentId, rect, mark, text, expression }), holdSeconds)
  }

  /** Show `expression` where it rests (#570), for `holdSeconds`; then its
   *  real state again, unless a newer command came. */
  express(agentId: string | null, expression: GuideExpression, holdSeconds: number): GuideCommand {
    return this.held(this.push({ agentId, rect: null, mark: "none", text: null, expression }), holdSeconds)
  }

  /** Back to where it rests, its mark and its expression gone. */
  home(agentId: string | null = null): GuideCommand {
    if (!this.cmd.rect && !this.cmd.expression) return this.cmd
    return this.push({ agentId, rect: null, mark: "none", text: null, expression: null })
  }

  private held(cmd: GuideCommand, seconds?: number): GuideCommand {
    if (seconds !== undefined) {
      this.holdTimer = setTimeout(() => { if (this.cmd.seq === cmd.seq) this.home(cmd.agentId) }, seconds * 1000)
      this.holdTimer.unref?.()
    }
    return cmd
  }

  /** The command after `after`: at once when there is one, else when one
   *  comes, else the current one after `waitMs`. An `after` ahead of the
   *  feed is from before a daemon restart and gets the current one.
   *  `gone` ends a wait whose app went away: it no longer counts as there. */
  next(after: number, waitMs = GUIDE_WAIT_MS, gone?: AbortSignal): Promise<GuideCommand> {
    this.waitedAt = this.now()
    if (after !== this.cmd.seq) return Promise.resolve(this.cmd)
    return new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve(this.cmd)
      }
      const done = () => {
        this.waitedAt = this.now()
        end()
      }
      const timer = setTimeout(done, waitMs)
      timer.unref?.()
      this.waiters.add(done)
      gone?.addEventListener("abort", end, { once: true })
    })
  }

  private push(c: Omit<GuideCommand, "seq">): GuideCommand {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null }
    this.cmd = { seq: this.cmd.seq + 1, ...c }
    for (const wake of [...this.waiters]) wake()
    return this.cmd
  }
}

/** A lesson's pointer when the character is on screen: the character
 *  itself goes to each step's control, in place of the drawn cursor. The
 *  spoken line is already in its bubble, so say() adds nothing. */
export class CharacterPresence implements Presence {
  private at: Rect | null = null
  private closed = false

  constructor(private feed: GuideFeed, private agentId: string) {}

  /** False once the app has stopped waiting: the lesson draws a cursor instead. */
  get alive(): boolean { return !this.closed && this.feed.listening }

  moveTo(rect: Rect, opts: { highlight?: boolean } = {}): void {
    if (this.closed) return
    this.at = rect
    this.feed.show(this.agentId, rect, opts.highlight ? "box" : "none")
  }
  say(): void {}
  clear(): void {
    if (!this.closed && this.at) this.feed.show(this.agentId, this.at, "none")
  }
  park(): void {
    if (this.closed) return
    this.at = null
    this.feed.home(this.agentId)
  }
  close(): void {
    this.park()
    this.closed = true
  }
}
