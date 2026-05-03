import type Database from "better-sqlite3"
import { TokenTracker, type AgentUsage, type DailyUsage } from "@/daemon/token-tracker"

// --- SQLite read path for usage observability ---
//
// Move A — the dashboard's date-range loader and the daemon's /health
// endpoint switch their source of truth from the per-day JSON files in
// .agentx/usage/ to the usage_daily table in .agentx/db.sqlite.
//
// Pure read functions. Each accepts a Database handle (or null when
// SQLite is disabled) plus the same string args the JSON readers used
// to take, so call sites are a one-line swap. Returns the same shapes
// the JSON layer produced — UsageDay (dashboard) and DailyUsage
// (registry/health) — so downstream rendering doesn't fork.
//
// Cost computation: tier-1 columns + tier-2 columns are summed and
// passed to TokenTracker.calculateCost() exactly as the JSON path
// does, applying the TIER2_MULTIPLIER per the existing pricing table.
// The math is the same; only the data source changes.

/** Same shape the dashboard's loadUsageRange() returns. */
export interface UsageDay {
  date: string
  tasks: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
  agents: Record<string, {
    tasks: number
    cost: number
    input: number
    output: number
    cacheRead: number
    cacheCreate: number
    model?: string
  }>
}

interface UsageRow {
  agent_id: string
  model: string
  day: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_create_tokens: number
  tier2_input_tokens: number
  tier2_output_tokens: number
  tier2_cache_read_tokens: number
  tier2_cache_create_tokens: number
  tasks: number
}

/** Build an AgentUsage view over a single SQLite row so we can pass it
 *  to TokenTracker.calculateCost without inventing a new pricing path. */
function rowToAgentUsage(r: UsageRow): AgentUsage {
  return {
    tasks: r.tasks,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreateTokens: r.cache_create_tokens,
    tier2InputTokens: r.tier2_input_tokens,
    tier2OutputTokens: r.tier2_output_tokens,
    tier2CacheReadTokens: r.tier2_cache_read_tokens,
    tier2CacheCreateTokens: r.tier2_cache_create_tokens,
    totalDuration: 0,
    errors: 0,
    model: r.model,
  }
}

/** Read `usage_daily` rows for a single day and roll them up into a
 *  DailyUsage value compatible with `TokenTracker.today()`'s shape. */
export function loadDailyUsage(db: Database.Database | null, date: string): DailyUsage | null {
  if (!db) return null
  const rows = db
    .prepare(`SELECT * FROM usage_daily WHERE day = ?`)
    .all(date) as UsageRow[]
  if (rows.length === 0) return null

  const agents: Record<string, AgentUsage> = {}
  for (const r of rows) {
    // Multiple rows per (agent, model, day). Same agent + multiple models
    // → fold the second into the first; the dashboard's downstream cost
    // math handles a single AgentUsage object per agent.
    const existing = agents[r.agent_id]
    const next = rowToAgentUsage(r)
    if (!existing) {
      agents[r.agent_id] = next
    } else {
      existing.tasks += next.tasks
      existing.inputTokens += next.inputTokens
      existing.outputTokens += next.outputTokens
      existing.cacheReadTokens += next.cacheReadTokens
      existing.cacheCreateTokens += next.cacheCreateTokens
      existing.tier2InputTokens = (existing.tier2InputTokens || 0) + (next.tier2InputTokens || 0)
      existing.tier2OutputTokens = (existing.tier2OutputTokens || 0) + (next.tier2OutputTokens || 0)
      existing.tier2CacheReadTokens = (existing.tier2CacheReadTokens || 0) + (next.tier2CacheReadTokens || 0)
      existing.tier2CacheCreateTokens = (existing.tier2CacheCreateTokens || 0) + (next.tier2CacheCreateTokens || 0)
      // Last-wins on `model` — matches the JSON tracker which stores the
      // most recent model per agent. Cost is computed per-row regardless.
      existing.model = next.model
    }
  }
  return { date, agents }
}

