// --- One live connection for the whole app (#2218 condition C3) ---
//
// The daemon pushes the live snapshot on `/api/live/stream` (event
// `snapshot`, every 2 s). The app opens that stream once, however many
// parts read it, and writes each snapshot into the query cache under
// LIVE_KEY, so a component reads live data with useQuery like any other.
//
// A dropped connection (daemon restart, Wi-Fi) is reopened after 2 s, 5 s,
// 10 s, then every 30 s, the same waits as the old Hub (#2101 R21), and the
// state is shown ("Reconnecting…") rather than hidden. No page reload.

import type { QueryClient } from "@tanstack/react-query"

export const LIVE_KEY = ["live"] as const
export const LIVE_STREAM_URL = "/api/live/stream"
export const LIVE_RETRY_MS = [2000, 5000, 10000, 30000]
/** How long the stream stays open after the last reader leaves, so moving
 *  between two live pages does not drop and reopen it. */
export const LIVE_LINGER_MS = 5000

export type LiveState = "idle" | "connecting" | "open" | "reconnecting"

export interface LiveStatus {
  state: LiveState
  /** Snapshots received since the app started. */
  snapshots: number
  /** When the last snapshot came, ms since epoch; 0 before the first. */
  lastAt: number
  /** Times the connection was reopened after a drop. */
  reconnects: number
}

/** The part of EventSource this file uses, so tests can pass a fake. */
export interface SourceLike {
  addEventListener(type: string, fn: (ev: any) => void): void
  close(): void
}

export interface LiveStreamOpts {
  client: Pick<QueryClient, "setQueryData">
  url?: string
  open?: (url: string) => SourceLike
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
}

export class LiveStream {
  private source: SourceLike | null = null
  private readers = 0
  private retry = 0
  private retryTimer: unknown = null
  private lingerTimer: unknown = null
  private wasDropped = false
  private status: LiveStatus = { state: "idle", snapshots: 0, lastAt: 0, reconnects: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly url: string
  private readonly openSource: (url: string) => SourceLike
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (t: unknown) => void
  private readonly now: () => number

  constructor(private readonly opts: LiveStreamOpts) {
    this.url = opts.url ?? LIVE_STREAM_URL
    this.openSource = opts.open ?? ((u) => new EventSource(u, { withCredentials: true }))
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as any))
    this.now = opts.now ?? Date.now
  }

  /** A part starts reading. Returns the call that stops it. */
  acquire(): () => void {
    this.readers++
    if (this.lingerTimer != null) { this.clearTimer(this.lingerTimer); this.lingerTimer = null }
    if (!this.source && this.retryTimer == null) this.connect()
    let released = false
    return () => {
      if (released) return
      released = true
      this.readers--
      if (this.readers === 0) this.lingerTimer = this.setTimer(() => { this.lingerTimer = null; if (this.readers === 0) this.stop() }, LIVE_LINGER_MS)
    }
  }

  getStatus = (): LiveStatus => this.status
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private set(patch: Partial<LiveStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const fn of this.listeners) fn()
  }

  private connect(): void {
    if (this.status.state !== "reconnecting") this.set({ state: "connecting" })
    let src: SourceLike
    try { src = this.openSource(this.url) } catch { this.dropped(); return }
    this.source = src
    src.addEventListener("snapshot", (ev: { data: string }) => {
      if (this.source !== src) return
      let data: unknown
      try { data = JSON.parse(ev.data) } catch { return }
      this.opts.client.setQueryData(LIVE_KEY, data)
      this.retry = 0
      const back = this.wasDropped
      this.wasDropped = false
      this.set({
        state: "open",
        snapshots: this.status.snapshots + 1,
        lastAt: this.now(),
        reconnects: this.status.reconnects + (back ? 1 : 0),
      })
    })
    src.addEventListener("error", (ev: { data?: unknown }) => {
      // The server's own `event: error` (one snapshot failed) carries data
      // and the stream goes on; only a dropped connection has none.
      if (ev && ev.data != null) return
      if (this.source !== src) return
      this.dropped()
    })
  }

  private dropped(): void {
    if (this.source) { try { this.source.close() } catch { /* already closed */ } }
    this.source = null
    this.wasDropped = true
    this.set({ state: "reconnecting" })
    if (this.retryTimer != null) this.clearTimer(this.retryTimer)
    const wait = LIVE_RETRY_MS[Math.min(this.retry, LIVE_RETRY_MS.length - 1)]
    this.retry++
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; if (this.readers > 0) this.connect() }, wait)
  }

  private stop(): void {
    if (this.retryTimer != null) { this.clearTimer(this.retryTimer); this.retryTimer = null }
    if (this.source) { try { this.source.close() } catch { /* already closed */ } }
    this.source = null
    this.retry = 0
    this.wasDropped = false
    this.set({ state: "idle" })
  }
}
