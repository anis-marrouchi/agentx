import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs"
import { resolve } from "path"
import type { ChannelAdapter, SeededMessage } from "@/channels/types"
import { debug } from "@/observability/debug"

// --- Conversation session store ---
// One session per agent + channel + chatId + day.
// For claude-code tier: stores the Claude session ID so we can --resume it.
// For other tiers: stores message history as text, prepended to each prompt.

export interface SessionMessage {
  role: "user" | "agent"
  name?: string        // sender name or agent name
  content: string
  timestamp: string
  /** True when this message was injected by SessionStore.seedFromAdapter()
   *  reading the live channel on cold session create — never via the inbound
   *  router pipeline. Marked so observers can distinguish seeded turns from
   *  live ones; the model sees them identically in buildHistoryContext. */
  seeded?: boolean
  /** Channel-side message id (Telegram update_id, GitLab note id, WhatsApp
   *  key.id). Used to dedup re-seeds — if a message with this externalId is
   *  already in the session, appendSeededMessages skips it. */
  externalId?: string
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

/** Long-memory cues — phrases that imply the user is referencing something
 *  beyond the current claude session window. Used by the registry to
 *  pre-fetch a wider /recall window before the agent runs, so it doesn't
 *  have to ask "when?" or guess. Returns the inferred lookback in days, or
 *  0 when no long-memory cue is present (default short-memory regime). */
const LONG_MEMORY_PATTERNS: Array<{ re: RegExp; days: number }> = [
  // Days-scale (~1 day)
  { re: /\byesterday\b/i, days: 2 },
  { re: /\bأمس\b/, days: 2 },
  // Days-scale (~3 days)
  { re: /\bcouple (?:of )?days\b/i, days: 4 },
  { re: /\bfew days\b/i, days: 4 },
  // Week-scale (~7 days)
  { re: /\blast week\b/i, days: 8 },
  { re: /\bالأسبوع الماضي\b/, days: 8 },
  { re: /\bweek ago\b/i, days: 8 },
  // Generic "remember/previously/we discussed" — moderate look-back
  { re: /\bremember\b/i, days: 3 },
  { re: /\bpreviously\b/i, days: 3 },
  { re: /\bwe (?:discussed|talked|agreed|decided)\b/i, days: 3 },
  { re: /\bas (?:i|we) (?:said|told|mentioned)\b/i, days: 3 },
  { re: /\bcontinue from\b/i, days: 3 },
  { re: /\bتذكر\b/, days: 3 },
]

export function detectLongMemoryHint(message: string): { lookbackDays: number } | null {
  if (!message) return null
  let max = 0
  for (const p of LONG_MEMORY_PATTERNS) {
    if (p.re.test(message)) max = Math.max(max, p.days)
  }
  return max > 0 ? { lookbackDays: max } : null
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
  /** Resolves a channel name to its adapter — installed by the daemon after
   *  channels are registered (see daemon/index.ts after router.register). The
   *  cold-create branch consults it to call adapter.seedHistory(). Optional;
   *  when unset, seeding is a no-op (back-compat for tests, CLI tools, and
   *  any caller that constructs SessionStore standalone). */
  private adapterResolver?: (channel: string) => ChannelAdapter | undefined
  /** In-flight seed promises keyed by sessionKey. Coalesces concurrent
   *  cold-creates against the same (agent, channel, chatId, day) so we hit
   *  the channel API exactly once per fresh session. */
  private seedingPromises: Map<string, Promise<void>> = new Map()

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

  /** Install the channel-adapter resolver. Called once at daemon startup
   *  after MessageRouter has registered every adapter. Hot-reload of channel
   *  adapters re-uses the same router, so the resolver stays valid across
   *  /reload cycles without re-installation. */
  setAdapterResolver(fn: (channel: string) => ChannelAdapter | undefined): void {
    this.adapterResolver = fn
  }

  /** Seed a fresh session from the live channel before any user/agent
   *  messages get appended. No-op when:
   *    - the session already has messages (warm cache or partially loaded)
   *    - no adapter resolver is installed
   *    - the channel adapter has no seedHistory method
   *  Concurrent calls against the same key share one in-flight promise so
   *  the channel API is hit exactly once per cold create. Errors are
   *  swallowed — a seeding failure should never block a turn. */
  async seedIfEmpty(agentId: string, channel: string, chatId: string): Promise<void> {
    if (!this.adapterResolver) return
    const key = this.sessionKey(agentId, channel, chatId)
    const inFlight = this.seedingPromises.get(key)
    if (inFlight) return inFlight

    const session = this.getSession(agentId, channel, chatId)
    if (session.messages.length > 0) return

    const adapter = this.adapterResolver(channel)
    if (!adapter?.seedHistory) return

    const promise = (async () => {
      try {
        const seeds = await adapter.seedHistory!(chatId, {
          maxMessages: MAX_MESSAGES,
          maxChars: MAX_HISTORY_CHARS,
        })
        if (seeds.length > 0) this.appendSeededMessages(session, seeds)
      } catch {
        // best-effort
      }
    })()
    this.seedingPromises.set(key, promise)
    try {
      await promise
    } finally {
      this.seedingPromises.delete(key)
    }
  }

  /** Append seeded messages to a session in chronological order, deduping
   *  by externalId against anything already present. Marks each entry with
   *  `seeded: true` so observers can distinguish them; the model's prompt
   *  (buildHistoryContext) renders them identically to live turns. */
  private appendSeededMessages(session: Session, seeds: SeededMessage[]): void {
    if (seeds.length === 0) return
    const existingIds = new Set<string>()
    for (const m of session.messages) {
      if (m.externalId) existingIds.add(m.externalId)
    }
    let appended = 0
    for (const s of seeds) {
      if (s.externalId && existingIds.has(s.externalId)) continue
      session.messages.push({
        role: s.role,
        name: s.name,
        content: s.content,
        timestamp: s.timestamp,
        seeded: true,
        externalId: s.externalId,
      })
      appended++
    }
    if (appended === 0) return
    this.trim(session)
    session.updatedAt = new Date().toISOString()
    this.save(session)
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
   * Recall conversation turns across multiple stored sessions for an agent.
   *
   * Used by the `/recall` HTTP endpoint and the [Conversation Recall] skill —
   * when an agent receives a message that references prior context (anaphora,
   * "as discussed", "correct me if I'm wrong"), it can call this to fetch
   * the actual prior turns rather than guessing or running cold-start tool
   * calls. Read-only; no side effects.
   *
   * Pagination: cursor by timestamp, descending (newest first). Pass the
   * previous response's `oldestTs` as `before` to walk further back.
   *
   * Scoping: required `agentId`. `channel`/`chatId` narrow to a specific
   * thread; omit them to recall across all of this agent's conversations.
   * The store is per-agent on disk so we never leak another agent's chats.
   */
  recallTurns(opts: {
    agentId: string
    channel?: string
    chatId?: string
    before?: string
    after?: string
    /** Convenience override for `after`: number of days back from now. */
    lookbackDays?: number
    limit?: number
    query?: string
    participants?: string[]
  }): {
    turns: Array<{
      ts: string
      role: "user" | "agent"
      senderName: string
      content: string
      channel: string
      chatId: string
      day: string
      sessionFile: string
    }>
    oldestTs: string | null
    hasMore: boolean
    totalScanned: number
  } {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
    // Default window: TODAY (UTC). Per the short-vs-long-memory split, most
    // recall calls are about "what did we just say" — capping the window to
    // today keeps the result tight and noise-free. Caller widens explicitly
    // when the user message signals long memory ("yesterday", "last week",
    // "remember when…") via `lookbackDays` or an explicit `after`.
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const defaultAfter =
      typeof opts.lookbackDays === "number" && opts.lookbackDays > 0
        ? new Date(Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000).toISOString()
        : todayStart.toISOString()
    const after = opts.after ?? defaultAfter
    const before = opts.before ?? new Date(Date.now() + 1000).toISOString()

    const safeAgentId = opts.agentId.replace(/[^a-zA-Z0-9_:-]/g, "_")
    let allFiles: string[]
    try {
      allFiles = readdirSync(this.sessionsDir).filter(f =>
        f.startsWith(`${safeAgentId}:`) && f.endsWith(".json"),
      )
    } catch {
      return { turns: [], oldestTs: null, hasMore: false, totalScanned: 0 }
    }

    // Day-level prefilter via the trailing `:YYYY-MM-DD.json` segment so we
    // don't open/parse files outside the requested window.
    const afterDay = after.slice(0, 10)
    const beforeDay = before.slice(0, 10)
    const dayRe = /:(\d{4}-\d{2}-\d{2})\.json$/
    const candidateFiles = allFiles.filter(f => {
      const m = f.match(dayRe)
      if (!m) return false
      const day = m[1]
      return day >= afterDay && day <= beforeDay
    })

    type CollectedTurn = {
      ts: string
      role: "user" | "agent"
      senderName: string
      content: string
      channel: string
      chatId: string
      day: string
      sessionFile: string
    }
    const collected: CollectedTurn[] = []
    let totalScanned = 0
    const queryLower = opts.query?.toLowerCase()
    const participantSet = opts.participants?.length ? new Set(opts.participants) : undefined

    for (const file of candidateFiles) {
      let data: Session
      try {
        data = JSON.parse(readFileSync(resolve(this.sessionsDir, file), "utf-8")) as Session
      } catch {
        continue
      }
      if (data.agentId !== opts.agentId) continue
      if (opts.channel && data.channel !== opts.channel) continue
      if (opts.chatId && data.chatId !== opts.chatId) continue

      for (const msg of data.messages) {
        totalScanned++
        if (!msg.timestamp || msg.timestamp < after || msg.timestamp >= before) continue
        if (participantSet && msg.role === "user" && !participantSet.has(msg.name ?? "")) continue
        if (queryLower && !msg.content.toLowerCase().includes(queryLower)) continue
        collected.push({
          ts: msg.timestamp,
          role: msg.role,
          senderName: msg.name ?? "",
          content: msg.content,
          channel: data.channel,
          chatId: data.chatId,
          day: data.day,
          sessionFile: file,
        })
      }
    }

    collected.sort((a, b) => b.ts.localeCompare(a.ts))

    const page = collected.slice(0, limit)
    const oldestTs = page.length > 0 ? page[page.length - 1].ts : null
    const hasMore = collected.length > limit

    return { turns: page, oldestTs, hasMore, totalScanned }
  }

  /** Cross-agent view of a chat. Aggregates session messages from EVERY
   *  agent that has a session for `(channel, chatId)` in the requested
   *  window, sorts oldest-first, and dedups exact (timestamp, role, name,
   *  content) collisions (which happen when two agents in the same group
   *  both record the same inbound).
   *
   *  Differs from recallTurns in two ways:
   *    1. Not scoped to one agentId — answers "what's in this chat across
   *       all agents", which is the question the cx→devops→marketing thread
   *       on 2026-04-29 needed and didn't have.
   *    2. Returns oldest-first so the caller reads it like a transcript;
   *       recallTurns returns newest-first because it paginates.
   *
   *  Bounded by the same MAX_MESSAGES default as buildHistoryContext so
   *  callers don't accidentally pull a 5000-turn group into one prompt. */
  recentByChatId(opts: {
    channel: string
    chatId: string
    sinceISO?: string
    limit?: number
  }): Array<{
    ts: string
    role: "user" | "agent"
    senderName: string
    content: string
    agentId: string
    sessionFile: string
  }> {
    const limit = Math.min(Math.max(opts.limit ?? MAX_MESSAGES, 1), 200)
    // Default window: last 24h. Wider than recallTurns' "today only" because
    // the typical use is "what was just said" — covers overnight gaps that
    // span midnight UTC.
    const sinceISO = opts.sinceISO ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const sinceDay = sinceISO.slice(0, 10)

    let allFiles: string[]
    try {
      allFiles = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"))
    } catch {
      return []
    }

    // The session-file naming convention is `{agentId}:{channel}:{chatId}:{day}.json`.
    // Build a substring key that captures channel+chatId; the agentId prefix
    // and day suffix vary so we filter those after parse. Note `chatId` may
    // itself contain colons (GitLab chatIds look like "group/project:issue:123"),
    // so we can't naively split on ":". Cheap pre-filter: must contain
    // `:${channel}:${chatId}:` as a substring.
    const key = `:${opts.channel}:${opts.chatId}:`
    const candidates = allFiles.filter((f) => {
      if (!f.includes(key)) return false
      // Day suffix prefilter — skip files whose day is older than sinceDay.
      const m = f.match(/:(\d{4}-\d{2}-\d{2})\.json$/)
      if (!m) return false
      return m[1] >= sinceDay
    })

    type Row = {
      ts: string
      role: "user" | "agent"
      senderName: string
      content: string
      agentId: string
      sessionFile: string
    }
    const rows: Row[] = []
    for (const file of candidates) {
      let data: Session
      try {
        data = JSON.parse(readFileSync(resolve(this.sessionsDir, file), "utf-8")) as Session
      } catch {
        continue
      }
      // Defensive re-check after parse — substring match could collide with
      // an agent whose id literally contains ":telegram:1816212449:".
      if (data.channel !== opts.channel || data.chatId !== opts.chatId) continue

      for (const msg of data.messages) {
        if (!msg.timestamp || msg.timestamp < sinceISO) continue
        rows.push({
          ts: msg.timestamp,
          role: msg.role,
          senderName: msg.name ?? "",
          content: msg.content,
          agentId: data.agentId,
          sessionFile: file,
        })
      }
    }

    // Dedup exact collisions across agents (same inbound recorded by two
    // agents in the same group). Key on (ts, role, name, content).
    const seen = new Set<string>()
    const dedupped: Row[] = []
    for (const r of rows) {
      const k = `${r.ts}|${r.role}|${r.senderName}|${r.content}`
      if (seen.has(k)) continue
      seen.add(k)
      dedupped.push(r)
    }

    dedupped.sort((a, b) => a.ts.localeCompare(b.ts))
    // Take the most recent `limit` (last entries when sorted oldest-first).
    return dedupped.slice(-limit)
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
    const beforeCount = session.messages.length
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

    // Surface silent drops under `--debug context`. Without this, a long
    // chat that rolls past the 30-message / 12K-char caps quietly loses
    // older turns and the operator has no signal — exactly the failure
    // mode that disguises itself as "agent forgot" amnesia.
    const dropped = beforeCount - session.messages.length
    if (dropped > 0) {
      debug.cat(
        "context",
        `[${session.agentId}] ${session.channel}:${session.chatId} trim dropped ${dropped} message(s): ${beforeCount} -> ${session.messages.length} (${totalChars}c)`,
      )
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
