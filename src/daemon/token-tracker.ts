import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"

// --- Token usage tracker ---
// Tracks estimated token usage per agent per day.
// Persisted to .agentx/usage/{YYYY-MM-DD}.json

export interface DailyUsage {
  date: string
  agents: Record<string, AgentUsage>
}

export interface AgentUsage {
  tasks: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  totalDuration: number
  errors: number
}

export class TokenTracker {
  private dir: string
  private cache: DailyUsage | null = null

  constructor(baseDir: string = resolve(process.cwd(), ".agentx/usage")) {
    this.dir = baseDir
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * Record a task execution with real or estimated token counts.
   */
  record(
    agentId: string,
    duration: number,
    realUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
    messageLength?: number,
    responseLength?: number,
    error?: boolean,
  ): void {
    const daily = this.today()
    const agent = daily.agents[agentId] || {
      tasks: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0, totalDuration: 0, errors: 0,
    }

    agent.tasks++
    agent.totalDuration += duration

    if (realUsage) {
      // Real counts from Claude's JSON output
      agent.inputTokens += realUsage.inputTokens
      agent.outputTokens += realUsage.outputTokens
      agent.cacheReadTokens += realUsage.cacheReadTokens
      agent.cacheCreateTokens += realUsage.cacheCreateTokens
    } else if (messageLength !== undefined && responseLength !== undefined) {
      // Fallback estimate for non-Claude providers
      agent.inputTokens += Math.ceil(messageLength / 4)
      agent.outputTokens += Math.ceil(responseLength / 4)
    }

    if (error) agent.errors++

    daily.agents[agentId] = agent
    this.save(daily)
  }

  /**
   * Get today's usage summary.
   */
  today(): DailyUsage {
    const date = new Date().toISOString().slice(0, 10)

    if (this.cache?.date === date) return this.cache

    const path = this.filePath(date)
    if (existsSync(path)) {
      try {
        this.cache = JSON.parse(readFileSync(path, "utf-8"))
        return this.cache!
      } catch {}
    }

    this.cache = { date, agents: {} }
    return this.cache
  }

  /**
   * Get usage for a specific date.
   */
  getDate(date: string): DailyUsage | null {
    const path = this.filePath(date)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf-8"))
    } catch {
      return null
    }
  }

  /**
   * Get summary across last N days.
   */
  summary(days: number = 7): {
    totalTasks: number
    totalTokens: number
    totalInput: number
    totalOutput: number
    totalCacheRead: number
    totalCacheCreate: number
    cacheHitRatio: number
    totalErrors: number
    byAgent: Record<string, { tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; total: number; avgDuration: number }>
  } {
    let totalTasks = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let totalErrors = 0
    const byAgent: Record<string, { tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; total: number; avgDuration: number; totalDuration: number }> = {}

    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10)
      const usage = this.getDate(date)
      if (!usage) continue

      for (const [id, agent] of Object.entries(usage.agents)) {
        totalTasks += agent.tasks
        totalInput += agent.inputTokens || 0
        totalOutput += agent.outputTokens || 0
        totalCacheRead += agent.cacheReadTokens || 0
        totalCacheCreate += agent.cacheCreateTokens || 0
        totalErrors += agent.errors

        const existing = byAgent[id] || { tasks: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, avgDuration: 0, totalDuration: 0 }
        existing.tasks += agent.tasks
        existing.input += agent.inputTokens || 0
        existing.output += agent.outputTokens || 0
        existing.cacheRead += agent.cacheReadTokens || 0
        existing.cacheCreate += agent.cacheCreateTokens || 0
        existing.total = existing.input + existing.output + existing.cacheRead + existing.cacheCreate
        existing.totalDuration += agent.totalDuration
        existing.avgDuration = existing.totalDuration / existing.tasks
        byAgent[id] = existing
      }
    }

    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreate
    const cacheHitRatio = (totalCacheRead + totalCacheCreate) > 0
      ? totalCacheRead / (totalCacheRead + totalCacheCreate)
      : 0

    return { totalTasks, totalTokens, totalInput, totalOutput, totalCacheRead, totalCacheCreate, cacheHitRatio, totalErrors, byAgent }
  }

  private filePath(date: string): string {
    return resolve(this.dir, `${date}.json`)
  }

  private save(usage: DailyUsage): void {
    try {
      writeFileSync(this.filePath(usage.date), JSON.stringify(usage, null, 2))
    } catch {}
  }
}
