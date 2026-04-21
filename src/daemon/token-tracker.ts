import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"

// --- Token usage tracker ---
// Tracks token usage per agent per day with cache-aware, tier-aware cost
// calculation. Persisted to .agentx/usage/{YYYY-MM-DD}.json.
//
// Design notes:
//   - Pricing is per-model-FAMILY (opus/sonnet/haiku). Exact model name
//     variants map via getModelFamily(). Override the table by dropping
//     .agentx/pricing/custom.json (same shape) — merged over defaults at
//     construction, lets operators adjust without a rebuild.
//   - Anthropic bills 1.5× input/output when a single request's total input
//     (input + cacheCreate + cacheRead) exceeds 200K tokens. We split each
//     recorded task into tier1/tier2 buckets and bill them separately so
//     long-context sessions are not undercounted.
//   - Per-channel breakdowns let operators see "GitLab drove 70% of today's
//     spend" — the lever for channel-specific session + context tuning.
//   - Session tracking (unique chatId:channel pairs seen today per agent)
//     gives an avg-tasks-per-session proxy — when it spikes, it's usually
//     retry/clarification chains, a signal the context budget or model
//     capability is under-sized for that traffic.

// Anthropic pricing per million tokens (as of April 2026, 5-min ephemeral).
// Keys here must match getModelFamily() output.
//
// IMPORTANT: Opus 4.6 is 3× cheaper than Opus 4.1. Haiku 4.5 is more expensive
// than Haiku 3.5. Our getModelFamily() resolves the exact version so the cost
// report matches what Anthropic actually bills. Source: LiteLLM pricing cache
// at ~/.cache/codeburn/litellm-pricing.json + codeburn/src/models.ts.
//
// Cache multipliers (consistent across all models):
//   cache write (5-min ephemeral) = 1.25 × input
//   cache read                    = 0.10 × input
export const CACHE_AWARE_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  // Opus 4.6 / 4.5 — $5/$25 per MTok
  "claude-opus-4-6":  { input: 5,    output: 25,   cacheRead: 0.5,   cacheCreate: 6.25 },
  "claude-opus-4-5":  { input: 5,    output: 25,   cacheRead: 0.5,   cacheCreate: 6.25 },
  // Opus 4.1 and earlier — $15/$75 per MTok (legacy, keep for historical runs)
  "claude-opus":      { input: 15,   output: 75,   cacheRead: 1.5,   cacheCreate: 18.75 },
  // Sonnet 4.6 / 4.5 — $3/$15 per MTok
  "claude-sonnet":    { input: 3,    output: 15,   cacheRead: 0.3,   cacheCreate: 3.75 },
  // Haiku 4.5 — $1/$5 per MTok (more expensive than Haiku 3.5)
  "claude-haiku":     { input: 1,    output: 5,    cacheRead: 0.1,   cacheCreate: 1.25 },
}

/** Per-request input size (input + cacheCreate + cacheRead) above this
 *  threshold triggers Anthropic's extended-context tier: all four rates
 *  get multiplied. Applies to Opus 4.x and Sonnet 4.x 1M variants. */
export const CONTEXT_TIER_THRESHOLD = 200_000
export const TIER2_MULTIPLIER = 1.5

export function getModelFamily(model: string): string {
  const lower = model.toLowerCase()
  if (lower.includes("opus")) {
    // Opus 4.6 and 4.5 are 3× cheaper than 4.1 — must distinguish.
    if (lower.includes("4-6") || lower.includes("4.6") || lower.includes("opus-4-6")) return "claude-opus-4-6"
    if (lower.includes("4-5") || lower.includes("4.5") || lower.includes("opus-4-5")) return "claude-opus-4-5"
    return "claude-opus" // legacy 4.1 and earlier
  }
  if (lower.includes("haiku")) return "claude-haiku"
  return "claude-sonnet"
}

export interface ChannelUsage {
  tasks: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  tier2InputTokens: number
  tier2OutputTokens: number
  tier2CacheReadTokens: number
  tier2CacheCreateTokens: number
  totalDuration: number
  errors: number
}

export interface AgentUsage {
  tasks: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  /** Tokens from requests whose input crossed CONTEXT_TIER_THRESHOLD (billed at
   *  TIER2_MULTIPLIER × normal rate). Kept separate from the tier1 buckets so
   *  cost math stays honest when a session accumulates past 200K. */
  tier2InputTokens?: number
  tier2OutputTokens?: number
  tier2CacheReadTokens?: number
  tier2CacheCreateTokens?: number
  totalDuration: number
  errors: number
  model?: string
  /** Per-channel breakdown so we can attribute cost to Telegram vs GitLab vs WhatsApp. */
  byChannel?: Record<string, ChannelUsage>
  /** Unique session identifiers (channel:chatId) this agent participated in
   *  today. Used to derive avg tasks/session. Capped at 500 entries to keep
   *  the daily JSON small. */
  sessionKeys?: string[]
}

