import type { DaemonConfig, AgentDef } from "@/daemon/config"
import { executeTask, type AgentTask, type AgentResponse, type StreamCallback, type AgentPeer } from "./runtime"
import { SessionStore } from "./sessions"
import { WikiStore } from "@/wiki"

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
  private wiki: WikiStore
  private log: (...args: unknown[]) => void

  constructor(
    config: DaemonConfig,
    log: (...args: unknown[]) => void = console.error.bind(console, "[agents]"),
  ) {
    this.log = log
    this.config = config
    this.providers = config.providers
    this.sessions = new SessionStore()
    this.wiki = new WikiStore()

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
   * Get agent definition by ID.
   */
  getAgent(id: string): AgentDef | undefined {
    return this.agents.get(id)?.def
  }

  /**
   * Find agent by mention pattern (e.g., "@nadia" -> "marketing-agent").
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

  /**
   * Get the primary channel handle for an agent (e.g. "@noqta_devops_bot" on telegram).
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
   * Enrich the task context with peer roster and channel handles.
   */
  private enrichTaskContext(task: AgentTask): AgentTask {
    const channel = task.context?.channel

    // Build peer list (all agents except self)
    const peers: AgentPeer[] = []
    for (const [id, state] of this.agents) {
      if (id === task.agentId) continue
      peers.push({
        id,
        name: state.def.name,
        handle: this.getChannelHandle(id, channel),
        role: state.def.systemPrompt?.split("\n")[0]?.slice(0, 100),
      })
    }

    // Get own handle
    const myHandle = this.getChannelHandle(task.agentId, channel)

    return {
      ...task,
      context: {
        ...task.context,
        myHandle,
        peers,
      },
    }
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

    state.activeTasks++
    state.totalTasks++
    state.lastActive = new Date()

    this.log(`[${task.agentId}] executing task (${state.activeTasks}/${state.def.maxConcurrent})`)

    // Build conversation history for session continuity
    const channel = task.context?.channel || "api"
    const chatId = task.context?.group || task.context?.sender || "default"
    const senderName = task.context?.sender || "User"

    // Record user message in session
    this.sessions.addUserMessage(task.agentId, channel, chatId, senderName, task.message)

    // Enrich task context with peer info and channel handles
    task = this.enrichTaskContext(task)

    // Wiki: find relevant articles and inject as context (token-efficient)
    const wikiArticles = this.wiki.findRelevant(task.message, task.agentId, 3)
    const wikiContext = this.wiki.buildContext(wikiArticles)

    // For claude-code tier: use native --resume with Claude session ID
    // For other tiers: use manual history context
    const resumeSessionId = state.def.tier === "claude-code"
      ? this.sessions.getClaudeSessionId(task.agentId, channel, chatId)
      : undefined
    // Combine wiki context with session history for non-claude-code tiers
    const sessionHistory = state.def.tier !== "claude-code"
      ? this.sessions.buildHistoryContext(task.agentId, channel, chatId)
      : undefined
    const historyContext = [wikiContext, sessionHistory].filter(Boolean).join("\n\n") || undefined

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
            this.wiki.addEntry({
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
        }

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
}
