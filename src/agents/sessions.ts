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
  /** Number of completed turns on the current claudeSessionId. Resets to 0
   *  when the session is rotated (cleared). Used to bound --resume growth:
   *  Claude CLI replays the entire prior session on every turn, so long
   *  sessions pay a linearly growing cache-read tax. */
  turnCount?: number
  /** Total billable input of the LAST turn on this claudeSessionId
   *  (inputTokens + cacheReadTokens + cacheCreateTokens). Used to detect
   *  tier-2 hits (>200K) from the prior turn so we can rotate before the
   *  next turn pays the 1.5× multiplier again. */
  lastTurnInputTokens?: number
}

const MAX_HISTORY_CHARS = 12000  // Keep last ~12k chars of history to fit in context
const MAX_MESSAGES = 30          // Keep last 30 messages max
/** Default stale timeout. Overridable via SessionStore options so each node
 *  can trade cache-hit ratio (long timeout → prompt cache survives work
 *  pauses) against "fresh context" (short timeout → new session rebuilds the
 *  prompt from scratch). Agents on Opus pay ~$0.50 cache-create per task,
 *  so the higher the timeout, the less often that cost recurs. 45 min keeps
 *  cache warm for an active conversation but stops an all-day chat from
 *  snowballing a single Claude CLI session into 500K+ tokens of replay. */
const DEFAULT_STALE_SESSION_MINUTES = 45
/** Default hard cap on turns per Claude session. Claude CLI `--resume`
 *  replays the entire prior session (every tool result, every file read)
 *  on each turn, so cache-read grows linearly. 15 turns keeps the replay
 *  under ~200K for most agents; rotate after that and seed the next
 *  session from the compacted summary + recent-messages history. */
const DEFAULT_MAX_TURNS_PER_SESSION = 15
/** Default tier-2 trigger. Claude bills tier-2 (1.5× rate) when a single
 *  request's total input exceeds 200K. Rotating at 180K leaves headroom
 *  for the next turn's additions before we re-enter the multiplier. */
const DEFAULT_TIER_TWO_THRESHOLD_TOKENS = 180_000

/** Session has a compacted summary prepended to its messages */
const COMPACTION_MARKER = "[Compacted conversation summary"

/** Keywords that suggest the current message references another chat, an
 *  earlier conversation, or a peer agent — and therefore benefits from the
 *  cross-chat summary. Tuned for English + Arabic (Tunisian team usage);
 *  extend as needed. Matched case-insensitively against raw substrings so
 *  "mentioned" also catches "mention", "mentioning", etc. */
const CROSS_CHAT_HINT_PATTERNS: RegExp[] = [
  // English — temporal/conversational references
  /\bearlier\b/i, /\bbefore\b/i, /\bjust said\b/i, /\btold (?:me|you|us|him|her|them)\b/i,
  /\bmention(?:ed|ing)?\b/i, /\bask(?:ed)? (?:me|you|him|her|them|about)\b/i,
  /\bping(?:ed)?\b/i, /\bdm\b/i, /\bdirect message\b/i,
  // Explicit cross-chat references
  /\bother (?:chat|group|conversation|thread)\b/i, /\bthat (?:chat|group|conversation|thread)\b/i,
  /\bsame (?:issue|thread|conversation)\b/i, /\bcontinuing\b/i,
  // Bot mention — @something_bot / @handle (peer agent reference)
  /@\w{2,}_?(?:bot|agent)\b/i,
  // Arabic — conversational refs the team actually uses
  /قلت/, /قال(?:لك|لي|له|لها|لنا)?/, /قبل/, /الحين/, /الثاني/, /المجموعة/,
]

export function referencesOtherChat(message: string): boolean {
  if (!message) return false
  return CROSS_CHAT_HINT_PATTERNS.some((re) => re.test(message))
}

/** True when appending `(role, name, content)` would duplicate the last
 *  message in `messages`. Used to collapse retries and double-sends at
 *  insert time, so dedup is stable across reload (duplicates never reach
 *  disk in the first place). */
