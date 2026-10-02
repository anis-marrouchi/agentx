import { describe, it, expect, beforeEach } from "vitest"
import {
  setDispatchBudget, clearDispatchHistory, recordClaudeCodeDispatch, recordRateLimitEvent,
  parseRateLimitEvent, preflightQuotaGate, warnIfNearingCap, getClaudeCodeUsage, activeProviderHold,
  activeProviderHolds, liftProviderHolds,
} from "../src/agents/claude-code-quota"
import { handlePlanUsageApi } from "../src/daemon/plan-usage-api"
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

const win = (status: string, rateLimitType: string) =>
  ({ type: "rate_limit_event", rate_limit_info: { status, rateLimitType, resetsAt: (T0 + 40 * 60_000) / 1000 } })

describe("hold scope and lifting", () => {
  it("lifts a hold when a later event for another window says allowed", () => {
    recordRateLimitEvent(win("rejected", "five_hour"), T0)
    recordRateLimitEvent(win("allowed", "seven_day"), T0 + 5_000)
    expect(preflightQuotaGate(false, T0 + 10_000)).toBeNull()
    expect(getClaudeCodeUsage(T0 + 10_000).provider.map((s) => s.window)).toEqual(["seven_day"])
  })

  it("keeps the hold when the other window is rejected too", () => {
    recordRateLimitEvent(win("rejected", "five_hour"), T0)
    recordRateLimitEvent(win("rejected", "seven_day"), T0 + 5_000)
    expect(activeProviderHolds(T0 + 10_000)).toHaveLength(2)
  })

  it("holds only runs on the model a model window names", () => {
    recordRateLimitEvent(win("rejected", "seven_day_opus"), T0, "claude-opus-5-5")
    expect(preflightQuotaGate(false, T0 + 1000, "claude-opus-5-5")?.reason).toBe("provider_rate_limit")
    expect(preflightQuotaGate(false, T0 + 1000, "opus")?.reason).toBe("provider_rate_limit")
    expect(preflightQuotaGate(false, T0 + 1000, "claude-sonnet-5-5")).toBeNull()
    expect(preflightQuotaGate(false, T0 + 1000, "claude-haiku-4-5-20251001")).toBeNull()
  })

  it("holds a run with no model set on a model window", () => {
    recordRateLimitEvent(win("rejected", "seven_day_sonnet"), T0)
    expect(preflightQuotaGate(false, T0 + 1000)?.reason).toBe("provider_rate_limit")
  })

  it("a shared window holds every model", () => {
    recordRateLimitEvent(win("rejected", "five_hour"), T0, "claude-opus-5-5")
    expect(preflightQuotaGate(false, T0 + 1000, "claude-sonnet-5-5")?.reason).toBe("provider_rate_limit")
  })

  it("lifts a model window's hold only on an allowed event from that model", () => {
    recordRateLimitEvent(win("rejected", "seven_day_opus"), T0, "claude-opus-5-5")
    recordRateLimitEvent(win("allowed", "five_hour"), T0 + 1000, "claude-sonnet-5-5")
    recordRateLimitEvent(win("allowed", "five_hour"), T0 + 2000)
    expect(activeProviderHold(T0 + 3000, "claude-opus-5-5")?.window).toBe("seven_day_opus")
    recordRateLimitEvent(win("allowed", "five_hour"), T0 + 4000, "claude-opus-5-5")
    expect(activeProviderHold(T0 + 5000, "claude-opus-5-5")).toBeNull()
  })

  it("lifts the active holds by hand and leaves the other signals", () => {
    recordRateLimitEvent(win("allowed_warning", "seven_day_sonnet"), T0, "claude-sonnet-5-5")
    recordRateLimitEvent(win("rejected", "five_hour"), T0 + 1)
    recordRateLimitEvent(win("rejected", "seven_day_opus"), T0 + 2)
    expect(liftProviderHolds(T0 + 10).map((s) => s.window).sort()).toEqual(["five_hour", "seven_day_opus"])
    expect(preflightQuotaGate(false, T0 + 20)).toBeNull()
    expect(getClaudeCodeUsage(T0 + 20).provider.map((s) => s.window)).toEqual(["seven_day_sonnet"])
    expect(liftProviderHolds(T0 + 30)).toEqual([])
  })

  it("holds again when Claude refuses after a manual lift", () => {
    recordRateLimitEvent(win("rejected", "five_hour"), T0)
    liftProviderHolds(T0 + 10)
    recordRateLimitEvent(win("rejected", "five_hour"), T0 + 20)
    expect(preflightQuotaGate(false, T0 + 30)?.reason).toBe("provider_rate_limit")
  })

  it("names the lift command in the hold message", () => {
    recordRateLimitEvent(win("rejected", "five_hour"), T0)
    expect(preflightQuotaGate(false, T0 + 1000)?.message).toContain("agentx usage plan --lift")
  })
})

describe("GET /usage/plan and POST /usage/plan/lift", () => {
  it("returns the windows, the counters and the active holds", () => {
    setDispatchBudget({ maxPerHour: 80 })
    recordClaudeCodeDispatch(T0)
    recordRateLimitEvent(win("rejected", "five_hour"), T0)
    recordRateLimitEvent(win("rejected", "seven_day"), T0 - 41 * 60_000)
    const reply = handlePlanUsageApi("GET", "/usage/plan", T0 + 1000)
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ now: T0 + 1000, lastHour: 1, last5h: 1, maxPerHour: 80 })
    const body = reply.body as { provider: unknown[]; holds: Array<{ window: string }> }
    expect(body.provider).toHaveLength(2)
    expect(body.holds.map((s) => s.window)).toEqual(["five_hour", "seven_day"])
  })

  it("lifts the holds and reports which", () => {
    recordRateLimitEvent(win("rejected", "five_hour"), T0)
    const reply = handlePlanUsageApi("POST", "/usage/plan/lift", T0 + 1000)
    expect((reply.body as { lifted: Array<{ window: string }> }).lifted.map((s) => s.window)).toEqual(["five_hour"])
    expect((handlePlanUsageApi("GET", "/usage/plan", T0 + 2000).body as { holds: unknown[] }).holds).toEqual([])
  })

  it("refuses the wrong method", () => {
    expect(handlePlanUsageApi("GET", "/usage/plan/lift").status).toBe(405)
    expect(handlePlanUsageApi("POST", "/usage/plan").status).toBe(405)
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

  it("does not hold while extra usage still serves a used-up window", () => {
    recordRateLimitEvent(rl("rejected", { utilization: 1, overageStatus: "allowed", isUsingOverage: true }), T0)
    expect(activeProviderHold(T0 + 60_000)).toBeNull()
    expect(preflightQuotaGate(false, T0 + 60_000)).toBeNull()
    expect(getClaudeCodeUsage(T0 + 60_000).provider[0]).toMatchObject({ status: "rejected", usingOverage: true })
  })

  it("reads extra usage from overageStatus when isUsingOverage is missing", () => {
    for (const overageStatus of ["allowed", "allowed_warning"]) {
      clearDispatchHistory()
      recordRateLimitEvent(rl("rejected", { overageStatus }), T0)
      expect(preflightQuotaGate(false, T0 + 60_000)).toBeNull()
    }
  })

  it("holds when extra usage is used up or off", () => {
    recordRateLimitEvent(rl("rejected", { overageStatus: "rejected", isUsingOverage: false }), T0)
    expect(preflightQuotaGate(false, T0 + 60_000)?.reason).toBe("provider_rate_limit")
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
