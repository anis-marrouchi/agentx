import type { DaemonConfig, AgentDef } from "@/daemon/config"
import { executeTask, type AgentTask, type AgentResponse, type StreamCallback, type AgentPeer } from "./runtime"
import { SessionStore } from "./sessions"
import { WikiHub } from "@/wiki"
import { RateLimiter } from "@/daemon/rate-limit"
import { TokenTracker } from "@/daemon/token-tracker"
import { buildAgentContext, type ContextInput } from "./context"
import { MemoryStore } from "./memory-store"
import { extractMemories } from "./memory-extract"
import { MessageQueue, type QueueMode, type QueuedMessage } from "./message-queue"
import { loadBootstrapFiles, buildBootstrapContext, detectSoulSwitch, listSoulProfiles } from "./bootstrap"
import { PatternStore, extractPatterns } from "./patterns"
import type { LandscapeBuilder } from "./landscape"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"

// --- Agent Registry: lifecycle management + concurrency control ---

/** Global singleton for sub-agent spawning from tools */
let globalRegistry: AgentRegistry | undefined

export function setGlobalRegistry(registry: AgentRegistry): void {
  globalRegistry = registry
}

export function getGlobalRegistry(): AgentRegistry | undefined {
  return globalRegistry
}

export interface RunningTask {
  /** Unique id for this execution (timestamp-based). */
  id: string
  /** First 200 chars of the user message, for display. */
  messagePreview: string
  /** Origin channel (telegram, whatsapp, gitlab, api, cron, business, a2a, …). */
  channel: string
  /** Group / chat / issue id from which the task arrived. */
  chatId?: string
  /** Sender id/name (user, agent id, "cron:<id>", "mesh:<peer>", …). */
  sender?: string
  /** Wall-clock start. */
  startedAt: Date
}

type TaskOutputSubscriber = (chunk: string) => void

interface TaskOutput {
  agentId: string
  buffer: string
  subscribers: Set<TaskOutputSubscriber>
  done: boolean
  endedAt?: Date
}

/** Cap per-task buffer to keep memory bounded; recent tail wins. */
const TASK_OUTPUT_BUFFER_MAX = 64 * 1024
/** Keep finished outputs around briefly so a late opener still gets the tail. */
const TASK_OUTPUT_TTL_MS = 5 * 60 * 1000

/** Persisted record of a finished task, written to .agentx/task-history. */
export interface TaskRecord {
  id: string
  agentId: string
  channel: string
  chatId?: string
  sender?: string
  message: string
  startedAt: string
  endedAt: string
  durationMs: number
  ok: boolean
  error?: string
  /** Final agent text (one-shot, may be empty if streaming captured it). */
  responseText: string
  /** Terminal-style transcript captured from stream-json events. */
  transcript: string
}

const TASK_HISTORY_DIR = ".agentx/task-history"
/** Default retention for persisted task records. Set for business audit trails;
 *  bump via the `dashboard.taskHistoryRetentionDays` config field if you need more. */
const TASK_HISTORY_RETENTION_DAYS = 30

/** Truncate long values so the buffer doesn't blow up on huge tool inputs/outputs. */
function clip(s: string, max = 800): string {
  if (s.length <= max) return s
  return s.slice(0, max) + ` …[+${s.length - max} chars]`
}

/**
 * Format raw Claude Code stream-json events into a terminal-style transcript
 * for the dashboard streaming modal. Returns "" for events we don't surface.
 *
 * Stateful so we can emit only the *delta* of assistant text across consecutive
 * `assistant` snapshot events (Claude re-sends the cumulative content each tick).
 */