export interface DailyUsage {
  date: string
  agents: Record<string, AgentUsage>
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
  /** Per-agent avg tasks/session — high values suggest retry chains. */
  agentSessionStats: Record<string, { sessions: number; avgTasksPerSession: number }>
  /** Aggregate cost by channel across all agents. */
  byChannel: Record<string, number>
}

/** Shape of a per-request usage report coming from the runtime. Keeps the
 *  record() signature tidy and lets callers opt into tier2 accounting. */
export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
}

const SESSION_KEYS_MAX = 500
const PRICING_OVERRIDE_PATH = ".agentx/pricing/custom.json"

export class TokenTracker {
  private dir: string
  private cache: DailyUsage | null = null
  private pricing: typeof CACHE_AWARE_PRICING

  constructor(baseDir: string = resolve(process.cwd(), ".agentx/usage")) {
    this.dir = baseDir
    mkdirSync(this.dir, { recursive: true })
    this.pricing = loadPricingWithOverrides()
  }

  /** Returns the active pricing table (hardcoded defaults with any per-model
   *  overrides merged in). Useful for UI / debugging. */
  getPricing(): typeof CACHE_AWARE_PRICING {
    return this.pricing
  }

  /**
   * Calculate cost for a slice of usage. Accepts either a full AgentUsage or
   * a narrowed ChannelUsage — both expose the same token buckets we price on.
   * Tier2 tokens are billed at TIER2_MULTIPLIER × the normal rate.
   */
  static calculateCost(usage: AgentUsage | ChannelUsage, model?: string, pricingTable: typeof CACHE_AWARE_PRICING = CACHE_AWARE_PRICING): number {
    const family = getModelFamily(model || (usage as AgentUsage).model || "claude-sonnet")
    const p = pricingTable[family] || pricingTable["claude-sonnet"]
    const tier2In = (usage as any).tier2InputTokens || 0
    const tier2Out = (usage as any).tier2OutputTokens || 0
    const tier2CR = (usage as any).tier2CacheReadTokens || 0
    const tier2CW = (usage as any).tier2CacheCreateTokens || 0

    const tier1 =
      ((usage.inputTokens || 0) / 1_000_000) * p.input +
      ((usage.outputTokens || 0) / 1_000_000) * p.output +
      ((usage.cacheReadTokens || 0) / 1_000_000) * p.cacheRead +
      ((usage.cacheCreateTokens || 0) / 1_000_000) * p.cacheCreate

    const tier2 =
      (tier2In / 1_000_000) * p.input +
      (tier2Out / 1_000_000) * p.output +
      (tier2CR / 1_000_000) * p.cacheRead +
      (tier2CW / 1_000_000) * p.cacheCreate

    return tier1 + tier2 * TIER2_MULTIPLIER
  }

  /**
   * Instance-level cost calculation — uses the tracker's resolved pricing
   * table so any custom override file is honored. Prefer this over the
   * static variant when available.
   */
  cost(usage: AgentUsage | ChannelUsage, model?: string): number {
    return TokenTracker.calculateCost(usage, model, this.pricing)
  }

