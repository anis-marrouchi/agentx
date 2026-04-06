// --- Rate limiter for agent tasks ---
// Prevents message floods from exhausting Claude API/subscription.
// Per-agent, sliding window.

export class RateLimiter {
  private windows: Map<string, number[]> = new Map()
  private maxPerMinute: number
  private maxPerHour: number

  constructor(maxPerMinute: number = 10, maxPerHour: number = 100) {
    this.maxPerMinute = maxPerMinute
    this.maxPerHour = maxPerHour
  }

  /**
   * Check if an agent can process a task. Returns true if allowed.
   */
  check(agentId: string): { allowed: boolean; reason?: string } {
    const now = Date.now()
    const timestamps = this.windows.get(agentId) || []

    // Clean old entries (older than 1 hour)
    const hourAgo = now - 3600_000
    const recent = timestamps.filter(t => t > hourAgo)

    // Check per-minute
    const minuteAgo = now - 60_000
    const lastMinute = recent.filter(t => t > minuteAgo).length
    if (lastMinute >= this.maxPerMinute) {
      return { allowed: false, reason: `Rate limit: ${lastMinute}/${this.maxPerMinute} per minute` }
    }

    // Check per-hour
    if (recent.length >= this.maxPerHour) {
      return { allowed: false, reason: `Rate limit: ${recent.length}/${this.maxPerHour} per hour` }
    }

    // Record this request
    recent.push(now)
    this.windows.set(agentId, recent)

    return { allowed: true }
  }

  /**
   * Get current usage for an agent.
   */
  usage(agentId: string): { lastMinute: number; lastHour: number } {
    const now = Date.now()
    const timestamps = this.windows.get(agentId) || []
    return {
      lastMinute: timestamps.filter(t => t > now - 60_000).length,
      lastHour: timestamps.filter(t => t > now - 3600_000).length,
    }
  }
}
