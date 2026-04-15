// --- Smart Block Streaming ---
//
// Intelligent chunking for channel message delivery.
// Instead of sending raw text deltas, accumulates text and emits
// well-formed blocks that respect markdown structure.
//
// Features:
//   - minChars: don't emit until enough content (avoids fragment spam)
//   - Paragraph-aware breaks: prefer splitting at \n\n boundaries
//   - Code fence protection: never split inside ```...``` blocks
//   - Coalescing: merge rapid consecutive blocks via idle debounce
//   - Human-like pacing: optional randomized delay between blocks

export interface BlockStreamConfig {
  /** Minimum characters before emitting a block (default: 80) */
  minChars: number
  /** Maximum characters per block (default: 4000) */
  maxChars: number
  /** Idle time (ms) before flushing partial content (default: 2000) */
  idleFlushMs: number
  /** Minimum time between emissions (ms) (default: 1500) */
  minIntervalMs: number
  /** Whether to add human-like random delay (default: false) */
  humanPacing: boolean
}

const DEFAULT_CONFIG: BlockStreamConfig = {
  minChars: 80,
  maxChars: 4000,
  idleFlushMs: 2000,
  minIntervalMs: 1500,
  humanPacing: false,
}

/** Per-channel default overrides */
export const CHANNEL_DEFAULTS: Record<string, Partial<BlockStreamConfig>> = {
  telegram: { minChars: 60, maxChars: 4096, minIntervalMs: 1500 },
  whatsapp: { minChars: 40, maxChars: 3000, minIntervalMs: 2000, humanPacing: true },
  discord: { minChars: 80, maxChars: 2000, minIntervalMs: 1000 },
  gitlab: { minChars: 200, maxChars: 60000, minIntervalMs: 3000 },
}

export type BlockEmitter = (block: string) => void | Promise<void>

/**
 * Smart block streamer that accumulates text deltas and emits
 * well-formed blocks respecting markdown structure.
 */
export class BlockStream {
  private config: BlockStreamConfig
  private buffer = ""
  private emitter: BlockEmitter
  private lastEmitTime = 0
  private idleTimer?: ReturnType<typeof setTimeout>
  private insideCodeFence = false
  private fencePattern = /^```/
  /**
   * Serialized chain of pending emissions. Each emit appends to this chain so
   * emissions run in order, and `flush()` can `await` the tail to guarantee
   * all emissions have completed before the caller proceeds — critical to
   * avoid the router racing to send a final message while a flushed-but-not-
   * yet-executed first emission is still queued (which would produce two
   * separate outbound messages instead of one send + subsequent edits).
   */
  private lastEmission: Promise<void> = Promise.resolve()

  constructor(emitter: BlockEmitter, config?: Partial<BlockStreamConfig>, channel?: string) {
    const channelDefaults = channel ? CHANNEL_DEFAULTS[channel] : {}
    this.config = { ...DEFAULT_CONFIG, ...channelDefaults, ...config }
    this.emitter = emitter
  }

  /**
   * Feed a text delta into the stream.
   */
  push(delta: string): void {
    this.buffer += delta

    // Reset idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }

    // Track code fence state
    this.updateCodeFenceState(delta)

    // Check if we should emit
    if (this.shouldEmit()) {
      this.emit()
    } else {
      // Set idle flush timer
      this.idleTimer = setTimeout(() => {
        if (this.buffer.length > 0) {
          this.emit()
        }
      }, this.config.idleFlushMs)
    }
  }

  /**
   * Flush any remaining content (call when stream ends). Awaits all pending
   * emissions so the caller can safely inspect state (e.g. whether a message
   * was already sent) immediately after flush() returns.
   */
  async flush(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    if (this.buffer.length > 0) {
      this.emitImmediate(this.buffer)
      this.buffer = ""
    }
    await this.lastEmission
  }

  /**
   * Get the full accumulated text so far (buffer + already emitted).
   */
  get pendingLength(): number {
    return this.buffer.length
  }

  private shouldEmit(): boolean {
    // Don't emit if inside a code fence (wait for it to close)
    if (this.insideCodeFence) return false

    // Don't emit below minimum chars
    if (this.buffer.length < this.config.minChars) return false

    // Respect minimum interval
    const elapsed = Date.now() - this.lastEmitTime
    if (elapsed < this.config.minIntervalMs) return false

    // Emit if we have a good break point
    return this.findBreakPoint() > 0
  }

  private emit(): void {
    const breakPoint = this.findBreakPoint()
    if (breakPoint <= 0 && this.buffer.length < this.config.maxChars) return

    const cutAt = breakPoint > 0
      ? breakPoint
      : Math.min(this.buffer.length, this.config.maxChars)

    const block = this.buffer.slice(0, cutAt)
    this.buffer = this.buffer.slice(cutAt)

    if (this.config.humanPacing) {
      const delay = 800 + Math.random() * 1700 // 800-2500ms
      setTimeout(() => this.emitImmediate(block), delay)
    } else {
      this.emitImmediate(block)
    }
  }

  private emitImmediate(block: string): void {
    this.lastEmitTime = Date.now()
    // Append to the serialized chain so emissions run in order and flush()
    // can await the tail. Swallow per-emission errors — streaming is
    // best-effort and must not break the chain for subsequent blocks.
    this.lastEmission = this.lastEmission.then(() =>
      Promise.resolve()
        .then(() => this.emitter(block))
        .catch(() => { /* best-effort */ })
    )
  }

  /**
   * Find the best point to break the buffer.
   * Priority: paragraph > newline > sentence > word.
   * Returns -1 if no good break found.
   */
  private findBreakPoint(): number {
    const buf = this.buffer
    const max = Math.min(buf.length, this.config.maxChars)

    // 1. Paragraph break (\n\n)
    const paraIdx = buf.lastIndexOf("\n\n", max)
    if (paraIdx >= this.config.minChars) return paraIdx + 2

    // 2. Single newline
    const nlIdx = buf.lastIndexOf("\n", max)
    if (nlIdx >= this.config.minChars) return nlIdx + 1

    // 3. Sentence end (. ! ? followed by space)
    for (let i = max - 1; i >= this.config.minChars; i--) {
      if ((buf[i] === "." || buf[i] === "!" || buf[i] === "?") &&
          (i + 1 >= buf.length || buf[i + 1] === " " || buf[i + 1] === "\n")) {
        return i + 1
      }
    }

    // 4. Hard cap
    if (buf.length >= this.config.maxChars) {
      // Find nearest word break
      const spaceIdx = buf.lastIndexOf(" ", max)
      if (spaceIdx >= this.config.minChars) return spaceIdx + 1
      return max
    }

    return -1
  }

  /**
   * Track whether we're inside a code fence.
   * Don't break inside fences to keep markdown valid.
   */
  private updateCodeFenceState(delta: string): void {
    const lines = delta.split("\n")
    for (const line of lines) {
      if (this.fencePattern.test(line.trim())) {
        this.insideCodeFence = !this.insideCodeFence
      }
    }
  }
}
