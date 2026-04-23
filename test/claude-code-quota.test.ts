import { describe, it, expect, beforeEach } from "vitest"
import {
  setDispatchBudget,
  clearDispatchHistory,
  recordClaudeCodeDispatch,
  getClaudeCodeUsage,
  preflightQuotaGate,
  warnIfNearingCap,
} from "../src/agents/claude-code-quota"

describe("claude-code-quota", () => {
  beforeEach(() => {
    clearDispatchHistory()
    setDispatchBudget({ maxPerHour: 10, maxPer5h: 30, warnRatio: 0.8 })
  })

  it("counts only dispatches in the last hour and last 5h", () => {
    const now = 1_000_000_000_000
    recordClaudeCodeDispatch(now - 6 * 60 * 60 * 1000) // 6h ago — pruned
    recordClaudeCodeDispatch(now - 2 * 60 * 60 * 1000) // 2h ago — in 5h, not 1h
    recordClaudeCodeDispatch(now - 30 * 60 * 1000)      // 30 min ago — in both
    recordClaudeCodeDispatch(now - 5 * 60 * 1000)       // 5 min ago — in both
    const u = getClaudeCodeUsage(now)
    expect(u.lastHour).toBe(2)
    expect(u.last5h).toBe(3)
  })

  it("lets warm sessions through even when over cap", () => {
    const now = 2_000_000_000_000
    for (let i = 0; i < 15; i++) recordClaudeCodeDispatch(now - i * 1000)
    expect(preflightQuotaGate(true, now)).toBeNull()
  })

  it("gates cold dispatches when hourly cap is hit", () => {
    const now = 3_000_000_000_000
    for (let i = 0; i < 10; i++) recordClaudeCodeDispatch(now - i * 1000)
    const g = preflightQuotaGate(false, now)
    expect(g?.abort).toBe(true)
    expect(g?.reason).toBe("hourly_cap")
    expect(g?.message).toMatch(/10\/10/)
  })

  it("gates cold dispatches when 5h cap is hit before hourly", () => {
    setDispatchBudget({ maxPerHour: 100, maxPer5h: 20 })
    const now = 4_000_000_000_000
    // 20 dispatches spread over 5h so hourly stays low
    for (let i = 0; i < 20; i++) recordClaudeCodeDispatch(now - i * 10 * 60 * 1000)
    const g = preflightQuotaGate(false, now)
    expect(g?.reason).toBe("five_hour_cap")
  })

  it("emits a warning at 80% and no warning below", () => {
    const now = 5_000_000_000_000
    for (let i = 0; i < 7; i++) recordClaudeCodeDispatch(now - i * 1000)
    expect(warnIfNearingCap(now)).toBeNull()  // 7/10 = 70%, below 80%
    recordClaudeCodeDispatch(now - 100)
    const w = warnIfNearingCap(now)
    expect(w).toMatch(/hourly.*8\/10.*80%/)
  })

  it("is a no-op when no budget is configured", () => {
    setDispatchBudget(undefined)
    const now = 6_000_000_000_000
    for (let i = 0; i < 1000; i++) recordClaudeCodeDispatch(now - i * 1000)
    expect(preflightQuotaGate(false, now)).toBeNull()
    expect(warnIfNearingCap(now)).toBeNull()
  })
})
