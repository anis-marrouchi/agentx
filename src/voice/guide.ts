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

export interface GuideCommand {
  /** Grows with every command, so a waiting app knows a new one. */
  seq: number
  agentId: string | null
  /** Accessibility coordinates: from the top-left of the primary display.
   *  Null sends the character back to where it rests. */
  rect: Rect | null
  mark: GuideMark
}

/** How long after its last wait ended the app still counts as there:
 *  the gap between one wait and the next. */
const GAP_MS = 5_000
/** A wait is answered within this, command or not, so a dead socket is noticed. */
export const GUIDE_WAIT_MS = 25_000
/** `agentx point` leaves the character at its target this long, unless told otherwise. */
export const GUIDE_HOLD = { default: 8, max: 120 } as const

export class GuideFeed {
  private cmd: GuideCommand = { seq: 0, agentId: null, rect: null, mark: "none" }
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
   *  itself after that long, unless a newer command came. */
  show(agentId: string | null, rect: Rect, mark: GuideMark = "box", holdSeconds?: number): GuideCommand {
    const cmd = this.push({ agentId, rect, mark })
    if (holdSeconds !== undefined) {
      this.holdTimer = setTimeout(() => { if (this.cmd.seq === cmd.seq) this.home(agentId) }, holdSeconds * 1000)
      this.holdTimer.unref?.()
    }
    return cmd
  }

  /** Back to where it rests, its mark gone. */
  home(agentId: string | null = null): GuideCommand {
    if (!this.cmd.rect) return this.cmd
    return this.push({ agentId, rect: null, mark: "none" })
  }

  /** The command after `after`: at once when there is one, else when one
   *  comes, else the current one after `waitMs`. An `after` ahead of the
   *  feed is from before a daemon restart and gets the current one. */
  next(after: number, waitMs = GUIDE_WAIT_MS): Promise<GuideCommand> {
    this.waitedAt = this.now()
    if (after !== this.cmd.seq) return Promise.resolve(this.cmd)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        this.waitedAt = this.now()
        resolve(this.cmd)
      }
      const timer = setTimeout(done, waitMs)
      timer.unref?.()
      this.waiters.add(done)
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
