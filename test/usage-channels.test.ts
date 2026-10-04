import { describe, it, expect } from "vitest"
import { channelCosts, costPerTask } from "../src/daemon/usage-channels"
import type { DailyUsage } from "../src/daemon/token-tracker"

const ch = (tasks: number, cacheRead: number) => ({
  tasks,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: cacheRead,
  cacheCreateTokens: 0,
  tier2InputTokens: 0,
  tier2OutputTokens: 0,
  tier2CacheReadTokens: 5,
  tier2CacheCreateTokens: 0,
  totalDuration: 0,
  errors: 0,
})

const days: Record<string, DailyUsage> = {
  "2026-10-01": { date: "2026-10-01", agents: { a: { byChannel: { github: ch(2, 100), cron: ch(1, 50) } } as any } },
  "2026-10-03": { date: "2026-10-03", agents: { a: { byChannel: { github: ch(3, 200) } } as any, b: { byChannel: { github: ch(1, 1) } } as any } },
  "2026-10-04": { date: "2026-10-04", agents: { a: { byChannel: { github: ch(99, 9999) } } as any } },
}
const tracker = {
  getDate: (date: string) => days[date] || null,
  // One unit of cost per cache-read token keeps the sums readable.
  cost: (u: any) => (u.cacheReadTokens || 0) + (u.tier2CacheReadTokens || 0),
}

describe("channelCosts", () => {
  it("sums each channel across agents and days inside the range only", () => {
    const report = channelCosts(tracker, "2026-10-01", "2026-10-03")
    expect(report.days).toBe(2) // 10-02 has no file, 10-04 is outside
    expect(report.channels.github).toMatchObject({ tasks: 6, cacheRead: 316, cost: 316 })
    expect(report.channels.cron).toMatchObject({ tasks: 1, cacheRead: 55 })
    expect(report.total).toMatchObject({ tasks: 7, cost: 371 })
    expect(costPerTask(report.channels.github)).toBeCloseTo(316 / 6)
  })

  it("has no cost per task for a channel with no tasks", () => {
    expect(costPerTask(undefined)).toBeNull()
    expect(costPerTask(channelCosts(tracker, "2026-09-01", "2026-09-02").total)).toBeNull()
  })
})