function isDuplicateOfLast(
  messages: SessionMessage[],
  role: "user" | "agent",
  name: string,
  content: string,
): boolean {
  if (messages.length === 0) return false
  const last = messages[messages.length - 1]
  return last.role === role && (last.name ?? "") === name && last.content === content
}

/** Bucket an ISO timestamp into a stable 15-min window label (e.g. "14:45").
 *  Used in history rendering so the prompt's bucket headers change at most
 *  every 15 minutes — the prefix stays byte-stable across intra-bucket
 *  messages and the server-side prompt cache is preserved. */
function bucketLabel(iso: string): string {
  const m = iso.slice(11, 16) // HH:MM
  const hh = m.slice(0, 2)
  const mm = parseInt(m.slice(3, 5), 10)
  if (Number.isNaN(mm)) return m
  const qtr = Math.floor(mm / 15) * 15
  return `${hh}:${qtr.toString().padStart(2, "0")}`
}

export class SessionStore {
  private sessionsDir: string
  private cache: Map<string, Session> = new Map()
  private staleMinutes: number
  private maxTurnsPerSession: number
  private tierTwoThresholdTokens: number

  constructor(
    baseDir: string = process.cwd(),
    opts: {
      staleMinutes?: number
      maxTurnsPerSession?: number
      tierTwoThresholdTokens?: number
    } = {},
  ) {
    this.sessionsDir = resolve(baseDir, ".agentx/sessions")
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true })
    }
    this.staleMinutes = Math.max(1, opts.staleMinutes ?? DEFAULT_STALE_SESSION_MINUTES)
    this.maxTurnsPerSession = Math.max(2, opts.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION)
    this.tierTwoThresholdTokens = Math.max(50_000, opts.tierTwoThresholdTokens ?? DEFAULT_TIER_TWO_THRESHOLD_TOKENS)
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
   * Add a user message to the session. Consecutive duplicates from the same
   * sender are collapsed — when a user re-sends the exact same text (retry,
   * accidental double-tap, telegram glitches), storing every copy bloats the
   * replayed history and re-burns tokens on every subsequent turn.
   */
  addUserMessage(agentId: string, channel: string, chatId: string, senderName: string, content: string): void {
    const session = this.getSession(agentId, channel, chatId)
    if (isDuplicateOfLast(session.messages, "user", senderName, content)) {
      return
    }
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
   * Add an agent response to the session. Same dedup rule as user messages —
   * retries and duplicate responses shouldn't be replayed on every turn.
   */
  addAgentMessage(agentId: string, channel: string, chatId: string, content: string): void {
    const session = this.getSession(agentId, channel, chatId)
    if (isDuplicateOfLast(session.messages, "agent", agentId, content)) {
      return
    }
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

    // Bucket messages into 15-min windows. Stamping every line with its own
    // HH:MM broke the server-side prompt cache every turn (each new message
    // adds a never-seen timestamp near the tail). A bucket header changes
    // only every 15 min, so most turns within the window preserve cache.
    let currentBucket = ""
    for (const msg of session.messages) {
      const bucket = bucketLabel(msg.timestamp)
      if (bucket !== currentBucket) {
        lines.push(`— ${bucket} —`)
        currentBucket = bucket
      }
      const name = msg.name || (msg.role === "user" ? "User" : "Agent")
      lines.push(`${name}: ${msg.content}`)
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
    return elapsed > this.staleMinutes * 60 * 1000
  }

  /**
   * Build a summary of recent messages from OTHER sessions for the same agent today.
   * This bridges the cross-chat amnesia gap — if someone shared info in a DM,
   * the group session gets a hint about it.
   *
   * Gated by `message`: cross-chat hints are expensive (up to ~1.5K tokens of
   * unrelated conversation) AND cache-breaking (the content changes as other
   * chats get traffic, invalidating the prompt cache every turn). We only
   * return hints when the current message actually references another
   * conversation or a peer agent. Pass `message = ""` to force-include
   * (legacy behavior) — useful for testing.
   */
  getCrossSessionSummary(
    agentId: string,
    channel: string,
    chatId: string,
    message?: string,
  ): string {
    if (message !== undefined && message !== "" && !referencesOtherChat(message)) {
      return ""
    }
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
  ): Promise<{ compacted: boolean; qualityScore?: number; lostEntities?: string[]; drift?: import("./drift-detection").DriftReport }> {
    const session = this.getSession(agentId, channel, chatId)
    const { needsCompaction, compactSession, applyCompaction } = await import("./compaction")

    if (!needsCompaction(session.messages)) return { compacted: false }

    const result = await compactSession(session.messages, agentId, memoryStore)
    if (result.compactedCount === 0) return { compacted: false }

    session.messages = applyCompaction(session.messages, result)
    session.updatedAt = new Date().toISOString()

    // We deliberately KEEP claudeSessionId, turnCount, and lastTurnInputTokens.
    //
    // Why: AgentX's `session.messages` is a stored copy used to seed a fresh
    // Claude session whenever one legitimately rotates (tier-2, max-turns,
    // stale, restart). Claude's own session has its own copy of the
    // conversation that --resume replays — it doesn't read from
    // session.messages. So compacting our copy doesn't reduce what Claude
    // sees on resume; dropping claudeSessionId here was just paying a fresh
    // ~16K-token cache-create tax on the next call without any context
    // benefit. Particularly painful for bursty workloads (project-bot
    // queues) where each burst trips compaction and forces N cache rebuilds
    // per Max-plan window.
    //
    // The compacted summary gets used at the next legitimate rotation —
    // exactly when it matters. Until then, Claude keeps its hot session.

    this.save(session)
    return {
      compacted: true,
      qualityScore: result.qualityScore,
      lostEntities: result.lostEntities,
      drift: result.drift,
    }
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
   * Also resets the per-session turn counter and last-turn input size —
   * those are only meaningful relative to the current claudeSessionId.
   */
  clearClaudeSessionId(agentId: string, channel: string, chatId: string): void {
    const session = this.getSession(agentId, channel, chatId)
    delete session.claudeSessionId
    delete session.turnCount
    delete session.lastTurnInputTokens
    session.updatedAt = new Date().toISOString()
    this.save(session)
  }

  /**
   * Check whether this session has hit the max-turns cap. Rotate when true
   * to stop --resume replay from growing unbounded across a long chat.
   */
  shouldRotateByTurns(agentId: string, channel: string, chatId: string): boolean {
    const session = this.getSession(agentId, channel, chatId)
    if (!session.claudeSessionId) return false
    return (session.turnCount ?? 0) >= this.maxTurnsPerSession
  }

  /**
   * Check whether the LAST turn on this session pushed total input past
   * the tier-2 threshold. If yes, rotate so we don't pay the 1.5×
   * multiplier again on the next turn.
   */
  shouldRotateByTierTwo(agentId: string, channel: string, chatId: string): boolean {
    const session = this.getSession(agentId, channel, chatId)
    if (!session.claudeSessionId) return false
    return (session.lastTurnInputTokens ?? 0) >= this.tierTwoThresholdTokens
  }

  /**
   * Record a completed turn's token usage and bump the turn counter.
   * Called after a successful Claude response returns with usage info.
   */
  recordTurnUsage(
    agentId: string,
    channel: string,
    chatId: string,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
  ): void {
    const session = this.getSession(agentId, channel, chatId)
    session.turnCount = (session.turnCount ?? 0) + 1
    session.lastTurnInputTokens =
      (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheCreateTokens || 0)
    session.updatedAt = new Date().toISOString()
    this.save(session)
  }

  /** Diagnostic getters — used by registry logging. */
  getTurnCount(agentId: string, channel: string, chatId: string): number {
    return this.getSession(agentId, channel, chatId).turnCount ?? 0
  }
  getLastTurnInputTokens(agentId: string, channel: string, chatId: string): number {
    return this.getSession(agentId, channel, chatId).lastTurnInputTokens ?? 0
  }
  getMaxTurnsPerSession(): number { return this.maxTurnsPerSession }
  getTierTwoThresholdTokens(): number { return this.tierTwoThresholdTokens }

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
