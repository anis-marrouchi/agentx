import type { DaemonConfig, AgentDef } from "@/daemon/config"
import { executeTask, type AgentTask, type AgentResponse, type StreamCallback, type AgentPeer } from "./runtime"
import { SessionStore } from "./sessions"
import { WikiHub } from "@/wiki"
import { RateLimiter } from "@/daemon/rate-limit"
import { TokenTracker } from "@/daemon/token-tracker"
import { buildAgentContext, type ContextInput } from "./context"
import { MemoryStore } from "./memory-store"
import { extractMemories } from "./memory-extract"
import type { LandscapeBuilder } from "./landscape"

// --- Agent Registry: lifecycle management + concurrency control ---

interface AgentState {
  id: string
  def: AgentDef
  activeTasks: number
  totalTasks: number
  lastActive?: Date
  errors: number
}

export class AgentRegistry {
  private agents: Map<string, AgentState> = new Map()
  private config: DaemonConfig
  private providers: Record<string, { apiKey?: string }> = {}
  private sessions: SessionStore
  private wikiHub: WikiHub
  private memoryStore: MemoryStore
  private rateLimiter: RateLimiter
  private tokenTracker: TokenTracker
  private landscape?: LandscapeBuilder
  private log: (...args: unknown[]) => void

  constructor(
    config: DaemonConfig,
    log: (...args: unknown[]) => void = console.error.bind(console, "[agents]"),
  ) {
    this.log = log
    this.config = config
    this.providers = config.providers
    this.sessions = new SessionStore()
    this.wikiHub = new WikiHub(undefined, undefined, "unified")
    this.memoryStore = new MemoryStore()
    this.rateLimiter = new RateLimiter()
    this.tokenTracker = new TokenTracker()

    for (const [id, def] of Object.entries(config.agents)) {
      this.agents.set(id, {
        id,
        def,
        activeTasks: 0,
        totalTasks: 0,
        errors: 0,
      })
    }
  }

  /**
   * Set landscape builder (called after mesh init).
   */
  setLandscape(builder: LandscapeBuilder): void {
    this.landscape = builder
  }

  /**
   * Get agent definition by ID.
   */
  getAgent(id: string): AgentDef | undefined {
    return this.agents.get(id)?.def
  }

  /**
   * Find agent by mention pattern (e.g., "@my_bot" -> "my-agent").
   * Returns the agent with the longest (most specific) mention match.
   */
  findByMention(text: string): string | undefined {
    const lower = text.toLowerCase()
    let bestId: string | undefined
    let bestLen = 0

    for (const [id, state] of this.agents) {
      for (const mention of state.def.mentions) {
        const mentionLower = mention.toLowerCase()
        if (lower.includes(mentionLower) && mentionLower.length > bestLen) {
          bestId = id
          bestLen = mentionLower.length
        }
      }
    }

    return bestId
  }

  /**
   * Find ALL agents mentioned in text (for bot-to-bot detection).
   */
  findAllMentioned(text: string): string[] {
    const lower = text.toLowerCase()
    const found: string[] = []

    for (const [id, state] of this.agents) {
      for (const mention of state.def.mentions) {
        if (lower.includes(mention.toLowerCase())) {
          found.push(id)
          break
        }
      }
    }

    return found
  }

  /** Wiki hub accessor. */
  getWikiHub(): WikiHub { return this.wikiHub }

  /**
   * Build peer list for context engine.
   */
  private buildPeerList(agentId: string, channel?: string): Array<{ name: string; handle?: string; role?: string }> {
    const peers: Array<{ name: string; handle?: string; role?: string }> = []
    for (const [id, state] of this.agents) {
      if (id === agentId) continue
      peers.push({
        name: state.def.name,
        handle: this.getChannelHandle(id, channel),
        role: state.def.systemPrompt?.split("\n")[0]?.slice(0, 80),
      })
    }
    return peers
  }

  /**
   * Get the primary channel handle for an agent (e.g. "@my_bot" on telegram).
   */
  private getChannelHandle(agentId: string, channel?: string): string | undefined {
    const agent = this.agents.get(agentId)?.def
    if (!agent) return undefined

    // For telegram, find the mention that starts with @ (bot username)
    if (channel === "telegram") {
      return agent.mentions.find((m) => m.startsWith("@"))
    }

    // Fallback: first mention
    return agent.mentions[0]
  }

