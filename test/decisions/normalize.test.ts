import { describe, it, expect } from "vitest"
import {
  confidenceFor,
  expectedScore,
  finalizeAnswer,
  normalizeDistribution,
  normalizedNegEntropy,
  pMax,
} from "../../src/decisions/normalize"
import { choice, noul, score } from "../../src/decisions/questions"
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "../../src/decisions/types"

const LABELS = ["a", "b", "c"]

describe("normalizeDistribution", () => {
  it("rescales to sum one and reports no repair for a clean distribution", () => {
    const { probs, repaired } = normalizeDistribution({ a: 0.2, b: 0.3, c: 0.5 }, LABELS)
    expect(probs).toEqual({ a: 0.2, b: 0.3, c: 0.5 })
    expect(repaired).toBe(false)
  })

  it("rescales an unnormalized distribution and flags the repair", () => {
    const { probs, repaired } = normalizeDistribution({ a: 2, b: 3, c: 5 }, LABELS)
    expect(probs.a).toBeCloseTo(0.2, 10)
    expect(probs.c).toBeCloseTo(0.5, 10)
    expect(repaired).toBe(true)
  })

  it("zeroes negative and non-finite values", () => {
    const { probs, repaired } = normalizeDistribution(
      { a: -1, b: Number.NaN, c: 4 },
      LABELS,
      { normalize: false },
    )
    expect(probs).toEqual({ a: 0, b: 0, c: 4 })
    expect(repaired).toBe(true)
  })

  it("fills a missing label with epsilon", () => {
    const { probs, repaired } = normalizeDistribution({ a: 1, b: 1 }, LABELS, { normalize: false })
    expect(probs.c).toBe(1e-6)
    expect(repaired).toBe(true)
  })

  it("ignores extra labels but records that the model went off-schema", () => {
    const { probs, repaired } = normalizeDistribution(
      { a: 1, b: 1, c: 1, d: 1 },
      LABELS,
      { normalize: false },
    )
    expect(Object.keys(probs)).toEqual(LABELS)
    expect(repaired).toBe(true)
  })

  it("falls back to uniform when nothing usable came back", () => {
    for (const raw of [{ a: 0, b: 0, c: 0 }, "not an object", null, ["a"], undefined]) {
      const { probs, repaired } = normalizeDistribution(raw, LABELS)
      expect(probs.a).toBeCloseTo(1 / 3, 10)
      expect(repaired).toBe(true)
    }
  })
})

describe("confidence statistics", () => {
  it("negEntropy is zero on uniform and one on a point mass", () => {
    expect(normalizedNegEntropy({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })).toBeCloseTo(0, 10)
    expect(normalizedNegEntropy({ a: 1, b: 0, c: 0 })).toBeCloseTo(1, 10)
  })

  it("negEntropy is comparable across option counts, pMax is not", () => {
    const two = { a: 0.5, b: 0.5 }
    const ten: Record<string, number> = {}
    for (let i = 0; i < 10; i++) ten[`o${i}`] = 0.1

    // Both are maximally uncertain, and negEntropy says so.
    expect(normalizedNegEntropy(two)).toBeCloseTo(0, 10)
    expect(normalizedNegEntropy(ten)).toBeCloseTo(0, 10)
    // pMax would rank the 10-way as five times less confident. This is why
    // `confidence` reports negEntropy.
    expect(pMax(two)).toBeCloseTo(0.5, 10)
    expect(pMax(ten)).toBeCloseTo(0.1, 10)
  })

  it("a single-outcome distribution is fully confident", () => {
    expect(normalizedNegEntropy({ a: 1 })).toBe(1)
  })

  it("expectedScore weights level indices by probability", () => {
    expect(expectedScore({ "0": 0.5, "1": 0.5 })).toBeCloseTo(0.5, 10)
    expect(expectedScore({ "0": 0, "1": 0, "2": 1 })).toBeCloseTo(2, 10)
    expect(expectedScore({ "0": 0.25, "1": 0.5, "2": 0.25 })).toBeCloseTo(1, 10)
  })

  it("confidenceFor is negEntropy", () => {
    const p = { a: 0.7, b: 0.3 }
    expect(confidenceFor(p)).toBe(normalizedNegEntropy(p))
  })
})

describe("finalizeAnswer", () => {
  it("derives choice, confidence and both statistics; the model reports none of them", () => {
    const q = choice({ billing: null, technical: null, other: null })
    const { answer, repaired } = finalizeAnswer(q, {
      probabilities: { billing: 0.7, technical: 0.2, other: 0.1 },
    })
    const a = answer as ChoiceAnswer
    expect(a.type).toBe("choice")
    expect(a.choice).toBe("billing")
    expect(a.pMax).toBeCloseTo(0.7, 10)
    expect(a.confidence).toBeCloseTo(a.negEntropy, 10)
    expect(a.confidence).toBeGreaterThan(0)
    expect(a.confidence).toBeLessThan(1)
    expect(repaired).toBe(false)
  })

  it("ignores a model-reported choice that disagrees with its own numbers", () => {
    const q = choice({ yes: null, no: null })
    const raw = { probabilities: { yes: 0.1, no: 0.9 }, choice: "yes", confidence: 0.99 }
    const a = finalizeAnswer(q, raw as never).answer as ChoiceAnswer
    expect(a.choice).toBe("no")
    expect(a.confidence).toBeLessThan(0.99)
  })

  it("builds a score with its legend and an expected value between levels", () => {
    const q = score(["poor", "fine", "good"])
    const a = finalizeAnswer(q, { probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } })
      .answer as ScoreAnswer
    expect(a.type).toBe("score")
    expect(a.score).toBeCloseTo(1.2, 10)
    expect(a.legend).toEqual({ "0": "poor", "1": "fine", "2": "good" })
  })

  it("passes a noul probability through and carries no confidence field", () => {
    const { answer, repaired } = finalizeAnswer(noul("urgent?"), { noul: 0.82 })
    const a = answer as NoulAnswer
    expect(a).toEqual({ type: "noul", noul: 0.82 })
    expect("confidence" in a).toBe(false)
    expect(repaired).toBe(false)
  })

  it("repairs an out-of-range noul to maximum uncertainty", () => {
    for (const bad of [1.5, -0.2, Number.NaN, "yes" as never]) {
      const { answer, repaired } = finalizeAnswer(noul(), { noul: bad as number })
      expect((answer as NoulAnswer).noul).toBe(0.5)
      expect(repaired).toBe(true)
    }
  })

  it("an unusable distribution yields zero confidence, so a gated call site escalates", () => {
    const q = choice({ a: null, b: null })
    const a = finalizeAnswer(q, { probabilities: {} }).answer as ChoiceAnswer
    expect(a.confidence).toBeCloseTo(0, 10)
  })
})