function makeStreamEventFormatter(): (event: any) => string {
  let textSeen = ""
  return (event: any): string => {
    if (!event || typeof event !== "object") return ""
    const t = event.type
    if (t === "system" && event.subtype === "init") {
      const m = event.model ? ` model=${event.model}` : ""
      const sid = event.session_id ? ` session=${event.session_id.slice(0, 8)}` : ""
      return `· init${m}${sid}\n`
    }
    if (t === "assistant" && event.message?.content) {
      let out = ""
      for (const block of event.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.length > textSeen.length) {
            out += block.text.slice(textSeen.length)
            textSeen = block.text
          }
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          out += `\n💭 ${clip(block.thinking, 600)}\n`
        } else if (block.type === "tool_use") {
          const name = block.name || "tool"
          const input = block.input ? clip(JSON.stringify(block.input), 400) : ""
          out += `\n→ ${name}(${input})\n`
        }
      }
      return out
    }
    if (t === "user" && event.message?.content) {
      let out = ""
      for (const block of event.message.content) {
        if (block.type === "tool_result") {
          const c = Array.isArray(block.content)
            ? block.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
            : typeof block.content === "string" ? block.content : ""
          const flag = block.is_error ? "← [error] " : "← "
          out += `${flag}${clip(c, 800)}\n`
        }
      }
      return out
    }
    if (t === "result") {
      const dur = event.duration_ms ? ` (${Math.round(event.duration_ms / 1000)}s)` : ""
      return `· done${dur}\n`
    }
    return ""
  }
}

interface AgentState {
  id: string
  def: AgentDef
  activeTasks: number
  totalTasks: number
  lastActive?: Date
  errors: number
  runningTasks: RunningTask[]
}

export class AgentRegistry {
  private agents: Map<string, AgentState> = new Map()
  private config: DaemonConfig
  private providers: Record<string, { apiKey?: string }> = {}
  private sessions: SessionStore
  private wikiHub: WikiHub
  private memoryStore: MemoryStore
  private patternStore: PatternStore
  private rateLimiter: RateLimiter
  private tokenTracker: TokenTracker
  private landscape?: LandscapeBuilder
  private messageQueue: MessageQueue
  /** Active soul profile per agent+chat session: "agentId:channel:chatId" → profile name */
  private activeSouls: Map<string, string> = new Map()
  /** Live output captured per running task id — drives the dashboard streaming modal. */
  private taskOutputs: Map<string, TaskOutput> = new Map()
  /** Last completed task summary per agent — single-line blurb for the dashboard card. */
  private lastSummaries: Map<string, { text: string; at: Date; ok: boolean }> = new Map()
  /** 24-hour sparkline cache per agent — recomputed from disk at most once a minute. */
  private sparklineCache: Map<string, { hourly: number[]; at: number }> = new Map()
  private log: (...args: unknown[]) => void