  /**
   * Record a task execution with real or estimated token counts.
   *
   * `channel` attributes the cost to a surface (telegram/gitlab/whatsapp/cron).
   * `sessionKey` is an opaque "this chat on this day" identifier — we use it
   * to count unique sessions so an avg-tasks-per-session metric falls out.
   */
  record(
    agentId: string,
    duration: number,
    realUsage?: TaskUsage,
    messageLength?: number,
    responseLength?: number,
    error?: boolean,
    model?: string,
    channel?: string,
    sessionKey?: string,
  ): void {
    const daily = this.today()
    const agent = daily.agents[agentId] || {
      tasks: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0,
      tier2InputTokens: 0, tier2OutputTokens: 0,
      tier2CacheReadTokens: 0, tier2CacheCreateTokens: 0,
      totalDuration: 0, errors: 0, byChannel: {}, sessionKeys: [],
    }

    agent.tasks++
    agent.totalDuration += duration
    if (model) agent.model = model

    // Split this request into tier1/tier2 based on its TOTAL input size
    // (input + cacheCreate + cacheRead). Output inherits the tier of its
    // request. Estimated paths (no realUsage) are always tier1 — they're
    // too small to reach the threshold.
    let i1 = 0, o1 = 0, cr1 = 0, cw1 = 0, i2 = 0, o2 = 0, cr2 = 0, cw2 = 0
    if (realUsage) {
      const totalInput = realUsage.inputTokens + realUsage.cacheReadTokens + realUsage.cacheCreateTokens
      if (totalInput > CONTEXT_TIER_THRESHOLD) {
        i2 = realUsage.inputTokens
        o2 = realUsage.outputTokens
        cr2 = realUsage.cacheReadTokens
        cw2 = realUsage.cacheCreateTokens
      } else {
        i1 = realUsage.inputTokens
        o1 = realUsage.outputTokens
        cr1 = realUsage.cacheReadTokens
        cw1 = realUsage.cacheCreateTokens
      }
    } else if (messageLength !== undefined && responseLength !== undefined) {
      i1 = Math.ceil(messageLength / 4)
      o1 = Math.ceil(responseLength / 4)
    }

    agent.inputTokens += i1
    agent.outputTokens += o1
    agent.cacheReadTokens += cr1
    agent.cacheCreateTokens += cw1
    agent.tier2InputTokens = (agent.tier2InputTokens || 0) + i2
    agent.tier2OutputTokens = (agent.tier2OutputTokens || 0) + o2
    agent.tier2CacheReadTokens = (agent.tier2CacheReadTokens || 0) + cr2
    agent.tier2CacheCreateTokens = (agent.tier2CacheCreateTokens || 0) + cw2

    if (error) agent.errors++

    // Per-channel attribution. Unknown channel falls into "other".
    if (!agent.byChannel) agent.byChannel = {}
    const chKey = (channel || "other").toLowerCase()
    const ch = agent.byChannel[chKey] || {
      tasks: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreateTokens: 0,
      tier2InputTokens: 0, tier2OutputTokens: 0,
      tier2CacheReadTokens: 0, tier2CacheCreateTokens: 0,
      totalDuration: 0, errors: 0,
    }
    ch.tasks++
    ch.totalDuration += duration
    ch.inputTokens += i1; ch.outputTokens += o1
    ch.cacheReadTokens += cr1; ch.cacheCreateTokens += cw1
    ch.tier2InputTokens += i2; ch.tier2OutputTokens += o2
    ch.tier2CacheReadTokens += cr2; ch.tier2CacheCreateTokens += cw2
    if (error) ch.errors++
    agent.byChannel[chKey] = ch

    // Session tracking — dedup sessions by opaque key (normally channel:chatId).
    if (sessionKey) {
      if (!agent.sessionKeys) agent.sessionKeys = []
      if (!agent.sessionKeys.includes(sessionKey)) {
        agent.sessionKeys.push(sessionKey)
        if (agent.sessionKeys.length > SESSION_KEYS_MAX) {
          agent.sessionKeys.splice(0, agent.sessionKeys.length - SESSION_KEYS_MAX)
        }
      }
    }

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
   * Generate a daily cost report for a given date. Includes per-agent,
   * per-channel costs and session statistics.
   */
  generateDailyReport(date?: string): DailyReport | null {
    const targetDate = date || new Date().toISOString().slice(0, 10)
    const usage = this.getDate(targetDate)
    if (!usage) return null

    let totalTasks = 0, totalInput = 0, totalOutput = 0
    let totalCacheRead = 0, totalCacheCreate = 0, totalCost = 0
    let topAgent = "", topCost = 0
    const agentCosts: Record<string, number> = {}
    const agentSessionStats: Record<string, { sessions: number; avgTasksPerSession: number }> = {}
    const byChannel: Record<string, number> = {}

    for (const [id, agent] of Object.entries(usage.agents)) {
      const cost = this.cost(agent)
      agentCosts[id] = cost
      totalTasks += agent.tasks
      totalInput += (agent.inputTokens || 0) + (agent.tier2InputTokens || 0)
      totalOutput += (agent.outputTokens || 0) + (agent.tier2OutputTokens || 0)
      totalCacheRead += (agent.cacheReadTokens || 0) + (agent.tier2CacheReadTokens || 0)
      totalCacheCreate += (agent.cacheCreateTokens || 0) + (agent.tier2CacheCreateTokens || 0)
      totalCost += cost
      if (cost > topCost) { topCost = cost; topAgent = id }

      const sessions = agent.sessionKeys?.length || 0
      agentSessionStats[id] = {
        sessions,
        avgTasksPerSession: sessions > 0 ? agent.tasks / sessions : agent.tasks,
      }

      for (const [chKey, ch] of Object.entries(agent.byChannel || {})) {
        const chCost = this.cost(ch, agent.model)
        byChannel[chKey] = (byChannel[chKey] || 0) + chCost
      }
    }

    return {
      date: targetDate, totalTasks, totalInput, totalOutput,
      totalCacheRead, totalCacheCreate, totalCost, topAgent, topCost, agentCosts,
      agentSessionStats, byChannel,
    }
  }

  /**
   * Append a daily report row to TOKEN_COSTS.md. Adds channel + session
   * breakdown inline for at-a-glance spend attribution.
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
      .map(([id, cost]) => {
        const stats = report.agentSessionStats[id]
        const sessTag = stats && stats.sessions > 0 ? ` (${stats.sessions}s, ${stats.avgTasksPerSession.toFixed(1)}t/s)` : ""
        return `${id}: $${fmt(cost)}${sessTag}`
      })
      .join(", ")

    const channelBreakdown = Object.entries(report.byChannel)
      .sort(([, a], [, b]) => b - a)
      .map(([ch, cost]) => `${ch}: $${fmt(cost)}`)
      .join(", ")

    const row = `| ${report.date} | ${report.totalTasks} | ${fmtTok(report.totalInput)} | ${fmtTok(report.totalOutput)} | ${fmtTok(report.totalCacheRead)} | ${fmtTok(report.totalCacheCreate)} | $${fmt(report.totalCost)} | ${agentBreakdown} | ${channelBreakdown} |`

    if (!existsSync(file)) {
      const header =
        "# Token Costs\n\n" +
        "Daily token cost tracking. Auto-appended at midnight (Africa/Tunis).\n" +
        "Agent breakdown: `agent: $cost (Ns, T.Tt/s)` — sessions, tasks/session.\n\n" +
        "| Date | Tasks | Input | Output | Cache R | Cache W | Cost | Per Agent | Per Channel |\n" +
        "|------|-------|-------|--------|---------|---------|------|-----------|-------------|\n"
      writeFileSync(file, header + row + "\n")
    } else {
      appendFileSync(file, row + "\n")
    }
  }

  /**
   * Return true if TOKEN_COSTS.md already has a row for `date`. Lets callers
   * skip duplicate appends after daemon restarts or timer-edge double fires.
   */
  hasTokenCostsEntry(date: string, filePath?: string): boolean {
    const file = filePath || resolve(process.cwd(), ".agentx/TOKEN_COSTS.md")
    if (!existsSync(file)) return false
    try {
      const content = readFileSync(file, "utf-8")
      // Rows look like: `| 2026-04-18 | ...`
      return new RegExp(`^\\|\\s*${date}\\s*\\|`, "m").test(content)
    } catch {
      return false
    }
  }

  /**
   * Find the most recent date already logged to TOKEN_COSTS.md (YYYY-MM-DD).
   * Returns null when the file doesn't exist or has no rows.
   */
  lastTokenCostsDate(filePath?: string): string | null {
    const file = filePath || resolve(process.cwd(), ".agentx/TOKEN_COSTS.md")
    if (!existsSync(file)) return null
    try {
      const content = readFileSync(file, "utf-8")
      const dates = content.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm) ?? []
      if (dates.length === 0) return null
      // Extract the date portion and pick the max — rows can be out of order
      // after a catch-up, so don't rely on file order.
      const parsed = dates
        .map((m) => m.match(/(\d{4}-\d{2}-\d{2})/)?.[1])
        .filter((d): d is string => !!d)
      parsed.sort()
      return parsed[parsed.length - 1] ?? null
    } catch {
      return null
    }
  }