  /**
   * Execute a task on an agent. Respects maxConcurrent limit.
   */
  async execute(task: AgentTask, onDelta?: StreamCallback): Promise<AgentResponse> {
    const state = this.agents.get(task.agentId)
    if (!state) {
      return { content: "", error: `Unknown agent: ${task.agentId}` }
    }

    if (state.activeTasks >= state.def.maxConcurrent) {
      return {
        content: "",
        error: `Agent "${task.agentId}" is busy (${state.activeTasks}/${state.def.maxConcurrent} tasks)`,
      }
    }

    // Rate limit check
    const rateCheck = this.rateLimiter.check(task.agentId)
    if (!rateCheck.allowed) {
      this.log(`[${task.agentId}] ${rateCheck.reason}`)
      return { content: "", error: rateCheck.reason }
    }

    state.activeTasks++
    state.totalTasks++
    state.lastActive = new Date()

    this.log(`[${task.agentId}] executing task (${state.activeTasks}/${state.def.maxConcurrent})`)

    // Build conversation history for session continuity
    const channel = task.context?.channel || "api"
    const chatId = task.context?.chatId || task.context?.group || task.context?.sender || "default"
    const senderName = task.context?.sender || "User"

    // Record user message in session
    this.sessions.addUserMessage(task.agentId, channel, chatId, senderName, task.message)

    // Build structured context — read from per-agent wiki
    const agentWiki = this.wikiHub.getAgentWiki(task.agentId)
    const wikiArticles = agentWiki.findRelevant(task.message, task.agentId, 3)
    const wikiContext = agentWiki.buildContext(wikiArticles)

    // Load persistent agent memory (cross-session facts)
    const relevantMemories = this.memoryStore.findRelevant(task.message, task.agentId, 8)
    const memoryContext = this.memoryStore.buildContext(relevantMemories)

    // Decide whether to resume or start fresh
    let resumeSessionId = state.def.tier === "claude-code"
      ? this.sessions.getClaudeSessionId(task.agentId, channel, chatId)
      : undefined

    // If session is stale (idle > 15min), start fresh with full context rebuild
    if (resumeSessionId && this.sessions.isSessionStale(task.agentId, channel, chatId)) {
      this.log(`[${task.agentId}] session stale for ${channel}:${chatId}, starting fresh`)
      this.sessions.clearClaudeSessionId(task.agentId, channel, chatId)
      resumeSessionId = undefined
    }

    const sessionHistory = !resumeSessionId
      ? this.sessions.buildHistoryContext(task.agentId, channel, chatId)
      : undefined

    // Bridge cross-chat amnesia: inject context from other chats (DM ↔ group)
    const crossChatContext = this.sessions.getCrossSessionSummary(task.agentId, channel, chatId)

    const contextInput: ContextInput = {
      channel,
      channelScope: task.context?.group ? "group" : (channel === "gitlab" ? "project" : "personal"),
      groupName: task.context?.group,
      agentId: task.agentId,
      agentName: state.def.name,
      agentHandle: this.getChannelHandle(task.agentId, channel),
      systemPrompt: state.def.systemPrompt,
      sender: senderName,
      landscape: this.landscape?.getForAgent(task.agentId),
      channelMeta: task.context?.channelMeta,
      mediaPath: task.context?.mediaPath,
      mediaType: task.context?.mediaType,
      replyToText: task.context?.replyToText,
      groupHistory: task.context?.group ? undefined : undefined, // group log is injected by router
      sessionHistory,
      memoryContext: memoryContext || undefined,
      crossChatContext: crossChatContext || undefined,
      wikiContext,
      message: task.message,
    }

    const historyContext = buildAgentContext(contextInput)

    try {
      const response = await executeTask(state.def, task, this.providers, onDelta, historyContext, resumeSessionId)

      if (response.error) {
        state.errors++
        this.log(`[${task.agentId}] error: ${response.error}`)
      } else {
        // Record agent response in session
        this.sessions.addAgentMessage(task.agentId, channel, chatId, response.content)

        // Store Claude session ID for future --resume
        if (response.claudeSessionId) {
          this.sessions.setClaudeSessionId(task.agentId, channel, chatId, response.claudeSessionId)
        }

        // Wiki: export conversation as raw entry for later absorption
        if (response.content.length > 50) {
          try {
            const entryId = `${task.agentId}-${Date.now().toString(36)}`
            this.wikiHub.getSharedStore().addEntry({
              id: entryId,
              date: new Date().toISOString().slice(0, 10),
              agentId: task.agentId,
              source: channel,
              sourceContext: task.context?.group || task.context?.sender,
              content: `User: ${task.message}\n\nAgent: ${response.content}`,
            })
          } catch {
            // Wiki export is best-effort
          }

          // Memory: extract and store memorable facts via Haiku (fire-and-forget)
          extractMemories(
            task.agentId,
            task.message,
            response.content,
            { channel, chatId, sender: senderName },
            this.memoryStore,
          ).catch(() => {})
        }

        // Track token usage (real counts if available, estimate otherwise)
        this.tokenTracker.record(
          task.agentId,
          response.duration || 0,
          response.usage,
          task.message.length,
          response.content.length,
          false,
          state.def.model,
        )

        this.log(
          `[${task.agentId}] completed in ${response.duration}ms` +
            (response.tokensUsed ? ` (${response.tokensUsed} tokens)` : ""),
        )
      }

      return response
    } catch (error: any) {
      state.errors++
      this.log(`[${task.agentId}] unexpected error: ${error.message}`)
      return { content: "", error: error.message }
    } finally {
      state.activeTasks--
    }
  }

  /**
   * List all agents and their status.
   */
  list(): Array<{
    id: string
    name: string
    tier: string
    workspace: string
    active: number
    total: number
    errors: number
    lastActive?: Date
  }> {
    return Array.from(this.agents.values()).map((s) => ({
      id: s.id,
      name: s.def.name,
      tier: s.def.tier,
      workspace: s.def.workspace,
      active: s.activeTasks,
      total: s.totalTasks,
      errors: s.errors,
      lastActive: s.lastActive,
    }))
  }

  /**
   * Get token usage summary.
   */
  getUsage(days: number = 7) {
    return this.tokenTracker.summary(days)
  }

  /**
   * Get today's usage.
   */
  getTodayUsage() {
    return this.tokenTracker.today()
  }

  /**
   * Get the token tracker instance (for daemon hooks).
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker
  }
}
