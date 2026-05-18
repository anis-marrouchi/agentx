// --- Message Queue with Modes ---
//
// Handles messages arriving while an agent is busy processing.
// Prevents duplicate runs, lost messages, and race conditions.
//
// Modes:
//   collect  — batch messages arriving during a run, deliver all at once when done
//   followup — queue each message as a separate follow-up turn after current run
//   drop     — silently discard messages while busy (for non-critical channels)

export type QueueMode = "collect" | "followup" | "drop"

export interface QueuedMessage {
  text: string
  sender: string
  timestamp: number
  channel: string
  chatId: string
  /** Full context from the original message, preserved for re-routing */
  originalContext?: Record<string, unknown>
}

interface SessionQueue {
  mode: QueueMode
  /** Messages waiting to be processed */
  pending: QueuedMessage[]
  /** Whether an agent run is currently in progress for this session */
  running: boolean
  /** Callback to invoke when a queued message should be processed */
  onFlush?: (messages: QueuedMessage[]) => Promise<void>
}

/**
 * Per-agent, per-session message queue.
 * Keyed by `agentId:channel:chatId`.
 */
export class MessageQueue {
  private queues: Map<string, SessionQueue> = new Map()
  private defaultMode: QueueMode

  constructor(defaultMode: QueueMode = "collect") {
    this.defaultMode = defaultMode
  }

  private key(agentId: string, channel: string, chatId: string): string {
    return `${agentId}:${channel}:${chatId}`
  }

  private getOrCreate(agentId: string, channel: string, chatId: string): SessionQueue {
    const k = this.key(agentId, channel, chatId)
    if (!this.queues.has(k)) {
      this.queues.set(k, {
        mode: this.defaultMode,
        pending: [],
        running: false,
      })
    }
    return this.queues.get(k)!
  }

  /**
   * Set the queue mode for a specific session.
   */
  setMode(agentId: string, channel: string, chatId: string, mode: QueueMode): void {
    this.getOrCreate(agentId, channel, chatId).mode = mode
  }

  /**
   * Register a flush callback for when queued messages should be processed.
   */
  onFlush(
    agentId: string,
    channel: string,
    chatId: string,
    callback: (messages: QueuedMessage[]) => Promise<void>,
  ): void {
    this.getOrCreate(agentId, channel, chatId).onFlush = callback
  }

  /**
   * Check if an agent is currently busy for a given session.
   */
  isBusy(agentId: string, channel: string, chatId: string): boolean {
    return this.getOrCreate(agentId, channel, chatId).running
  }

  /**
   * Mark the start of an agent run. Returns false if already running.
   */
  markRunning(agentId: string, channel: string, chatId: string): boolean {
    const q = this.getOrCreate(agentId, channel, chatId)
    if (q.running) return false
    q.running = true
    return true
  }

  /**
   * Enqueue a message that arrived while the agent is busy.
   * Returns the queue mode applied (or null if not busy and no queueing needed).
   */
  enqueue(
    agentId: string,
    channel: string,
    chatId: string,
    message: QueuedMessage,
  ): QueueMode | null {
    const q = this.getOrCreate(agentId, channel, chatId)

    if (!q.running) return null // Not busy, process normally

    switch (q.mode) {
      case "drop":
        return "drop"

      case "collect":
      case "followup":
        q.pending.push(message)
        return q.mode
    }
  }

  /**
   * Mark the end of an agent run. Flushes pending messages based on mode.
   * Returns messages to process (if any).
   */
  async markDone(
    agentId: string,
    channel: string,
    chatId: string,
  ): Promise<QueuedMessage[]> {
    const q = this.getOrCreate(agentId, channel, chatId)
    q.running = false

    if (q.pending.length === 0) return []

    const messages = [...q.pending]
    q.pending = []

    switch (q.mode) {
      case "collect": {
        // Batch all pending messages into a single combined message. The
        // `[sender, HH:MM]:` prefix only helps disambiguate multi-message
        // batches (e.g. several group-chat users speaking while the agent
        // is busy); for a single queued message the prefix turned out to
        // be actively harmful — agents read "[dashboard, 19:03]: ..." as
        // a non-human source and got suspicious. Strip it in that case.
        const combinedText = messages.length === 1
          ? messages[0].text
          : messages.map((m) =>
              `[${m.sender}, ${new Date(m.timestamp).toISOString().slice(11, 16)}]: ${m.text}`
            ).join("\n")
        const combined: QueuedMessage = {
          text: combinedText,
          sender: messages[messages.length - 1].sender,
          timestamp: Date.now(),
          channel: messages[0].channel,
          chatId: messages[0].chatId,
          originalContext: messages[messages.length - 1].originalContext,
        }

        // Fire flush callback with combined message
        if (q.onFlush) {
          await q.onFlush([combined])
        }
        return [combined]
      }

      case "followup":
        // Process each message as a separate follow-up turn
        if (q.onFlush) {
          await q.onFlush(messages)
        }
        return messages

      case "drop":
        return []

      default:
        return messages
    }
  }

  /**
   * Get the number of pending messages for a session.
   */
  pendingCount(agentId: string, channel: string, chatId: string): number {
    return this.getOrCreate(agentId, channel, chatId).pending.length
  }

  /**
   * Clear all queued messages for a session (e.g., on session reset).
   */
  clear(agentId: string, channel: string, chatId: string): void {
    const k = this.key(agentId, channel, chatId)
    this.queues.delete(k)
  }

  /**
   * Get queue stats for monitoring.
   */
  stats(): Array<{ key: string; mode: QueueMode; pending: number; running: boolean }> {
    return Array.from(this.queues.entries()).map(([key, q]) => ({
      key,
      mode: q.mode,
      pending: q.pending.length,
      running: q.running,
    }))
  }
}
