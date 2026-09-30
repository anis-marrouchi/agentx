import { describe, it, expect, vi } from "vitest"
import { withBudget, StepBudgetExceeded } from "../src/agents/until-aborted"

// A preparation step had no limit of its own: a seat call that neither
// answered nor failed held the run for the whole 300 s pre-spawn deadline,
// and the message was dropped with an internal error (#340). Each step now
// races its own budget and the run continues without a best-effort step.

describe("withBudget", () => {
  it("passes a value through when the work settles in time", async () => {
    await expect(withBudget(Promise.resolve(42), 1_000, "x")).resolves.toBe(42)
  })
  it("passes a rejection through unchanged", async () => {
    await expect(withBudget(Promise.reject(new Error("boom")), 1_000, "x")).rejects.toThrow("boom")
  })
  it("rejects with StepBudgetExceeded when the work never settles", async () => {
    vi.useFakeTimers()
    try {
      const p = withBudget(new Promise<never>(() => {}), 5_000, "route-model")
      const settled = p.catch((e) => e)
      vi.advanceTimersByTime(5_001)
      const err = await settled
      expect(err).toBeInstanceOf(StepBudgetExceeded)
      expect(err.step).toBe("route-model")
      expect(err.message).toMatch(/route-model.*5s budget/)
    } finally {
      vi.useRealTimers()
    }
  })
  it("no budget means no race", async () => {
    const work = Promise.resolve("v")
    expect(withBudget(work, 0, "x")).toBe(work)
  })
})
