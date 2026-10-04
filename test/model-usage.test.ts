import { describe, expect, it } from "vitest"
import { primaryModelFromUsage } from "../src/agents/model-usage"

// #455 — the CLI's `modelUsage` lists every model a run called. A
// multi-step Sonnet run also makes small Haiku side calls, and Haiku can
// come first, so the billed model must be the one the run spent most on.

describe("primaryModelFromUsage", () => {
  it("takes the model with the highest cost, not the first key", () => {
    expect(primaryModelFromUsage({
      "claude-haiku-4-5-20251001": { inputTokens: 900, outputTokens: 40, costUSD: 0.0011 },
      "claude-sonnet-5-5": { inputTokens: 8, outputTokens: 455, cacheReadInputTokens: 128_000, costUSD: 0.075 },
    })).toBe("claude-sonnet-5-5")
  })

  it("falls back to the most tokens when no cost is given", () => {
    expect(primaryModelFromUsage({
      a: { inputTokens: 10, outputTokens: 5 },
      b: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2000 },
    })).toBe("b")
  })

  it("returns the only model, and undefined when there is none", () => {
    expect(primaryModelFromUsage({ "claude-sonnet-5-5": { costUSD: 0.03 } })).toBe("claude-sonnet-5-5")
    expect(primaryModelFromUsage({})).toBeUndefined()
    expect(primaryModelFromUsage(undefined)).toBeUndefined()
    expect(primaryModelFromUsage("x")).toBeUndefined()
  })
})