/** Roll a date range into an array of UsageDay values (dashboard shape).
 *  Inclusive `from` and `to`. Days with zero tasks are omitted, matching
 *  the JSON loader's `.filter(d.tasks > 0)`. Sorted ASC by date. */
export function loadUsageRange(db: Database.Database | null, from: string, to: string): UsageDay[] {
  if (!db) return []

  const rows = db
    .prepare(
      `SELECT * FROM usage_daily
       WHERE (@from = '' OR day >= @from)
         AND (@to   = '' OR day <= @to)
       ORDER BY day ASC`
    )
    .all({ from, to }) as UsageRow[]

  // Group by day → roll up per-agent.
  const byDay = new Map<string, UsageRow[]>()
  for (const r of rows) {
    const list = byDay.get(r.day) ?? []
    list.push(r)
    byDay.set(r.day, list)
  }

  const out: UsageDay[] = []
  for (const [date, dayRows] of byDay) {
    let tasks = 0, input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0
    const agents: UsageDay["agents"] = {}
    for (const r of dayRows) {
      const usage = rowToAgentUsage(r)
      const agentCost = TokenTracker.calculateCost(usage)
      const aInput = (usage.inputTokens || 0) + (usage.tier2InputTokens || 0)
      const aOutput = (usage.outputTokens || 0) + (usage.tier2OutputTokens || 0)
      const aCacheRead = (usage.cacheReadTokens || 0) + (usage.tier2CacheReadTokens || 0)
      const aCacheCreate = (usage.cacheCreateTokens || 0) + (usage.tier2CacheCreateTokens || 0)
      tasks += usage.tasks
      input += aInput
      output += aOutput
      cacheRead += aCacheRead
      cacheCreate += aCacheCreate
      cost += agentCost
      // Same-agent / multi-model rows get folded into a single agent entry.
      const prior = agents[r.agent_id]
      if (!prior) {
        agents[r.agent_id] = {
          tasks: usage.tasks,
          cost: agentCost,
          input: aInput,
          output: aOutput,
          cacheRead: aCacheRead,
          cacheCreate: aCacheCreate,
          model: usage.model,
        }
      } else {
        prior.tasks += usage.tasks
        prior.cost += agentCost
        prior.input += aInput
        prior.output += aOutput
        prior.cacheRead += aCacheRead
        prior.cacheCreate += aCacheCreate
        prior.model = usage.model || prior.model
      }
    }
    if (tasks > 0) {
      out.push({ date, tasks, input, output, cacheRead, cacheCreate, cost, agents })
    }
  }
  // Map iteration preserves insertion order; rows came back ORDER BY day,
  // so out[] is already ASC by date. Sort defensively in case SQLite's
  // collation returns rows in a different order under some PRAGMA.
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
}

/** Today's rollup in the same shape `TokenTracker.today()` returns,
 *  for the daemon's /health endpoint. Empty `{ date, agents: {} }`
 *  when SQLite is null or holds no rows for today. */
export function loadTodayRollup(db: Database.Database | null, today?: string): DailyUsage {
  const date = today ?? new Date().toISOString().slice(0, 10)
  const daily = loadDailyUsage(db, date)
  return daily ?? { date, agents: {} }
}

export type UsageReadMode = "sqlite" | "json" | "sqlite-then-json"

/** Resolve the dashboard / health read path against the AGENTX_USAGE_READ
 *  env var. Default `sqlite-then-json` is the migration-safe choice — try
 *  SQLite first, fall back to JSON when the handle is null or the SQLite
 *  rollup is empty. Operators can pin "sqlite" once they've confirmed
 *  rollups are populated, or pin "json" to keep legacy behaviour. */
export function getUsageReadMode(env: NodeJS.ProcessEnv = process.env): UsageReadMode {
  const v = (env.AGENTX_USAGE_READ ?? "").toLowerCase().trim()
  if (v === "sqlite" || v === "json" || v === "sqlite-then-json") return v
  return "sqlite-then-json"
}