  /**
   * Append reports for any days between (lastLogged + 1) and `throughDate`
   * that have usage on disk but no row in TOKEN_COSTS.md. Idempotent —
   * safe to call on every daemon startup. Bounded to `maxDays` to avoid
   * a stalled daemon backfilling a year's worth on first start.
   *
   * Returns the list of dates actually appended, for logging.
   */
  catchUpTokenCosts(
    throughDate: string,
    opts: { maxDays?: number; filePath?: string } = {},
  ): string[] {
    const maxDays = opts.maxDays ?? 30
    const appended: string[] = []

    const last = this.lastTokenCostsDate(opts.filePath)
    // Walk backward from throughDate, collecting dates to fill. Stop at the
    // last-logged date (exclusive) or after maxDays, whichever comes first.
    const candidates: string[] = []
    const cursor = new Date(`${throughDate}T00:00:00Z`)
    for (let i = 0; i < maxDays; i++) {
      const date = cursor.toISOString().slice(0, 10)
      if (last && date <= last) break
      candidates.push(date)
      cursor.setUTCDate(cursor.getUTCDate() - 1)
    }
    // Oldest-first so the file stays chronological.
    candidates.reverse()

    for (const date of candidates) {
      if (this.hasTokenCostsEntry(date, opts.filePath)) continue
      const report = this.generateDailyReport(date)
      if (!report || report.totalTasks === 0) continue
      this.appendToTokenCosts(report, opts.filePath)
      appended.push(date)
    }
    return appended
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
    byChannel: Record<string, { tasks: number; cost: number }>
    sessionStats: Record<string, { sessions: number; avgTasksPerSession: number }>
  } {
    let totalTasks = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let totalErrors = 0
    let totalCost = 0
    const byAgent: Record<string, { tasks: number; input: number; output: number; cacheRead: number; cacheCreate: number; total: number; avgDuration: number; totalDuration: number; cost: number; model?: string; sessions: number }> = {}
    const byChannel: Record<string, { tasks: number; cost: number }> = {}

    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10)
      const usage = this.getDate(date)
      if (!usage) continue

