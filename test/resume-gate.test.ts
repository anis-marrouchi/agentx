import { describe, it, expect } from "vitest"
import { CACHE_READ_FACTOR, DEFAULT_REQUESTS_PER_TURN, decideResume, describeResume, requestsPerTurn, type ResumeGateSettings } from "../src/agents/resume-gate"
import { daemonConfigSchema } from "../src/daemon/config"

// #621 step 3: resume a session only when replaying it is not much dearer
// than a fresh lean start.

const S: ResumeGateSettings = { mode: "active", freshTokens: 30_000, cacheTtlMinutes: 60, cacheWriteFactor: 2, margin: 1.5 }
const MIN = 60_000

describe("requestsPerTurn", () => {
  it("is the turn's summed input over its context, clamped", () => {
    expect(requestsPerTurn(50_000, 500_000)).toBe(10)
    expect(requestsPerTurn(50_000, 20_000)).toBe(1)
    expect(requestsPerTurn(1_000, 10_000_000)).toBe(200)
  })

  it("falls back when the last turn left no reading", () => {
    expect(requestsPerTurn(undefined, 500_000)).toBe(DEFAULT_REQUESTS_PER_TURN)
    expect(requestsPerTurn(50_000, 0)).toBe(DEFAULT_REQUESTS_PER_TURN)
  })
})

describe("decideResume", () => {
  it("keeps a warm, small session", () => {
    const r = decideResume({ contextTokens: 40_000, turnInputTokens: 400_000, idleMs: 5 * MIN }, S)
    expect(r.warm).toBe(true)
    expect(r.rotate).toBe(false)
    // 40k × (0.1 + 0.1 × 9) against 30k × (2 + 0.1 × 9)
    expect(r.resumeCost).toBeCloseTo(40_000 * (CACHE_READ_FACTOR + 0.9))
    expect(r.freshCost).toBeCloseTo(30_000 * (2 + 0.9))
  })

  it("starts fresh when a cold cache would rewrite a large transcript", () => {
    const r = decideResume({ contextTokens: 60_000, turnInputTokens: 600_000, idleMs: 2 * 60 * MIN }, S)
    expect(r.warm).toBe(false)
    expect(r.rotate).toBe(true) // 60k vs 30k on the same pattern: twice as dear
  })

  it("keeps a cold session that is not dear enough to beat the margin", () => {
    const r = decideResume({ contextTokens: 40_000, turnInputTokens: 400_000, idleMs: 2 * 60 * MIN }, S)
    expect(r.rotate).toBe(false) // 1.33× < 1.5×
  })

  it("starts fresh on a warm cache once the transcript dwarfs a fresh start", () => {
    // 150k × 1.0 = 150k against 30k × 2.9 = 87k: 1.72×
    expect(decideResume({ contextTokens: 150_000, turnInputTokens: 1_500_000, idleMs: MIN }, S).rotate).toBe(true)
  })

  it("never rotates without a context reading", () => {
    const r = decideResume({ contextTokens: 0, turnInputTokens: 900_000, idleMs: 10 * 60 * MIN }, S)
    expect(r).toMatchObject({ rotate: false, resumeCost: null })
    expect(describeResume(r)).toMatch(/^resume: no context reading/)
  })

  it("treats the TTL as the warm/cold line", () => {
    const at = (idle: number) => decideResume({ contextTokens: 60_000, turnInputTokens: 600_000, idleMs: idle }, S).warm
    expect(at(60 * MIN - 1)).toBe(true)
    expect(at(60 * MIN)).toBe(false)
  })

  it("describes what it saw", () => {
    const r = decideResume({ contextTokens: 60_000, turnInputTokens: 600_000, idleMs: 2 * 60 * MIN }, S)
    expect(describeResume(r)).toBe("start fresh: resume ≈174k, fresh ≈87k input-token equivalents (cold cache, 10 requests/turn)")
  })
})

describe("config", () => {
  it("is off by default", () => {
    const c = daemonConfigSchema.parse({ node: { id: "n", name: "n" } })
    expect(c.session.resumeGate).toEqual({ mode: "off", freshTokens: 30_000, cacheTtlMinutes: 60, cacheWriteFactor: 2, margin: 1.5 })
  })
})
