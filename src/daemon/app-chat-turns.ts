import type { ServerResponse } from "http"
import type { AppToolBadge } from "./app-chat-store"

// --- Phone app chat: turns that outlive the phone's connection ---
//
// On a phone, a locked screen or a lost signal is normal, so a turn must
// not depend on the phone staying connected. The dashboard's relay keeps
// reading the daemon's stream to the end and saves the answer; the phone
// can attach again (GET /api/app/chat/attach) and pick the stream up from
// what was written so far. Only Stop, or a phone away for longer than the
// orphan limit, drops the relay, which interrupts the run upstream.

/** How long a turn may keep running with no phone attached. */
export const ORPHAN_LIMIT_MS = 30 * 60_000

type Listener = (event: string, data: unknown) => void

export class ChatTurn {
  readonly ac = new AbortController()
  /** What the agent has written so far, for a phone that attaches late. */
  text = ""
  tools: AppToolBadge[] = []
  /** Set when the orphan limit ended the turn. */
  orphaned = false
  private listeners = new Map<Listener, ServerResponse>()
  private orphanTimer: ReturnType<typeof setTimeout> | null = null
  private done = false

  constructor(private orphanLimitMs: number) {}

  /** Hands one upstream event to every attached phone. */
  broadcast(event: string, data: any): void {
    if (event === "text" && typeof data?.text === "string") this.text += data.text
    if (event === "tool" && data?.status === "start" && this.tools.length < 50) {
      this.tools.push({ name: String(data.name || "tool"), ...(data.arg ? { arg: String(data.arg) } : {}) })
    }
    for (const l of this.listeners.keys()) l(event, data)
  }

  /** Streams this turn to `res` until it ends or the phone goes away. */
  attach(res: ServerResponse): void {
    const open = () => !res.writableEnded && !res.destroyed
    const listener: Listener = (event, data) => { if (open()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    const heartbeat = setInterval(() => { if (open()) res.write(": ping\n\n") }, 15_000)
    heartbeat.unref?.()
    this.listeners.set(listener, res)
    if (this.orphanTimer) { clearTimeout(this.orphanTimer); this.orphanTimer = null }
    res.on("close", () => {
      clearInterval(heartbeat)
      this.listeners.delete(listener)
      // The phone left: the turn goes on, but not forever.
      if (!this.done && !this.listeners.size && !this.ac.signal.aborted && !this.orphanTimer) {
        this.orphanTimer = setTimeout(() => { this.orphaned = true; this.ac.abort() }, this.orphanLimitMs)
        this.orphanTimer.unref?.()
      }
    })
  }

  /** Ends every attached stream once the turn is saved. */
  finish(): void {
    this.done = true
    if (this.orphanTimer) clearTimeout(this.orphanTimer)
    for (const res of this.listeners.values()) if (!res.writableEnded) res.end()
    this.listeners.clear()
  }
}
