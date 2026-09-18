import { describe, it, expect } from "vitest"
import {
  CACHE_AWARE_PRICING,
  getModelFamily,
  TokenTracker,
} from "../src/daemon/token-tracker"

describe("getModelFamily", () => {
  it("maps every current model to its own tier", () => {
    expect(getModelFamily("claude-opus-5")).toBe("claude-opus-5")
    expect(getModelFamily("claude-opus-4-8")).toBe("claude-opus-4-8")
    expect(getModelFamily("claude-opus-4-7")).toBe("claude-opus-4-7")
    expect(getModelFamily("claude-opus-4-6")).toBe("claude-opus-4-6")
    expect(getModelFamily("claude-sonnet-5")).toBe("claude-sonnet-5")
    expect(getModelFamily("claude-sonnet-4-6")).toBe("claude-sonnet")
    expect(getModelFamily("claude-haiku-4-5")).toBe("claude-haiku")
    expect(getModelFamily("claude-fable-5-1")).toBe("claude-fable")
  })

  it("still prices genuinely legacy Opus at the legacy tier", () => {
    expect(getModelFamily("claude-3-opus-20240229")).toBe("claude-opus")
    expect(getModelFamily("claude-opus-4-1")).toBe("claude-opus")
  })

  it("sends an unknown Opus to the current tier, not the legacy one", () => {
    // The regression this file exists for: claude-opus-5 matched "opus",
    // matched no version branch, and fell through to $15/$75 — inflating
    // every cost figure for the whole fleet by exactly 3x.
    expect(getModelFamily("claude-opus-9")).toBe("claude-opus-5")
    expect(CACHE_AWARE_PRICING[getModelFamily("claude-opus-9")].input).toBe(5)
  })
})

describe("cost", () => {
  const usage = {
    tasks: 59,
    inputTokens: 2_272,
    outputTokens: 754_328,
    cacheReadTokens: 186_444_082,
    cacheCreateTokens: 3_069_721,
  } as any

  it("prices Opus 5 at $5/$25, a third of the legacy tier", () => {
    const opus5 = TokenTracker.calculateCost(usage, "claude-opus-5")
    const legacy = TokenTracker.calculateCost(usage, "claude-opus-4-1")
    expect(legacy / opus5).toBeCloseTo(3, 5)
  })

  it("cache reads dominate a cache-heavy agent's bill", () => {
    const total = TokenTracker.calculateCost(usage, "claude-opus-5")
    const readOnly =
      (usage.cacheReadTokens / 1_000_000) * CACHE_AWARE_PRICING["claude-opus-5"].cacheRead
    expect(readOnly / total).toBeGreaterThan(0.4)
  })

  it("every pricing family keeps cacheRead at 0.1x and cacheCreate at 1.25x input", () => {
    for (const [family, p] of Object.entries(CACHE_AWARE_PRICING)) {
      expect(p.cacheRead, family).toBeCloseTo(p.input * 0.1, 6)
      expect(p.cacheCreate, family).toBeCloseTo(p.input * 1.25, 6)
      expect(p.output, family).toBeCloseTo(p.input * 5, 6)
    }
  })

  it("falls back to sonnet pricing only for genuinely unknown families", () => {
    const unknown = TokenTracker.calculateCost(usage, "some-other-vendor/model")
    const sonnet = TokenTracker.calculateCost(usage, "claude-sonnet-4-6")
    expect(unknown).toBeCloseTo(sonnet, 6)
  })
})
