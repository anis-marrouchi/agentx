// --- Keep the latest frame, hand one over now and then ---
//
// A camera sends 10 to 30 frames a second; an agent looks at one. The
// sampler keeps only the newest frame in memory. `take()` gives it on
// demand ("look now"). With an interval, `onSample` gets the newest frame
// every so often, and only when a new one arrived since the last sample:
// a frozen camera does not keep an agent busy. One sample runs at a time;
// a slow `onSample` skips ticks rather than piling up.

export interface Sampled<T> {
  frame: T
  /** When this frame arrived, ms since the epoch. */
  receivedAt: number
  /** Frames received so far, this one included. */
  seq: number
}

export interface FrameSamplerOptions<T> {
  /** 0 turns interval sampling off: frames are taken on demand only. */
  intervalMs: number
  onSample?: (s: Sampled<T>) => void | Promise<void>
  now?: () => number
  log?: (m: string) => void
}

export class FrameSampler<T> {
  private latest: Sampled<T> | null = null
  private count = 0
  private lastSampledSeq = 0
  private timer?: ReturnType<typeof setInterval>
  private busy = false
  private stopped = false

  constructor(private opts: FrameSamplerOptions<T>) {}

  private now(): number { return this.opts.now?.() ?? Date.now() }

  /** A frame arrived. Only this one is kept. */
  push(frame: T): void {
    if (this.stopped) return
    this.count++
    this.latest = { frame, receivedAt: this.now(), seq: this.count }
  }

  /** The newest frame, or null before the first one. Taking it does not
   *  consume it: two looks in a row see the same frame until a new one
   *  arrives. */
  take(): Sampled<T> | null {
    return this.latest
  }

  /** Frames received so far. */
  get received(): number { return this.count }

  /** Start the interval, when there is one. Safe to call once. */
  start(): void {
    if (this.timer || this.stopped || !(this.opts.intervalMs > 0) || !this.opts.onSample) return
    this.timer = setInterval(() => { void this.tick() }, this.opts.intervalMs)
    this.timer.unref?.()
  }

  /** Change the interval while running: 0 turns it off, a positive value
   *  (re)starts it. A watch uses it for a short continuous look. */
  retime(intervalMs: number): void {
    if (this.stopped) return
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.opts.intervalMs = intervalMs
    this.start()
  }

  /** The interval now in force, 0 when off. */
  get intervalMs(): number { return this.timer ? this.opts.intervalMs : 0 }

  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return
    const latest = this.latest
    if (!latest || latest.seq === this.lastSampledSeq) return
    this.lastSampledSeq = latest.seq
    this.busy = true
    try {
      await this.opts.onSample?.(latest)
    } catch (e: any) {
      this.opts.log?.(`[camera] sample ${latest.seq} failed: ${e?.message ?? e}`)
    } finally {
      this.busy = false
    }
  }

  /** Drop the frame and the timer. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.latest = null
  }
}
