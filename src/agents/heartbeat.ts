import type { AgentRegistry } from "./registry"
import type { MemoryStore } from "./memory-store"

// --- Heartbeat System ---
//
// Periodic check-in that runs WITHIN the active session context.
// Unlike cron (which creates isolated sessions), heartbeat carries
// the full conversation context — useful for inbox checks, health
// monitoring, and proactive agent behavior.
//
// Configured per-agent in agentx.json:
//   agents.<id>.heartbeat: {
//     enabled: true,
//     intervalMinutes: 30,
//     prompt: "Check inbox, pending tasks, and system health."
//   }

export interface HeartbeatConfig {
  enabled: boolean
  /** Interval in minutes between heartbeats (default: 30) */
  intervalMinutes: number
  /** Prompt to execute during heartbeat */
  prompt: string
  /** Channel to execute in (default: "heartbeat") */
  channel?: string
}

interface HeartbeatState {
  agentId: string
  config: HeartbeatConfig
  timer?: ReturnType<typeof setInterval>
  lastRun?: Date
  runCount: number
  errors: number
}

/**
 * Manages periodic heartbeat runs for agents.
 * Heartbeats run in the agent's existing session context,
 * preserving conversation history and memory.
 */
export class HeartbeatManager {
  private registry: AgentRegistry
  private memoryStore?: MemoryStore
  private states: Map<string, HeartbeatState> = new Map()
  private log: (...args: unknown[]) => void

  constructor(
    registry: AgentRegistry,
    log: (...args: unknown[]) => void = console.error.bind(console, "[heartbeat]"),
    memoryStore?: MemoryStore,
  ) {
    this.registry = registry
    this.log = log
    this.memoryStore = memoryStore
  }

  /**
   * Register a heartbeat for an agent.
   */
  register(agentId: string, config: HeartbeatConfig): void {
    if (!config.enabled) return

    // Clear existing timer if re-registering
    this.stop(agentId)

    const state: HeartbeatState = {
      agentId,
      config,
      runCount: 0,
      errors: 0,
    }

    const intervalMs = (config.intervalMinutes || 30) * 60 * 1000

    state.timer = setInterval(() => {
      this.runHeartbeat(state).catch((e) => {
        this.log(`[${agentId}] heartbeat error: ${e.message}`)
        state.errors++
      })
    }, intervalMs)

    this.states.set(agentId, state)
    this.log(`Registered heartbeat for "${agentId}" every ${config.intervalMinutes}min`)
  }

  /**
   * Stop heartbeat for an agent.
   */
  stop(agentId: string): void {
    const state = this.states.get(agentId)
    if (state?.timer) {
      clearInterval(state.timer)
      state.timer = undefined
    }
    this.states.delete(agentId)
  }

  /**
   * Stop all heartbeats.
   */
  stopAll(): void {
    for (const [id] of this.states) {
      this.stop(id)
    }
  }

  /**
   * Run a single heartbeat for an agent.
   */
  private async runHeartbeat(state: HeartbeatState): Promise<void> {
    const { agentId, config } = state

    this.log(`[${agentId}] heartbeat running...`)
    state.lastRun = new Date()
    state.runCount++

    const channel = config.channel || "heartbeat"

    try {
      // Inject memory recall context if memories are due for review
      let prompt = config.prompt
      if (this.memoryStore) {
        const recallContext = this.memoryStore.buildRecallContext(agentId)
        if (recallContext) {
          prompt = `${recallContext}\n\n${prompt}`
        }
      }

      const response = await this.registry.execute({
        message: prompt,
        agentId,
        context: {
          channel,
          sender: "system:heartbeat",
          chatId: `heartbeat:${agentId}`,
        },
      })

      if (response.error) {
        this.log(`[${agentId}] heartbeat error: ${response.error}`)
        state.errors++
      } else {
        this.log(
          `[${agentId}] heartbeat completed (${response.duration}ms, ` +
          `${response.content.length} chars)`,
        )
      }
    } catch (error: any) {
      this.log(`[${agentId}] heartbeat failed: ${error.message}`)
      state.errors++
    }
  }

  /**
   * Manually trigger a heartbeat for an agent.
   */
  async trigger(agentId: string): Promise<void> {
    const state = this.states.get(agentId)
    if (!state) {
      this.log(`[${agentId}] no heartbeat registered`)
      return
    }
    await this.runHeartbeat(state)
  }

  /**
   * List all registered heartbeats and their status.
   */
  list(): Array<{
    agentId: string
    intervalMinutes: number
    lastRun?: Date
    runCount: number
    errors: number
  }> {
    return Array.from(this.states.values()).map((s) => ({
      agentId: s.agentId,
      intervalMinutes: s.config.intervalMinutes,
      lastRun: s.lastRun,
      runCount: s.runCount,
      errors: s.errors,
    }))
  }
}