  constructor(
    config: DaemonConfig,
    log: (...args: unknown[]) => void = console.error.bind(console, "[agents]"),
  ) {
    this.log = log
    this.config = config
    this.providers = config.providers
    this.sessions = new SessionStore(process.cwd(), { staleMinutes: config.session.staleMinutes })
    this.wikiHub = new WikiHub(undefined, undefined, "unified")
    this.memoryStore = new MemoryStore()
    this.patternStore = new PatternStore()
    this.rateLimiter = new RateLimiter()
    this.tokenTracker = new TokenTracker()
    this.messageQueue = new MessageQueue()

    for (const [id, def] of Object.entries(config.agents)) {
      this.agents.set(id, {
        id,
        def,
        activeTasks: 0,
        totalTasks: 0,
        errors: 0,
        runningTasks: [],
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
   *
   * When `atMentionsOnly` is true, only `@`-prefixed mentions are considered.
   * This is used for messages originating from another bot (cross-daemon
   * Telegram cascades, for example) where we don't want bare-word matches
   * like "nadia" in prose or "devops-mtgl" quoted in a reply to trigger
   * agents spuriously. Intentional handoffs still work because agents
   * write explicit `@noqta_X_bot` handles.
   */
  findByMention(text: string, opts: { atMentionsOnly?: boolean } = {}): string | undefined {
    const lower = text.toLowerCase()
    let bestId: string | undefined
    let bestLen = 0

    for (const [id, state] of this.agents) {
      for (const mention of state.def.mentions) {
        if (opts.atMentionsOnly && !mention.startsWith("@")) continue
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

    // Build session key for queue management
    const qChannel = task.context?.channel || "api"
    const qChatId = task.context?.chatId || task.context?.group || task.context?.sender || "default"

    if (state.activeTasks >= state.def.maxConcurrent) {
      // Agent is busy — try to queue the message instead of rejecting
      const mode = (state.def.queueMode as QueueMode) || "collect"
      const queued = this.messageQueue.enqueue(task.agentId, qChannel, qChatId, {
        text: task.message,
        sender: task.context?.sender || "User",
        timestamp: Date.now(),
        channel: qChannel,
        chatId: qChatId,
        originalContext: task.context as Record<string, unknown>,
      })

      if (queued === "drop") {
        this.log(`[${task.agentId}] busy, message dropped (mode: drop)`)
        return { content: "", error: `Agent "${task.agentId}" is busy — message dropped` }
      }

      if (queued) {
        const pending = this.messageQueue.pendingCount(task.agentId, qChannel, qChatId)
        this.log(`[${task.agentId}] busy, message queued (mode: ${queued}, pending: ${pending})`)
        return {
          content: "",
          error: `__queued__:${queued}:${pending}`,
        }
      }
    }

    // Rate limit — WAIT for a slot instead of failing. Dropping messages looks
    // like the bot is broken; queueing for ~5 minutes gives chatty channels a
    // smooth experience and still bails if something's genuinely stuck.
    const rateResult = await this.rateLimiter.acquire(task.agentId, {
      maxWaitMs: 5 * 60_000,
      onWait: (reason, waitMs) => {
        this.log(`[${task.agentId}] ${reason} — queued, resumes in ~${Math.max(1, Math.round(waitMs / 1000))}s`)
      },
    })
    if (!rateResult.ok) {
      this.log(`[${task.agentId}] ${rateResult.reason}`)
      return { content: "", error: rateResult.reason }
    }

    state.activeTasks++
    state.totalTasks++
    state.lastActive = new Date()

    // Track the running task for live visibility (/agents endpoint surfaces this).
    const runningTask: RunningTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messagePreview: (task.message || "").slice(0, 200),
      channel: task.context?.channel || "api",
      chatId: task.context?.chatId || task.context?.group,
      sender: task.context?.sender,
      startedAt: new Date(),
    }
    state.runningTasks.push(runningTask)

    // Output capture for the dashboard streaming modal. We never *force*
    // streaming on a caller that didn't ask for it — that would change the
    // runtime mode (stream-json vs json) for every task in the system. So:
    //   - Caller passed onDelta → wrap it to also fan-out to dashboard subscribers (live).
    //     We also install onEvent so the dashboard sees tool calls, tool results,
    //     and system events — i.e. everything you'd see in a real terminal.
    //   - Caller did NOT pass onDelta → leave runtime in non-streaming mode and
    //     post the final response.content as a single chunk after execution.
    const output: TaskOutput = { agentId: task.agentId, buffer: "", subscribers: new Set(), done: false }
    this.taskOutputs.set(runningTask.id, output)
    const pushToBuffer = (chunk: string) => {
      if (!chunk) return
      output.buffer += chunk
      if (output.buffer.length > TASK_OUTPUT_BUFFER_MAX) {
        output.buffer = output.buffer.slice(output.buffer.length - TASK_OUTPUT_BUFFER_MAX)
      }
      for (const sub of output.subscribers) {
        try { sub(chunk) } catch { /* subscriber crashed — ignore */ }
      }
    }
    let onEvent: ((event: any) => void) | undefined
    if (onDelta) {
      // Caller's onDelta still fires only for assistant text (unchanged).
      // Dashboard subscribers see the formatted stream-json firehose via onEvent
      // — this is what makes the modal feel like a live terminal.
      const formatter = makeStreamEventFormatter()
      onEvent = (event: any) => {
        const formatted = formatter(event)
        if (formatted) pushToBuffer(formatted)
      }
    }

    // Mark session as running in the message queue
    this.messageQueue.markRunning(task.agentId, qChannel, qChatId)

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

    // Load behavioral patterns (self-improving loop)
    const relevantPatterns = this.patternStore.findRelevant(task.message, task.agentId, 5)
    const patternContext = this.patternStore.buildContext(relevantPatterns)

    // Auto-inject skills matched to current message
    let skillInjection = ""
    try {
      const { loadLocalSkills, getAutoInjectSkills } = await import("@/agent/skills/loader")
      const skills = await loadLocalSkills(state.def.workspace)
      skillInjection = getAutoInjectSkills(skills, task.message)
    } catch {
      // Skill loading is optional
    }

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

    // Compact session if history is getting too long (summarize older messages)
    try {
      const compactResult = await this.sessions.compactIfNeeded(
        task.agentId, channel, chatId, this.memoryStore,
      )
      if (compactResult.compacted) {
        const quality = compactResult.qualityScore ?? "?"
        const lost = compactResult.lostEntities?.length ?? 0
        this.log(`[${task.agentId}] session compacted for ${channel}:${chatId} (quality: ${quality}%, ${lost} entities lost)`)
        if (compactResult.lostEntities?.length) {
          this.log(`[${task.agentId}] lost entities: ${compactResult.lostEntities.slice(0, 5).join(", ")}`)
        }
        if (compactResult.drift) {
          const d = compactResult.drift
          this.log(`[${task.agentId}] DRIFT DETECTED: score=${d.overallScore} (lexicon=${d.lexiconDecay}, tools=${d.toolShift}, semantic=${d.semanticDrift})`)
          if (d.lostWords.length) this.log(`[${task.agentId}] lost domain words: ${d.lostWords.slice(0, 5).join(", ")}`)
        }
        resumeSessionId = undefined
      }
    } catch (e: any) {
      this.log(`[${task.agentId}] compaction failed (non-fatal): ${e.message}`)
    }

    const sessionHistory = !resumeSessionId
      ? this.sessions.buildHistoryContext(task.agentId, channel, chatId)
      : undefined

    // Bridge cross-chat amnesia: inject context from other chats (DM ↔ group)
    const crossChatContext = this.sessions.getCrossSessionSummary(task.agentId, channel, chatId)

    // Soul switching: detect /soul command and track active profile
    const soulSessionKey = `${task.agentId}:${channel}:${chatId}`
    const soulSwitch = detectSoulSwitch(task.message)
    if (soulSwitch) {
      if (soulSwitch === "default") {
        this.activeSouls.delete(soulSessionKey)
        this.log(`[${task.agentId}] Soul reset to default`)
      } else {
        this.activeSouls.set(soulSessionKey, soulSwitch)
        this.log(`[${task.agentId}] Soul switched to: ${soulSwitch}`)
      }
    }
    const activeSoul = this.activeSouls.get(soulSessionKey)

    // Load bootstrap identity files (SOUL.md or SOUL.{profile}.md).
    // These are delivered via --append-system-prompt to Claude Code so they
    // live inside the cached system prompt — we no longer append them into
    // the per-turn user-message context (which would pay cache-create on
    // every new session). The context builder still gets a flag-empty
    // bootstrapContext so the `[Identity]` / `[Personality]` block is
    // suppressed in the rendered context (Claude sees them once, cached).
    const bootstrapFiles = loadBootstrapFiles(state.def.workspace, activeSoul)
    const bootstrapContextText = buildBootstrapContext(bootstrapFiles)

    // Compose the cacheable system-prompt preamble. Order matters for cache
    // stability: agent.systemPrompt is the most stable (config-defined),
    // bootstrap files follow. Soul-switching mid-session produces a new
    // append-text and a new Claude cache key; that's by design — the rare
    // switch is worth a one-time cache-create cost.
    const systemPromptAppend = [
      state.def.systemPrompt || "",
      bootstrapContextText || "",
    ].filter((s) => s.trim().length > 0).join("\n\n") || undefined

    const contextInput: ContextInput = {
      channel,
      channelScope: task.context?.group ? "group" : (channel === "gitlab" ? "project" : "personal"),
      groupName: task.context?.group,
      agentId: task.agentId,
      agentName: state.def.name,
      agentHandle: this.getChannelHandle(task.agentId, channel),
      systemPrompt: state.def.systemPrompt,
      sender: senderName,
      senderId: task.context?.senderId,
      senderUsername: task.context?.senderUsername,
      landscape: this.landscape?.getForAgent(task.agentId),
      channelMeta: task.context?.channelMeta,
      mediaPath: task.context?.mediaPath,
      mediaType: task.context?.mediaType,
      replyToText: task.context?.replyToText,
      // bootstrapContext intentionally omitted — delivered via system prompt.
      patternContext: patternContext || undefined,
      skillInjection: skillInjection || undefined,
      groupHistory: task.context?.group ? undefined : undefined, // group log is injected by router
      sessionHistory,
      memoryContext: memoryContext || undefined,
      crossChatContext: crossChatContext || undefined,
      wikiContext,
      message: task.message,
    }

    const historyContext = buildAgentContext(contextInput)

    // Attach the cacheable preamble onto the task so runtime.ts can forward
    // it to Claude CLI's --append-system-prompt arg.
    const taskWithSystemPrompt: AgentTask = { ...task, systemPromptAppend }

    let finalResponse: AgentResponse | undefined
    try {
      const response = await executeTask(state.def, taskWithSystemPrompt, this.providers, onDelta, historyContext, resumeSessionId, onEvent)
      finalResponse = response

      // For non-streaming runs (no caller onDelta) we never captured incremental
      // chunks — surface the final response in one shot so the dashboard modal
      // shows something meaningful when subscribers are attached.
      if (!onDelta && (response.content || response.error)) {
        const finalText = response.error ? `[error] ${response.error}` : response.content
        output.buffer = finalText
        for (const sub of output.subscribers) {
          try { sub(finalText) } catch { /* */ }
        }
      }

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

          // Patterns: extract behavioral patterns (fire-and-forget)
          extractPatterns(
            task.agentId,
            task.message,
            response.content,
            { channel, date: new Date().toISOString().slice(0, 10) },
            this.patternStore,
          ).catch(() => {})
        }

        // Track token usage (real counts if available, estimate otherwise).
        // Model priority for pricing: what the API ACTUALLY billed (from the
        // CLI init / result event) > per-task override (cron model) > agent
        // config default. Without this, cron-overridden runs get priced at
        // the wrong rate and cache-aware cost reports mislead operators.
        const billedModel = response.billedModel || task.model || state.def.model
        const tChannel = task.context?.channel
        // Session key = "channel:chatId" — opaque to the tracker, just needs
        // to be unique per (conversation, day). Lets us derive avg-tasks/
        // session later so retry-heavy traffic becomes visible.
        const tSessionKey = tChannel && (task.context?.chatId || task.context?.group || task.context?.sender)
          ? `${tChannel}:${task.context?.chatId || task.context?.group || task.context?.sender}`
          : undefined
        this.tokenTracker.record(
          task.agentId,
          response.duration || 0,
          response.usage,
          task.message.length,
          response.content.length,
          false,
          billedModel,
          tChannel,
          tSessionKey,
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
      finalResponse = { content: "", error: error.message }
      return finalResponse
    } finally {
      state.activeTasks--
      // Remove this run from the running-tasks list.
      const idx = state.runningTasks.findIndex((r) => r.id === runningTask.id)
      if (idx !== -1) state.runningTasks.splice(idx, 1)

      // Notify any open dashboard streams that this task has finished, then
      // schedule the buffer for cleanup so memory doesn't grow unbounded.
      output.done = true
      output.endedAt = new Date()
      for (const sub of output.subscribers) {
        try { sub("\n[task finished]\n") } catch { /* ignore */ }
      }
      output.subscribers.clear()
      setTimeout(() => this.taskOutputs.delete(runningTask.id), TASK_OUTPUT_TTL_MS).unref?.()

      // Persist a TaskRecord for the dashboard's "Recent activities" panel.
      // Best-effort — disk failures must not affect task semantics.
      try {
        const endedAt = output.endedAt
        const record: TaskRecord = {
          id: runningTask.id,
          agentId: task.agentId,
          channel: runningTask.channel,
          chatId: runningTask.chatId,
          sender: runningTask.sender,
          message: task.message || "",
          startedAt: runningTask.startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - runningTask.startedAt.getTime(),
          ok: !finalResponse?.error,
          error: finalResponse?.error,
          responseText: finalResponse?.content || "",
          transcript: output.buffer,
        }
        this.persistTaskRecord(record)
        // Stash a one-line summary so the dashboard card can show "what the
        // agent did last" without reading from disk on every snapshot.
        const rawSummary = (record.responseText || record.error || "").trim()
        if (rawSummary) {
          const firstLine = rawSummary.split(/\r?\n/)[0].slice(0, 140)
          this.lastSummaries.set(task.agentId, { text: firstLine, at: endedAt, ok: record.ok })
        }
      } catch (e: any) {
        this.log(`[${task.agentId}] task history persist failed: ${e?.message}`)
      }

      // Flush queued messages that arrived while this run was in progress
      this.messageQueue.markDone(task.agentId, qChannel, qChatId)
        .then((queued) => {
          if (queued.length === 0) return
          this.log(`[${task.agentId}] flushing ${queued.length} queued message(s)`)
          // Re-execute each queued message as a new task
          for (const qm of queued) {
            this.execute({
              message: qm.text,
              agentId: task.agentId,
              context: (qm.originalContext as AgentTask["context"]) || {
                channel: qm.channel,
                sender: qm.sender,
                chatId: qm.chatId,
              },
            }).catch((e) => {
              this.log(`[${task.agentId}] queued message failed: ${e.message}`)
            })
          }
        })
        .catch((e) => {
          this.log(`[${task.agentId}] queue flush failed: ${e.message}`)
        })
    }
  }

  /**
   * List all agents and their status.
   */
  list(): Array<{
    id: string
    name: string
    tier: string
    model?: string
    workspace: string
    active: number
    total: number
    errors: number
    lastActive?: Date
    runningTasks: RunningTask[]
    lastSummary?: { text: string; at: string; ok: boolean }
    hourlyTasks?: number[]
  }> {
    return Array.from(this.agents.values()).map((s) => {
      const summary = this.lastSummaries.get(s.id)
      return {
        id: s.id,
        name: s.def.name,
        tier: s.def.tier,
        model: s.def.model,
        workspace: s.def.workspace,
        active: s.activeTasks,
        total: s.totalTasks,
        errors: s.errors,
        lastActive: s.lastActive,
        runningTasks: s.runningTasks,
        lastSummary: summary ? { text: summary.text, at: summary.at.toISOString(), ok: summary.ok } : undefined,
        hourlyTasks: this.getHourlySparkline(s.id, 24),
      }
    })
  }

  /**
   * Write a finished task record to disk under .agentx/task-history/<agent>/<yyyy-mm-dd>/.
   * Side-effects only — call sites should treat failure as best-effort.
   */
  private persistTaskRecord(record: TaskRecord): void {
    const day = record.endedAt.slice(0, 10)
    const dir = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(record.agentId), day)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = resolve(dir, `${this.safe(record.id)}.json`)
    writeFileSync(file, JSON.stringify(record, null, 2), "utf-8")
  }

  /**
   * Compute a 24-hour hourly task-count sparkline for an agent from persisted
   * history. Returns an array of 24 numbers: buckets[0] = 23-24h ago,
   * buckets[23] = now-hour. Cached per-agent for 60s to keep snapshot load
   * reasonable when the dashboard polls every 2s.
   */
  getHourlySparkline(agentId: string, hours: number = 24): number[] {
    const now = Date.now()
    const cached = this.sparklineCache.get(agentId)
    if (cached && now - cached.at < 60_000 && cached.hourly.length === hours) return cached.hourly

    const buckets = new Array<number>(hours).fill(0)
    const windowStart = now - hours * 3600_000
    const root = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(agentId))
    if (!existsSync(root)) {
      this.sparklineCache.set(agentId, { hourly: buckets, at: now })
      return buckets
    }
    // Only need the last 2 day folders — crossing midnight still fits.
    const today = new Date(now).toISOString().slice(0, 10)
    const yesterday = new Date(now - 86400_000).toISOString().slice(0, 10)
    const dayToday = new Date(now); dayToday.setUTCHours(0, 0, 0, 0)
    for (const day of [yesterday, today]) {
      const dayDir = resolve(root, day)
      if (!existsSync(dayDir)) continue
      try {
        for (const f of readdirSync(dayDir)) {
          if (!f.endsWith(".json")) continue
          // Task id is timestamp-prefixed (e.g. 1776447897061-xxx.json) — pull
          // the millis without parsing each file.
          const tsStr = f.split("-")[0]
          const ts = parseInt(tsStr, 10)
          if (!Number.isFinite(ts) || ts < windowStart || ts > now) continue
          const offsetHours = Math.floor((now - ts) / 3600_000)
          const idx = hours - 1 - offsetHours
          if (idx >= 0 && idx < hours) buckets[idx]++
        }
      } catch { /* skip unreadable */ }
    }
    this.sparklineCache.set(agentId, { hourly: buckets, at: now })
    return buckets
  }

  /**
   * Rebuild the in-memory lastSummaries cache from disk so dashboard cards
   * show the most recent "what did they do" line even right after a restart.
   * Called once on daemon startup — one file read per agent.
   */
  hydrateLastSummariesFromDisk(): number {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR)
    if (!existsSync(root)) return 0
    let loaded = 0
    for (const agentDir of readdirSync(root)) {
      const agentPath = resolve(root, agentDir)
      let days: string[]
      try { days = readdirSync(agentPath).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() } catch { continue }
      outer: for (const day of days) {
        const dayDir = resolve(agentPath, day)
        let files: string[]
        try { files = readdirSync(dayDir).filter((f) => f.endsWith(".json")).sort().reverse() } catch { continue }
        for (const f of files) {
          try {
            const rec = JSON.parse(readFileSync(resolve(dayDir, f), "utf-8")) as TaskRecord
            const raw = (rec.responseText || rec.error || "").trim()
            if (!raw) continue
            const firstLine = raw.split(/\r?\n/)[0].slice(0, 140)
            this.lastSummaries.set(rec.agentId, { text: firstLine, at: new Date(rec.endedAt), ok: rec.ok })
            loaded++
            break outer
          } catch { /* skip corrupt file */ }
        }
      }
    }
    return loaded
  }

  /**
   * Drop history folders older than retention window. Cheap startup-time
   * sweep — once a day is plenty, but doing it on every daemon boot is fine.
   */
  pruneTaskHistory(retentionDays = TASK_HISTORY_RETENTION_DAYS): number {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR)
    if (!existsSync(root)) return 0
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const agentDir of readdirSync(root)) {
      const agentPath = resolve(root, agentDir)
      let dayEntries: string[]
      try { dayEntries = readdirSync(agentPath) } catch { continue }
      for (const day of dayEntries) {
        const ts = Date.parse(day + "T00:00:00Z")
        if (Number.isNaN(ts) || ts >= cutoff) continue
        try { rmSync(resolve(agentPath, day), { recursive: true, force: true }); removed++ } catch { /* */ }
      }
    }
    return removed
  }

