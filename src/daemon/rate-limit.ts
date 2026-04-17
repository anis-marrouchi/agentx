// --- Rate limiter for agent tasks ---
// Prevents message floods from exhausting Claude API/subscription.
// Per-agent, sliding window. `acquire()` queues callers when the window is
// full instead of failing them outright — good for chatty channels where
// dropping a message would look like the bot is broken.

export class RateLimiter {
  private windows: Map<string, number[]> = new Map()
  private maxPerMinute: number
  private maxPerHour: number

  constructor(maxPerMinute: number = 10, maxPerHour: number = 100) {
    this.maxPerMinute = maxPerMinute
    this.maxPerHour = maxPerHour
  }

  /**
   * Check if an agent can process a task right now. Does NOT wait. Call
   * `acquire()` if you want queueing behaviour.
   */
  check(agentId: string): { allowed: boolean; reason?: string; waitMs?: number } {
    const now = Date.now()
    const timestamps = this.windows.get(agentId) || []

    // Clean old entries (older than 1 hour).
    const hourAgo = now - 3600_000
    const recent = timestamps.filter((t) => t > hourAgo)

    // Per-minute window.
    const minuteAgo = now - 60_000
    const inMinute = recent.filter((t) => t > minuteAgo)
    if (inMinute.length >= this.maxPerMinute) {
      const oldest = inMinute[0]
      const waitMs = Math.max(50, oldest + 60_000 - now)
      return {
        allowed: false,
        reason: `Rate limit: ${inMinute.length}/${this.maxPerMinute} per minute`,
        waitMs,
      }
    }

    // Per-hour window.
    if (recent.length >= this.maxPerHour) {
      const oldest = recent[0]
      const waitMs = Math.max(1000, oldest + 3600_000 - now)
      return {
        allowed: false,
        reason: `Rate limit: ${recent.length}/${this.maxPerHour} per hour`,
        waitMs,
      }
    }

    // Record this slot and allow.
    recent.push(now)
    this.windows.set(agentId, recent)
    return { allowed: true }
  }

  /**
   * Wait until a slot opens for this agent, then record + return ok. If the
   * caller exceeds `maxWaitMs`, give up with the last rate-limit reason. A
   * concurrent task that acquires a slot first will push THIS task's wake-up
   * further out — that's intended: FIFO-ish through the agent's normal
   * message queue, no starvation in practice.
   *
   * `onWait` fires once at the start of waiting so callers can surface the
   * "queued" state (logging, dashboard hint, etc).
   */
  async acquire(
    agentId: string,
    opts: { maxWaitMs?: number; onWait?: (reason: string, waitMs: number) => void } = {},
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000
    const deadline = Date.now() + maxWaitMs
    let firstWait = true

    while (true) {
      const r = this.check(agentId)
      if (r.allowed) return { ok: true }
      if (Date.now() >= deadline) {
        return { ok: false, reason: `${r.reason} (waited ${Math.round(maxWaitMs / 1000)}s, giving up)` }
      }
      if (firstWait) {
        firstWait = false
        opts.onWait?.(r.reason!, r.waitMs!)
      }
      // Cap the sleep so concurrent waiters re-check often enough to grab the
      // next slot in turn, rather than all firing at the same instant.
      const remaining = deadline - Date.now()
      const sleepMs = Math.min(r.waitMs ?? 1000, remaining, 5_000)
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }

  /**
   * Current usage for an agent — used by the dashboard and `agentx usage`.
   */
  usage(agentId: string): { lastMinute: number; lastHour: number } {
    const now = Date.now()
    const timestamps = this.windows.get(agentId) || []
    return {
      lastMinute: timestamps.filter((t) => t > now - 60_000).length,
      lastHour: timestamps.filter((t) => t > now - 3600_000).length,
    }
  }
}
