import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"

// --- Token usage tracker ---
// Tracks estimated token usage per agent per day.
// Persisted to .agentx/usage/{YYYY-MM-DD}.json

export interface DailyUsage {
  date: string
  agents: Record<string, AgentUsage>
}

interface AgentUsage {
  tasks: number
  estimatedTokens: number
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
   * Record a task execution.
   */
  record(agentId: string, messageLength: number, responseLength: number, duration: number, error?: boolean): void {
    const usage = this.today()
    const agent = usage.agents[agentId] || { tasks: 0, estimatedTokens: 0, totalDuration: 0, errors: 0 }

    agent.tasks++
    agent.totalDuration += duration
    // Rough estimate: 1 token ≈ 4 chars for English text
    agent.estimatedTokens += Math.ceil((messageLength + responseLength) / 4)
    if (error) agent.errors++

    usage.agents[agentId] = agent
    this.save(usage)
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
    totalErrors: number
    byAgent: Record<string, { tasks: number; tokens: number; avgDuration: number }>
  } {
    let totalTasks = 0
    let totalTokens = 0
    let totalErrors = 0
    const byAgent: Record<string, { tasks: number; tokens: number; avgDuration: number; totalDuration: number }> = {}

    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10)
      const usage = this.getDate(date)
      if (!usage) continue

      for (const [id, agent] of Object.entries(usage.agents)) {
        totalTasks += agent.tasks
        totalTokens += agent.estimatedTokens
        totalErrors += agent.errors

        const existing = byAgent[id] || { tasks: 0, tokens: 0, avgDuration: 0, totalDuration: 0 }
        existing.tasks += agent.tasks
        existing.tokens += agent.estimatedTokens
        existing.totalDuration += agent.totalDuration
        existing.avgDuration = existing.totalDuration / existing.tasks
        byAgent[id] = existing
      }
    }

    return { totalTasks, totalTokens, totalErrors, byAgent }
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
