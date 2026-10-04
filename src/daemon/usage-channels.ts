// Cost per channel over a fixed range of days, from the daily usage files the
// daemon already writes (.agentx/usage/<date>.json). Used to compare the same
// measure before and after a change (`agentx usage channels`, #621).

import type { ChannelUsage, TokenTracker } from "./token-tracker"

export interface ChannelTotals {
  tasks: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost: number
}

export interface ChannelCostReport {
  from: string
  to: string
  /** Days in the range that have a usage file. */
  days: number
  channels: Record<string, ChannelTotals>
  total: ChannelTotals
}

const empty = (): ChannelTotals => ({ tasks: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 })

function add(acc: ChannelTotals, ch: ChannelUsage, cost: number): void {
  acc.tasks += ch.tasks || 0
  acc.input += (ch.inputTokens || 0) + (ch.tier2InputTokens || 0)
  acc.output += (ch.outputTokens || 0) + (ch.tier2OutputTokens || 0)
  acc.cacheRead += (ch.cacheReadTokens || 0) + (ch.tier2CacheReadTokens || 0)
  acc.cacheCreate += (ch.cacheCreateTokens || 0) + (ch.tier2CacheCreateTokens || 0)
  acc.cost += cost
}

/** Sum every agent's per-channel usage for each day from `from` to `to` (YYYY-MM-DD, inclusive). */
export function channelCosts(tracker: Pick<TokenTracker, "getDate" | "cost">, from: string, to: string): ChannelCostReport {
  const report: ChannelCostReport = { from, to, days: 0, channels: {}, total: empty() }
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const usage = tracker.getDate(new Date(t).toISOString().slice(0, 10))
    if (!usage) continue
    report.days++
    for (const agent of Object.values(usage.agents)) {
      for (const [channel, ch] of Object.entries(agent.byChannel || {})) {
        const cost = tracker.cost(ch, agent.model)
        add((report.channels[channel] ??= empty()), ch, cost)
        add(report.total, ch, cost)
      }
    }
  }
  return report
}

/** Cost of one task on a channel, the figure that survives a busy or a quiet day. */
export function costPerTask(t: ChannelTotals | undefined): number | null {
  return t && t.tasks > 0 ? t.cost / t.tasks : null
}