      for (const [id, agent] of Object.entries(usage.agents)) {
        const cost = this.cost(agent)
        totalTasks += agent.tasks
        const agentInput = (agent.inputTokens || 0) + (agent.tier2InputTokens || 0)
        const agentOutput = (agent.outputTokens || 0) + (agent.tier2OutputTokens || 0)
        const agentCR = (agent.cacheReadTokens || 0) + (agent.tier2CacheReadTokens || 0)
        const agentCW = (agent.cacheCreateTokens || 0) + (agent.tier2CacheCreateTokens || 0)
        totalInput += agentInput
        totalOutput += agentOutput
        totalCacheRead += agentCR
        totalCacheCreate += agentCW
        totalErrors += agent.errors
        totalCost += cost

        const existing = byAgent[id] || { tasks: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, avgDuration: 0, totalDuration: 0, cost: 0, sessions: 0 }
        existing.tasks += agent.tasks
        existing.input += agentInput
        existing.output += agentOutput
        existing.cacheRead += agentCR
        existing.cacheCreate += agentCW
        existing.total = existing.input + existing.output + existing.cacheRead + existing.cacheCreate
        existing.totalDuration += agent.totalDuration
        existing.avgDuration = existing.totalDuration / existing.tasks
        existing.cost += cost
        existing.sessions += agent.sessionKeys?.length || 0
        if (agent.model) existing.model = agent.model
        byAgent[id] = existing

        for (const [chKey, ch] of Object.entries(agent.byChannel || {})) {
          const chCost = this.cost(ch, agent.model)
          const acc = byChannel[chKey] || { tasks: 0, cost: 0 }
          acc.tasks += ch.tasks
          acc.cost += chCost
          byChannel[chKey] = acc
        }
      }
    }

    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreate
    const cacheHitRatio = (totalCacheRead + totalCacheCreate) > 0
      ? totalCacheRead / (totalCacheRead + totalCacheCreate)
      : 0

    const sessionStats: Record<string, { sessions: number; avgTasksPerSession: number }> = {}
    for (const [id, a] of Object.entries(byAgent)) {
      sessionStats[id] = {
        sessions: a.sessions,
        avgTasksPerSession: a.sessions > 0 ? a.tasks / a.sessions : a.tasks,
      }
    }

    return { totalTasks, totalTokens, totalInput, totalOutput, totalCacheRead, totalCacheCreate, cacheHitRatio, totalErrors, totalCost, byAgent, byChannel, sessionStats }
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

/**
 * Load CACHE_AWARE_PRICING and merge any operator-supplied override. The
 * override file is optional; operators tweak rates (e.g. when Anthropic
 * publishes a price change) without rebuilding the daemon.
 */
function loadPricingWithOverrides(): typeof CACHE_AWARE_PRICING {
  const result = JSON.parse(JSON.stringify(CACHE_AWARE_PRICING))
  try {
    const p = resolve(process.cwd(), PRICING_OVERRIDE_PATH)
    if (!existsSync(p)) return result
    const raw = JSON.parse(readFileSync(p, "utf-8"))
    for (const [family, rates] of Object.entries(raw)) {
      if (!result[family]) result[family] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
      Object.assign(result[family], rates as object)
    }
  } catch {
    // Malformed override file — stay with defaults rather than crash at boot.
  }
  return result
}
