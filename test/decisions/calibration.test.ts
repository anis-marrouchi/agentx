import { describe, it, expect } from "vitest"
import {
  agreement,
  applyTemperature,
  brier,
  calibrationReport,
  coverageCurve,
  ece,
  fitTemperature,
  logLoss,
  reliabilityBins,
} from "../../src/decisions/calibration"
import type { GradedRow } from "../../src/decisions/store"

/** Deterministic PRNG so "≈" assertions are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function row(p: number, correct: boolean, extra: Partial<GradedRow> = {}): GradedRow {
  return {
    callId: "c",
    seat: "s",
    ts: 0,
    backend: "mock",
    model: "m",
    structureMode: "mock",
    question: "q",
    type: "choice",
    predicted: "yes",
    confidence: p,
    probabilities: { yes: p, no: 1 - p },
    truth: correct ? "yes" : "no",
    ...extra,
  }
}

/** A generator that is right exactly as often as it claims. */
function perfectlyCalibrated(n: number, rng: () => number): GradedRow[] {
  return Array.from({ length: n }, () => {
    const p = 0.5 + rng() * 0.5 // choice confidence lives in [0.5, 1]
    return row(p, rng() < p)
  })
}

/** The failure mode this whole module exists to detect: always claims 0.9,
 *  is right 60% of the time. */
function overconfident(n: number, rng: () => number): GradedRow[] {
  return Array.from({ length: n }, () => row(0.9, rng() < 0.6))
}

describe("calibration metrics on generators with known answers", () => {
  it("a perfectly-calibrated generator scores near zero ECE", () => {
    const rows = perfectlyCalibrated(4000, mulberry32(1))
    expect(ece(rows, 10)).toBeLessThan(0.03)
  })

  it("an overconfident generator scores an ECE near the gap it actually has", () => {
    const rows = overconfident(4000, mulberry32(2))
    // Claims 0.9, delivers 0.6 — the gap is 0.30.
    expect(ece(rows, 10)).toBeCloseTo(0.3, 1)
  })

  it("temperature fitting recovers T > 1 for an overconfident generator and cuts NLL", () => {
    const rows = overconfident(4000, mulberry32(3))
    const fit = fitTemperature(rows)
    expect(fit.temperature).toBeGreaterThan(1)
    expect(fit.nll).toBeLessThan(fit.nllBefore)
  })

  it("temperature fitting leaves a calibrated generator roughly alone", () => {
    const rows = perfectlyCalibrated(4000, mulberry32(4))
    const fit = fitTemperature(rows)
    expect(fit.temperature).toBeGreaterThan(0.7)
    expect(fit.temperature).toBeLessThan(1.4)
  })

  it("applyTemperature softens above one and sharpens below", () => {
    const p = { a: 0.9, b: 0.1 }
    expect(applyTemperature(p, 2).a).toBeLessThan(0.9)
    expect(applyTemperature(p, 0.5).a).toBeGreaterThan(0.9)
    const softened = applyTemperature(p, 2)
    expect(softened.a + softened.b).toBeCloseTo(1, 10)
  })

  it("Brier rewards honesty in a way ECE alone does not", () => {
    const honest = perfectlyCalibrated(2000, mulberry32(5))
    const bluffing = overconfident(2000, mulberry32(6))
    expect(brier(honest)).toBeLessThan(brier(bluffing))
    expect(logLoss(honest)).toBeLessThan(logLoss(bluffing))
  })
})

describe("reliability bins", () => {
  it("equal-mass bins split the rows evenly, equal-width does not", () => {
    // 90% of the mass sits in the top confidence bin.
    const rows = [
      ...Array.from({ length: 90 }, () => row(0.95, true)),
      ...Array.from({ length: 10 }, () => row(0.55, false)),
    ]
    const width = reliabilityBins(rows, 10, "width")
    const mass = reliabilityBins(rows, 10, "mass")
    expect(Math.max(...width.map((b) => b.n))).toBe(90)
    expect(Math.max(...mass.map((b) => b.n))).toBeLessThanOrEqual(10)
  })

  it("ignores rows with no ground truth", () => {
    const rows = [row(0.9, true), { ...row(0.9, true), truth: undefined }]
    expect(reliabilityBins(rows, 10).reduce((n, b) => n + b.n, 0)).toBe(1)
  })
})

describe("coverage curve", () => {
  it("trades coverage for accuracy as the threshold rises", () => {
    const rows = [
      ...Array.from({ length: 50 }, () => row(0.9, true)),
      ...Array.from({ length: 50 }, () => row(0.3, false)),
    ]
    const curve = coverageCurve(rows, 10)
    const at0 = curve.find((p) => p.threshold === 0)!
    const at05 = curve.find((p) => p.threshold === 0.5)!
    expect(at0.coverage).toBe(1)
    expect(at0.accuracy).toBeCloseTo(0.5, 10)
    expect(at05.coverage).toBeCloseTo(0.5, 10)
    expect(at05.accuracy).toBeCloseTo(1, 10)
  })
})

describe("agreement", () => {
  it("corrects for chance — two systems that always say the same thing share no information", () => {
    const rows = Array.from({ length: 100 }, () =>
      row(0.9, true, { predicted: "no", incumbent: "no" }),
    )
    const result = agreement(rows)
    expect(result.rate).toBe(1)
    // Both are constant, so chance agreement is also 1 and kappa is undefined
    // in the usual sense; we report 1 rather than NaN.
    expect(result.kappa).toBe(1)
  })

  it("scores real disagreement", () => {
    const rows = [
      ...Array.from({ length: 60 }, () => row(0.9, true, { predicted: "yes", incumbent: "yes" })),
      ...Array.from({ length: 40 }, () => row(0.9, true, { predicted: "yes", incumbent: "no" })),
    ]
    const result = agreement(rows)
    expect(result.n).toBe(100)
    expect(result.rate).toBeCloseTo(0.6, 10)
  })

  it("ignores rows with no incumbent", () => {
    expect(agreement([row(0.9, true)]).n).toBe(0)
  })
})

describe("calibrationReport", () => {
  it("refuses to report an ECE below minN", () => {
    const rows = perfectlyCalibrated(99, mulberry32(7))
    const report = calibrationReport(rows, { minN: 100 })
    expect(report.insufficient).toBe(true)
    expect(report.nLabeled).toBe(99)
    expect(report.ece).toBeUndefined()
    expect(report.coverage).toBeUndefined()
  })

  it("reports agreement even when there is not enough ground truth", () => {
    const rows = Array.from({ length: 10 }, () =>
      row(0.9, true, { predicted: "yes", incumbent: "yes", truth: undefined }),
    )
    const report = calibrationReport(rows, { minN: 100 })
    expect(report.insufficient).toBe(true)
    expect(report.agreement.n).toBe(10)
    expect(report.agreement.rate).toBe(1)
  })

  it("reports the full set once there is enough, with a bootstrap interval around ECE", () => {
    const rows = overconfident(500, mulberry32(8))
    const report = calibrationReport(rows, { minN: 100, bootstrap: 200, rng: mulberry32(9) })
    expect(report.insufficient).toBe(false)
    expect(report.ece).toBeCloseTo(0.3, 1)
    expect(report.eceInterval!.lo).toBeLessThanOrEqual(report.ece!)
    expect(report.eceInterval!.hi).toBeGreaterThanOrEqual(report.ece!)
    expect(report.temperature!.temperature).toBeGreaterThan(1)
    expect(report.coverage!.length).toBeGreaterThan(0)
  })
})
