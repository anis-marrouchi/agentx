import { describe, it, expect, beforeEach } from "vitest"
import {
  setDispatchBudget, clearDispatchHistory, recordClaudeCodeDispatch, recordRateLimitEvent,
  parseRateLimitEvent, preflightQuotaGate, warnIfNearingCap, getClaudeCodeUsage, activeProviderHold,
} from "../src/agents/claude-code-quota"
import { daemonConfigSchema } from "../src/daemon/config"

// The dispatch gate trusts Claude Code's own rate_limit_event for the plan
// window. Local dispatch caps are opt-in and sit on top of it.

const T0 = Date.UTC(2026, 9, 2, 9, 0, 0)
const sec = (ms: number) => Math.floor(ms / 1000)
const rl = (status: string, extra: Record<string, unknown> = {}) => ({
  type: "rate_limit_event",
  rate_limit_info: { status, rateLimitType: "five_hour", resetsAt: sec(T0 + 40 * 60_000), ...extra },
})

beforeEach(() => {
  clearDispatchHistory()
  setDispatchBudget(undefined)
})

describe("config", () => {
  it("has no local cap unless the operator sets one", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(cfg.session.maxClaudeCodeDispatchesPerHour).toBeUndefined()
    expect(cfg.session.maxClaudeCodeDispatchesPer5h).toBeUndefined()
  })

  it("accepts 0 as off", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, session: { maxClaudeCodeDispatchesPer5h: 0 } })
    expect(cfg.session.maxClaudeCodeDispatchesPer5h).toBe(0)
  })
})

describe("counters without a cap", () => {
  it("never gates, however many dispatches fired", () => {
    for (let i = 0; i < 500; i++) recordClaudeCodeDispatch(T0 + i * 1000)
    expect(preflightQuotaGate(false, T0 + 600_000)).toBeNull()
    expect(warnIfNearingCap(T0 + 600_000)).toBeNull()
    const u = getClaudeCodeUsage(T0 + 600_000)
    expect(u.last5h).toBe(500)
    expect(u.maxPer5h).toBeUndefined()
  })

  it("treats a cap of 0 as off", () => {
    setDispatchBudget({ maxPer5h: 0, maxPerHour: 0 })
    for (let i = 0; i < 10; i++) recordClaudeCodeDispatch(T0 + i)
    expect(preflightQuotaGate(false, T0 + 10)).toBeNull()
  })
})

describe("provider signal", () => {
  it("parses Claude Code's rate_limit_event, resetsAt in seconds", () => {
    const s = parseRateLimitEvent(rl("allowed_warning", { utilization: 0.87 }), T0)
    expect(s).toMatchObject({ status: "allowed_warning", window: "five_hour", utilization: 0.87, resetsAt: T0 + 40 * 60_000 })
  })

  it("ignores every other event", () => {
    expect(recordRateLimitEvent({ type: "assistant", message: {} })).toBeNull()
    expect(recordRateLimitEvent({ type: "rate_limit_event" })).toBeNull()
    expect(recordRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "weird" } })).toBeNull()
    expect(recordRateLimitEvent(null)).toBeNull()
  })

  it("holds cold dispatches while a window is rejected, warm ones pass", () => {
    recordRateLimitEvent(rl("rejected", { utilization: 1 }), T0)
    const abort = preflightQuotaGate(false, T0 + 60_000)
    expect(abort?.reason).toBe("provider_rate_limit")
    expect(abort?.message).toContain("five hour")
    expect(abort?.message).toContain("in about 39 min")
    expect(preflightQuotaGate(true, T0 + 60_000)).toBeNull()
  })

  it("releases the hold once the reported reset time passes", () => {
    recordRateLimitEvent(rl("rejected"), T0)
    expect(activeProviderHold(T0 + 40 * 60_000 + 1)).toBeNull()
    expect(preflightQuotaGate(false, T0 + 41 * 60_000)).toBeNull()
  })

  it("releases the hold when a later event for the window says allowed", () => {
    recordRateLimitEvent(rl("rejected"), T0)
    recordRateLimitEvent(rl("allowed"), T0 + 5_000)
    expect(preflightQuotaGate(false, T0 + 10_000)).toBeNull()
  })

  it("holds for a bounded time when rejected comes without a reset time", () => {
    recordRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } }, T0)
    expect(preflightQuotaGate(false, T0 + 14 * 60_000)?.reason).toBe("provider_rate_limit")
    expect(preflightQuotaGate(false, T0 + 16 * 60_000)).toBeNull()
  })

  it("warns, but does not gate, on allowed_warning", () => {
    recordRateLimitEvent(rl("allowed_warning", { utilization: 0.9 }), T0)
    expect(preflightQuotaGate(false, T0 + 1000)).toBeNull()
    expect(warnIfNearingCap(T0 + 1000)).toMatch(/five hour window nearing its limit \(90% used\)/)
  })

  it("keeps the latest signal per window and exposes them newest first", () => {
    recordRateLimitEvent(rl("allowed"), T0)
    recordRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day" } }, T0 + 1)
    recordRateLimitEvent(rl("allowed_warning"), T0 + 2)
    const u = getClaudeCodeUsage(T0 + 3)
    expect(u.provider.map((s) => s.window)).toEqual(["five_hour", "seven_day"])
    expect(u.provider[0].status).toBe("allowed_warning")
  })
})

describe("local caps (opt-in)", () => {
  it("gates cold dispatches at the 5h cap and names the real setting", () => {
    setDispatchBudget({ maxPer5h: 3 })
    for (let i = 0; i < 3; i++) recordClaudeCodeDispatch(T0 + i)
    const abort = preflightQuotaGate(false, T0 + 10)
    expect(abort?.reason).toBe("five_hour_cap")
    expect(abort?.message).toContain("session.maxClaudeCodeDispatchesPer5h")
    expect(abort?.message).not.toContain("agents.budget")
    expect(preflightQuotaGate(true, T0 + 10)).toBeNull()
  })

  it("gates at the hourly cap and clears as dispatches age out", () => {
    setDispatchBudget({ maxPerHour: 2 })
    recordClaudeCodeDispatch(T0)
    recordClaudeCodeDispatch(T0 + 1)
    expect(preflightQuotaGate(false, T0 + 2)?.reason).toBe("hourly_cap")
    expect(preflightQuotaGate(false, T0 + 61 * 60_000)).toBeNull()
  })

  it("warns at 80% of a cap", () => {
    setDispatchBudget({ maxPer5h: 10 })
    for (let i = 0; i < 8; i++) recordClaudeCodeDispatch(T0 + i)
    expect(warnIfNearingCap(T0 + 10)).toBe("claude-code 5h usage 8/10 (80% of local cap)")
  })

  it("lets the provider hold take precedence over a local cap", () => {
    setDispatchBudget({ maxPer5h: 1 })
    recordClaudeCodeDispatch(T0)
    recordRateLimitEvent(rl("rejected"), T0)
    expect(preflightQuotaGate(false, T0 + 1)?.reason).toBe("provider_rate_limit")
  })
})
