import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"

// --- Token usage tracker ---
// Tracks token usage per agent per day with cache-aware cost calculation.
// Persisted to .agentx/usage/{YYYY-MM-DD}.json

// Anthropic pricing per million tokens (as of April 2026)
export const CACHE_AWARE_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  "claude-opus":   { input: 15,   output: 75,   cacheRead: 1.5,    cacheCreate: 18.75 },
  "claude-sonnet": { input: 3,    output: 15,   cacheRead: 0.3,    cacheCreate: 3.75 },
  "claude-haiku":  { input: 0.25, output: 1.25, cacheRead: 0.025,  cacheCreate: 0.3125 },
}

export function getModelFamily(model: string): string {
  const lower = model.toLowerCase()
  if (lower.includes("opus")) return "claude-opus"
  if (lower.includes("haiku")) return "claude-haiku"
  return "claude-sonnet"
}

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
  model?: string
}

export interface DailyReport {
  date: string
  totalTasks: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreate: number
  totalCost: number
  topAgent: string
  topCost: number
  agentCosts: Record<string, number>
}

export class TokenTracker {
  private dir: string
  private cache: DailyUsage | null = null

  constructor(baseDir: string = resolve(process.cwd(), ".agentx/usage")) {
    this.dir = baseDir
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * Calculate cost for an agent's usage with cache-aware pricing.
   */
  static calculateCost(usage: AgentUsage): number {
    const family = getModelFamily(usage.model || "claude-sonnet")
    const pricing = CACHE_AWARE_PRICING[family] || CACHE_AWARE_PRICING["claude-sonnet"]

    return (
      ((usage.inputTokens || 0) / 1_000_000) * pricing.input +
      ((usage.outputTokens || 0) / 1_000_000) * pricing.output +
      ((usage.cacheReadTokens || 0) / 1_000_000) * pricing.cacheRead +
      ((usage.cacheCreateTokens || 0) / 1_000_000) * pricing.cacheCreate
    )
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
    model?: string,
  ): void {
    const daily = this.today()
    const agent = daily.agents[agentId] || {
      tasks: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0, totalDuration: 0, errors: 0,
    }

    agent.tasks++
    agent.totalDuration += duration
    if (model) agent.model = model

    if (realUsage) {
      agent.inputTokens += realUsage.inputTokens
      agent.outputTokens += realUsage.outputTokens
      agent.cacheReadTokens += realUsage.cacheReadTokens
      agent.cacheCreateTokens += realUsage.cacheCreateTokens
    } else if (messageLength !== undefined && responseLength !== undefined) {
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
   * Generate a daily cost report for a given date.
   */
  generateDailyReport(date?: string): DailyReport | null {
    const targetDate = date || new Date().toISOString().slice(0, 10)
    const usage = this.getDate(targetDate)
    if (!usage) return null

    let totalTasks = 0, totalInput = 0, totalOutput = 0
    let totalCacheRead = 0, totalCacheCreate = 0, totalCost = 0
    let topAgent = "", topCost = 0
    const agentCosts: Record<string, number> = {}

    for (const [id, agent] of Object.entries(usage.agents)) {
      const cost = TokenTracker.calculateCost(agent)
      agentCosts[id] = cost
      totalTasks += agent.tasks
      totalInput += agent.inputTokens || 0
      totalOutput += agent.outputTokens || 0
      totalCacheRead += agent.cacheReadTokens || 0
      totalCacheCreate += agent.cacheCreateTokens || 0
      totalCost += cost
      if (cost > topCost) { topCost = cost; topAgent = id }
    }

    return {
      date: targetDate, totalTasks, totalInput, totalOutput,
      totalCacheRead, totalCacheCreate, totalCost, topAgent, topCost, agentCosts,
    }
  }

  /**
   * Append a daily report row to TOKEN_COSTS.md.
   */
  appendToTokenCosts(report: DailyReport, filePath?: string): void {
    const file = filePath || resolve(process.cwd(), ".agentx/TOKEN_COSTS.md")
    const fmt = (n: number) => n < 0.01 ? n.toFixed(4) : n.toFixed(2)
    const fmtTok = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` :
      n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` :
      String(n)

    const agentBreakdown = Object.entries(report.agentCosts)
      .sort(([, a], [, b]) => b - a)
      .map(([id, cost]) => `${id}: $${fmt(cost)}`)
      .join(", ")

    const row = `| ${report.date} | ${report.totalTasks} | ${fmtTok(report.totalInput)} | ${fmtTok(report.totalOutput)} | ${fmtTok(report.totalCacheRead)} | ${fmtTok(report.totalCacheCreate)} | $${fmt(report.totalCost)} | ${agentBreakdown} |`

    if (!existsSync(file)) {
      const header =
        "# Token Costs\n\n" +
        "Daily token cost tracking. Auto-appended at midnight (Africa/Tunis).\n\n" +
        "| Date | Tasks | Input | Output | Cache R | Cache W | Cost | Per Agent |\n" +
        "|------|-------|-------|--------|---------|---------|------|-----------|\n"
      writeFileSync(file, header + row + "\n")
    } else {
      appendFileSync(file, row + "\n")
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
    totalCost: number
    byAgent: Record<string, { tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; total: number; avgDuration: number; cost: number }>
  } {
    let totalTasks = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let totalErrors = 0
    let totalCost = 0
    const byAgent: Record<string, { tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; total: number; avgDuration: number; totalDuration: number; cost: number; model?: string }> = {}

    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10)
      const usage = this.getDate(date)
      if (!usage) continue

      for (const [id, agent] of Object.entries(usage.agents)) {
        const cost = TokenTracker.calculateCost(agent)
        totalTasks += agent.tasks
        totalInput += agent.inputTokens || 0
        totalOutput += agent.outputTokens || 0
        totalCacheRead += agent.cacheReadTokens || 0
        totalCacheCreate += agent.cacheCreateTokens || 0
        totalErrors += agent.errors
        totalCost += cost

        const existing = byAgent[id] || { tasks: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, avgDuration: 0, totalDuration: 0, cost: 0 }
        existing.tasks += agent.tasks
        existing.input += agent.inputTokens || 0
        existing.output += agent.outputTokens || 0
        existing.cacheRead += agent.cacheReadTokens || 0
        existing.cacheCreate += agent.cacheCreateTokens || 0
        existing.total = existing.input + existing.output + existing.cacheRead + existing.cacheCreate
        existing.totalDuration += agent.totalDuration
        existing.avgDuration = existing.totalDuration / existing.tasks
        existing.cost += cost
        if (agent.model) existing.model = agent.model
        byAgent[id] = existing
      }
    }

    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreate
    const cacheHitRatio = (totalCacheRead + totalCacheCreate) > 0
      ? totalCacheRead / (totalCacheRead + totalCacheCreate)
      : 0

    return { totalTasks, totalTokens, totalInput, totalOutput, totalCacheRead, totalCacheCreate, cacheHitRatio, totalErrors, totalCost, byAgent }
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
