import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs"
import { resolve } from "path"

// --- Conversation session store ---
// One session per agent + channel + chatId + day.
// For claude-code tier: stores the Claude session ID so we can --resume it.
// For other tiers: stores message history as text, prepended to each prompt.

export interface SessionMessage {
  role: "user" | "agent"
  name?: string        // sender name or agent name
  content: string
  timestamp: string
}

export interface Session {
  id: string
  agentId: string
  channel: string
  chatId: string
  day: string          // YYYY-MM-DD
  claudeSessionId?: string  // Claude Code native session ID (for --resume)
  messages: SessionMessage[]
  createdAt: string
  updatedAt: string
}

const MAX_HISTORY_CHARS = 12000  // Keep last ~12k chars of history to fit in context
const MAX_MESSAGES = 30          // Keep last 30 messages max
const STALE_SESSION_MINUTES = 15 // Resume sessions idle for less than this; rebuild if older

/** Session has a compacted summary prepended to its messages */
const COMPACTION_MARKER = "[Compacted conversation summary"

export class SessionStore {
  private sessionsDir: string
  private cache: Map<string, Session> = new Map()

  constructor(baseDir: string = process.cwd()) {
    this.sessionsDir = resolve(baseDir, ".agentx/sessions")
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true })
    }
  }

  /**
   * Build a deterministic session key.
   */
  private sessionKey(agentId: string, channel: string, chatId: string): string {
    const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    return `${agentId}:${channel}:${chatId}:${day}`
  }

  private sessionFile(key: string): string {
    // Sanitize key for filesystem
    const safe = key.replace(/[^a-zA-Z0-9_:-]/g, "_")
    return resolve(this.sessionsDir, `${safe}.json`)
  }

  /**
   * Get or create a session for this agent+channel+chat+day.
   */
  getSession(agentId: string, channel: string, chatId: string): Session {
    const key = this.sessionKey(agentId, channel, chatId)

    // Check cache
    if (this.cache.has(key)) {
      return this.cache.get(key)!
    }

    // Try loading from disk
    const file = this.sessionFile(key)
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf-8")) as Session
        this.cache.set(key, data)
        return data
      } catch {
        // Corrupted file — start fresh
      }
    }

    // Create new session
    const day = new Date().toISOString().slice(0, 10)
    const session: Session = {
      id: key,
      agentId,
      channel,
      chatId,
      day,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    this.cache.set(key, session)
    this.save(session)
    return session
  }

  /**
   * Add a user message to the session.
   */
  addUserMessage(agentId: string, channel: string, chatId: string, senderName: string, content: string): void {
    const session = this.getSession(agentId, channel, chatId)
    session.messages.push({
      role: "user",
      name: senderName,
      content,
      timestamp: new Date().toISOString(),
    })
    this.trim(session)
    session.updatedAt = new Date().toISOString()
    this.save(session)
  }

  /**
   * Add an agent response to the session.
   */
  addAgentMessage(agentId: string, channel: string, chatId: string, content: string): void {
    const session = this.getSession(agentId, channel, chatId)
    session.messages.push({
      role: "agent",
      name: agentId,
      content,
      timestamp: new Date().toISOString(),
    })
    this.trim(session)
    session.updatedAt = new Date().toISOString()
    this.save(session)
  }

  /**
   * Get the Claude Code session ID for this conversation (for --resume).
   * Returns undefined if no session yet (first message of the day).
   */
  getClaudeSessionId(agentId: string, channel: string, chatId: string): string | undefined {
    const session = this.getSession(agentId, channel, chatId)
    return session.claudeSessionId
  }

  /**
   * Store the Claude Code session ID after first invocation.
   */
  setClaudeSessionId(agentId: string, channel: string, chatId: string, claudeSessionId: string): void {
    const session = this.getSession(agentId, channel, chatId)
    session.claudeSessionId = claudeSessionId
    session.updatedAt = new Date().toISOString()
    this.save(session)
  }

  /**
   * Build conversation history string to prepend to the prompt.
   * Returns empty string if no history.
   * Used for non-claude-code tiers that don't have native sessions.
   */
  buildHistoryContext(agentId: string, channel: string, chatId: string): string {
    const session = this.getSession(agentId, channel, chatId)
    if (session.messages.length === 0) return ""

    const lines: string[] = [
      `[Conversation history for today (${session.day})]`,
    ]

    for (const msg of session.messages) {
      const time = msg.timestamp.slice(11, 16) // HH:MM
      if (msg.role === "user") {
        lines.push(`[${time}] ${msg.name || "User"}: ${msg.content}`)
      } else {
        lines.push(`[${time}] ${msg.name || "Agent"}: ${msg.content}`)
      }
    }

    lines.push("[End of history — respond to the latest message above]")
    lines.push("")

    return lines.join("\n")
  }

  /**
   * Check if a Claude session is stale (idle too long for --resume to be useful).
   * When stale, the resumed context will be too far behind — better to start fresh.
   */
  isSessionStale(agentId: string, channel: string, chatId: string): boolean {
    const session = this.getSession(agentId, channel, chatId)
    if (!session.claudeSessionId) return false
    const elapsed = Date.now() - new Date(session.updatedAt).getTime()
    return elapsed > STALE_SESSION_MINUTES * 60 * 1000
  }

  /**
   * Build a summary of recent messages from OTHER sessions for the same agent today.
   * This bridges the cross-chat amnesia gap — if someone shared info in a DM,
   * the group session gets a hint about it.
   */
  getCrossSessionSummary(agentId: string, channel: string, chatId: string): string {
    const day = new Date().toISOString().slice(0, 10)
    const currentKey = this.sessionKey(agentId, channel, chatId)

    try {
      const files = readdirSync(this.sessionsDir).filter(f =>
        f.startsWith(agentId.replace(/[^a-zA-Z0-9_:-]/g, "_")) &&
        f.includes(day) &&
        f.endsWith(".json")
      )

      const hints: string[] = []

      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(resolve(this.sessionsDir, file), "utf-8")) as Session
          if (data.id === currentKey) continue // skip own session
          if (data.messages.length === 0) continue

          // Take the last few messages as a hint
          const recent = data.messages.slice(-4)
          const isDM = !data.chatId.startsWith("-") && /^\d+$/.test(data.chatId)
          const scope = isDM ? "DM" : data.chatId
          const lines = recent.map(m => {
            const time = m.timestamp.slice(11, 16)
            return `  [${time}] ${m.name || m.role}: ${m.content.slice(0, 200)}`
          })
          hints.push(`From ${scope} (${data.channel}):\n${lines.join("\n")}`)
        } catch {
          // Skip corrupted files
        }
      }

      if (hints.length === 0) return ""

      return [
        "[Cross-chat context — recent activity from your other conversations today]",
        ...hints,
        "[End cross-chat context — the user in THIS chat may be referring to actions from above]",
        "",
      ].join("\n")
    } catch {
      return ""
    }
  }

  /**
   * Check if session history needs compaction and compact if so.
   * Call this after adding messages. Returns true if compaction was performed.
   */
  async compactIfNeeded(
    agentId: string,
    channel: string,
    chatId: string,
    memoryStore?: import("./memory-store").MemoryStore,
  ): Promise<boolean> {
    const session = this.getSession(agentId, channel, chatId)
    const { needsCompaction, compactSession, applyCompaction } = await import("./compaction")

    if (!needsCompaction(session.messages)) return false

    const result = await compactSession(session.messages, agentId, memoryStore)
    if (result.compactedCount === 0) return false

    session.messages = applyCompaction(session.messages, result)
    session.updatedAt = new Date().toISOString()

    // Clear Claude session ID — the compacted context needs a fresh session
    delete session.claudeSessionId

    this.save(session)
    return true
  }

  /**
   * Check if current session already has a compacted summary.
   */
  hasCompaction(agentId: string, channel: string, chatId: string): boolean {
    const session = this.getSession(agentId, channel, chatId)
    return session.messages.length > 0 &&
      session.messages[0].content.startsWith(COMPACTION_MARKER)
  }

  /**
   * Clear the stored Claude session ID so next invocation starts fresh.
   */
  clearClaudeSessionId(agentId: string, channel: string, chatId: string): void {
    const session = this.getSession(agentId, channel, chatId)
    delete session.claudeSessionId
    session.updatedAt = new Date().toISOString()
    this.save(session)
  }

  /**
   * Trim session to stay within limits.
   */
  private trim(session: Session): void {
    // Trim by message count
    if (session.messages.length > MAX_MESSAGES) {
      session.messages = session.messages.slice(-MAX_MESSAGES)
    }

    // Trim by total character count
    let totalChars = session.messages.reduce((sum, m) => sum + m.content.length, 0)
    while (totalChars > MAX_HISTORY_CHARS && session.messages.length > 2) {
      const removed = session.messages.shift()!
      totalChars -= removed.content.length
    }
  }

  private save(session: Session): void {
    try {
      const file = this.sessionFile(session.id)
      writeFileSync(file, JSON.stringify(session, null, 2))
    } catch {
      // Best-effort persistence
    }
  }
}