  /**
   * Newest-first list of task records for one agent, capped at `limit`.
   * Walks at most the last few day folders so this is O(limit), not O(history).
   */
  listTaskHistory(agentId: string, limit = 50): Array<Omit<TaskRecord, "transcript" | "responseText">> {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(agentId))
    if (!existsSync(root)) return []
    const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    const out: Array<Omit<TaskRecord, "transcript" | "responseText">> = []
    for (const day of days) {
      if (out.length >= limit) break
      const dayDir = resolve(root, day)
      let files: string[]
      try { files = readdirSync(dayDir).filter((f) => f.endsWith(".json")) } catch { continue }
      // Sort by file mtime desc — task ids are timestamp-prefixed so lexicographic also works.
      files.sort().reverse()
      for (const f of files) {
        if (out.length >= limit) break
        try {
          const rec = JSON.parse(readFileSync(resolve(dayDir, f), "utf-8")) as TaskRecord
          const { transcript: _t, responseText: _r, ...summary } = rec
          out.push(summary)
        } catch { /* skip corrupt */ }
      }
    }
    return out
  }

  /**
   * Look up one task's full record (transcript included) across the retention window.
   */
  getTaskRecord(agentId: string, taskId: string): TaskRecord | null {
    const root = resolve(process.cwd(), TASK_HISTORY_DIR, this.safe(agentId))
    if (!existsSync(root)) return null
    const safeId = this.safe(taskId)
    const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    for (const day of days) {
      const file = resolve(root, day, `${safeId}.json`)
      if (existsSync(file)) {
        try { return JSON.parse(readFileSync(file, "utf-8")) as TaskRecord } catch { return null }
      }
    }
    return null
  }

  private safe(s: string): string {
    return s.replace(/[^a-zA-Z0-9_.:-]/g, "_")
  }

  /**
   * Subscribe to live output for a running task. Returns the buffer that has
   * accumulated so far plus an unsubscribe handle. If the task is unknown,
   * returns null. If the task already finished, the subscriber is given the
   * tail buffer and immediately ended.
   */
  subscribeToTaskOutput(taskId: string, sub: TaskOutputSubscriber): { initial: string; done: boolean; unsubscribe: () => void } | null {
    const out = this.taskOutputs.get(taskId)
    if (!out) return null
    if (out.done) return { initial: out.buffer, done: true, unsubscribe: () => {} }
    out.subscribers.add(sub)
    return {
      initial: out.buffer,
      done: false,
      unsubscribe: () => { out.subscribers.delete(sub) },
    }
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
