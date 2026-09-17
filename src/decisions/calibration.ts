import type { GradedRow } from "./store"

// Does the confidence mean anything?
//
// Every metric here is a pure function of GradedRow[]. Three choices are
// deliberate and worth defending:
//
//   1. `minN` (default 100). Below it the report refuses to print an ECE.
//      An expected calibration error computed on thirty rows is noise, and
//      a noisy number on a dashboard gets acted on exactly as if it were a
//      real one.
//
//   2. `coverageCurve` is the headline, not ECE. The question a call site
//      actually asks is "what threshold do I set for autoRunThreshold" —
//      and that is answered by accuracy-at-threshold against the fraction
//      of traffic retained, not by a single aggregate score.
//
//   3. Equal-mass bins are reported alongside equal-width. Equal-width ECE
//      is dominated by whichever bin holds most of the mass, which for an
//      overconfident model is the top bin — precisely the regime we are
//      trying to detect.

export interface AgreementResult {
  n: number
  agree: number
  rate: number
  /** Cohen's kappa: agreement corrected for what chance alone would give.
   *  Two systems that both answer "no" 95% of the time agree 90% of the
   *  time while sharing no information, and kappa says so. */
  kappa: number
}

export function agreement(rows: GradedRow[]): AgreementResult {
  const usable = rows.filter((r) => r.incumbent !== undefined)
  const n = usable.length
  if (n === 0) return { n: 0, agree: 0, rate: 0, kappa: 0 }

  let agree = 0
  const predicted = new Map<string, number>()
  const incumbent = new Map<string, number>()
  for (const row of usable) {
    if (row.predicted === row.incumbent) agree++
    predicted.set(row.predicted, (predicted.get(row.predicted) ?? 0) + 1)
    incumbent.set(row.incumbent!, (incumbent.get(row.incumbent!) ?? 0) + 1)
  }

  const observed = agree / n
  let expected = 0
  for (const [label, count] of predicted) {
    expected += (count / n) * ((incumbent.get(label) ?? 0) / n)
  }
  const kappa = expected < 1 ? (observed - expected) / (1 - expected) : 1

  return { n, agree, rate: observed, kappa }
}

export interface ReliabilityBin {
  lo: number
  hi: number
  n: number
  meanConfidence: number
  accuracy: number
}

export type BinScheme = "width" | "mass"

export function reliabilityBins(
  rows: GradedRow[],
  bins = 10,
  scheme: BinScheme = "width",
): ReliabilityBin[] {
  const labeled = rows.filter((r) => r.truth !== undefined)
  if (labeled.length === 0) return []

  const sorted = [...labeled].sort((a, b) => a.confidence - b.confidence)
  const groups: GradedRow[][] =
    scheme === "mass" ? equalMassGroups(sorted, bins) : equalWidthGroups(sorted, bins)

  return groups
    .filter((g) => g.length > 0)
    .map((group) => {
      const confidences = group.map((r) => r.confidence)
      return {
        lo: Math.min(...confidences),
        hi: Math.max(...confidences),
        n: group.length,
        meanConfidence: mean(confidences),
        accuracy: mean(group.map((r) => (r.predicted === r.truth ? 1 : 0))),
      }
    })
}

/** Expected calibration error: the mass-weighted gap between how confident
 *  the model was and how often it was right. Zero is perfect. */
export function ece(rows: GradedRow[], bins = 10, scheme: BinScheme = "width"): number {
  const grouped = reliabilityBins(rows, bins, scheme)
  const total = grouped.reduce((sum, b) => sum + b.n, 0)
  if (total === 0) return 0
  return grouped.reduce(
    (sum, b) => sum + (b.n / total) * Math.abs(b.accuracy - b.meanConfidence),
    0,
  )
}

/** The worst single bin. ECE can look fine while one region is badly wrong. */
export function mce(rows: GradedRow[], bins = 10, scheme: BinScheme = "width"): number {
  const grouped = reliabilityBins(rows, bins, scheme)
  if (grouped.length === 0) return 0
  return Math.max(...grouped.map((b) => Math.abs(b.accuracy - b.meanConfidence)))
}

/** Multiclass Brier score. A proper scoring rule, so unlike ECE it cannot
 *  be gamed by a model that reports a constant confidence. Lower is better. */
export function brier(rows: GradedRow[]): number {
  const labeled = rows.filter((r) => r.truth !== undefined)
  if (labeled.length === 0) return 0
  return mean(
    labeled.map((row) => {
      let sum = 0
      for (const [label, p] of Object.entries(row.probabilities)) {
        const actual = label === row.truth ? 1 : 0
        sum += (p - actual) ** 2
      }
      return sum
    }),
  )
}

export function logLoss(rows: GradedRow[], epsilon = 1e-12): number {
  const labeled = rows.filter((r) => r.truth !== undefined)
  if (labeled.length === 0) return 0
  return mean(
    labeled.map((row) => {
      const p = row.probabilities[row.truth!] ?? 0
      return -Math.log(Math.max(p, epsilon))
    }),
  )
}

export interface CoveragePoint {
  threshold: number
  /** Fraction of rows at or above the threshold. */
  coverage: number
  /** Accuracy among those rows. */
  accuracy: number
  n: number
}

/** The curve a call site actually reads: "if I only act above confidence X,
 *  how often am I right, and how much traffic do I still handle?" */
export function coverageCurve(rows: GradedRow[], steps = 20): CoveragePoint[] {
  const labeled = rows.filter((r) => r.truth !== undefined)
  const total = labeled.length
  if (total === 0) return []

  const points: CoveragePoint[] = []
  for (let i = 0; i <= steps; i++) {
    const threshold = i / steps
    const kept = labeled.filter((r) => r.confidence >= threshold)
    points.push({
      threshold,
      coverage: kept.length / total,
      accuracy: kept.length > 0 ? mean(kept.map((r) => (r.predicted === r.truth ? 1 : 0))) : 0,
      n: kept.length,
    })
  }
  return points
}

/** Sharpen or soften a distribution: p^(1/T), renormalized. T > 1 softens
 *  (the fix for overconfidence), T < 1 sharpens. */
export function applyTemperature(
  probs: Record<string, number>,
  temperature: number,
): Record<string, number> {
  const t = Math.max(temperature, 1e-6)
  const scaled: Record<string, number> = {}
  let sum = 0
  for (const [label, p] of Object.entries(probs)) {
    const v = Math.pow(Math.max(p, 0), 1 / t)
    scaled[label] = v
    sum += v
  }
  if (sum <= 0) {
    const labels = Object.keys(probs)
    for (const label of labels) scaled[label] = 1 / labels.length
    return scaled
  }
  for (const label of Object.keys(scaled)) scaled[label] = scaled[label] / sum
  return scaled
}

export interface TemperatureFit {
  temperature: number
  nll: number
  nllBefore: number
}

/** Fit the single parameter that turns a well-formed distribution into a
 *  calibrated one ON THIS TRAFFIC. This, not the backend, is where
 *  calibration comes from — which is why an uncalibrated backend plus a few
 *  hundred labeled rows is a defensible position and an uncalibrated
 *  backend alone is not.
 *
 *  Coarse grid then local refinement: one parameter, a smooth convex-ish
 *  objective, and a few hundred rows. Anything fancier is false precision. */
export function fitTemperature(rows: GradedRow[]): TemperatureFit {
  const labeled = rows.filter((r) => r.truth !== undefined)
  const nllBefore = logLoss(labeled)
  if (labeled.length === 0) return { temperature: 1, nll: 0, nllBefore: 0 }

  const nllAt = (t: number) =>
    mean(
      labeled.map((row) => {
        const scaled = applyTemperature(row.probabilities, t)
        return -Math.log(Math.max(scaled[row.truth!] ?? 0, 1e-12))
      }),
    )

  let best = 1
  let bestNll = nllAt(1)
  for (let t = 0.1; t <= 10.0001; t += 0.1) {
    const value = nllAt(t)
    if (value < bestNll) {
      bestNll = value
      best = t
    }
  }
  for (let t = Math.max(0.01, best - 0.1); t <= best + 0.1; t += 0.01) {
    const value = nllAt(t)
    if (value < bestNll) {
      bestNll = value
      best = t
    }
  }

  return { temperature: Number(best.toFixed(3)), nll: bestNll, nllBefore }
}

export interface Interval {
  lo: number
  hi: number
}

/** Percentile bootstrap. Without an interval, a difference between two
 *  backends' ECEs is not a result. */
export function bootstrapInterval(
  rows: GradedRow[],
  statistic: (sample: GradedRow[]) => number,
  resamples = 1000,
  alpha = 0.05,
  rng: () => number = Math.random,
): Interval {
  if (rows.length === 0) return { lo: 0, hi: 0 }
  const values: number[] = []
  for (let i = 0; i < resamples; i++) {
    const sample: GradedRow[] = []
    for (let j = 0; j < rows.length; j++) {
      sample.push(rows[Math.floor(rng() * rows.length)])
    }
    values.push(statistic(sample))
  }
  values.sort((a, b) => a - b)
  return {
    lo: values[Math.floor((alpha / 2) * values.length)],
    hi: values[Math.min(values.length - 1, Math.floor((1 - alpha / 2) * values.length))],
  }
}

export interface CalibrationReport {
  insufficient: boolean
  n: number
  nLabeled: number
  minN: number
  agreement: AgreementResult
  accuracy?: number
  ece?: number
  eceEqualMass?: number
  eceInterval?: Interval
  mce?: number
  brier?: number
  logLoss?: number
  bins?: ReliabilityBin[]
  binsEqualMass?: ReliabilityBin[]
  coverage?: CoveragePoint[]
  temperature?: TemperatureFit
}

export function calibrationReport(
  rows: GradedRow[],
  opts: { minN?: number; bins?: number; bootstrap?: number; rng?: () => number } = {},
): CalibrationReport {
  const minN = opts.minN ?? 100
  const bins = opts.bins ?? 10
  const labeled = rows.filter((r) => r.truth !== undefined)
  const base: CalibrationReport = {
    insufficient: labeled.length < minN,
    n: rows.length,
    nLabeled: labeled.length,
    minN,
    agreement: agreement(rows),
  }

  // Agreement needs no ground truth, so it is always reported. Everything
  // that does need ground truth is withheld until there is enough of it.
  if (base.insufficient) return base

  return {
    ...base,
    accuracy: mean(labeled.map((r) => (r.predicted === r.truth ? 1 : 0))),
    ece: ece(labeled, bins, "width"),
    eceEqualMass: ece(labeled, bins, "mass"),
    eceInterval: bootstrapInterval(
      labeled,
      (sample) => ece(sample, bins, "width"),
      opts.bootstrap ?? 1000,
      0.05,
      opts.rng,
    ),
    mce: mce(labeled, bins, "width"),
    brier: brier(labeled),
    logLoss: logLoss(labeled),
    bins: reliabilityBins(labeled, bins, "width"),
    binsEqualMass: reliabilityBins(labeled, bins, "mass"),
    coverage: coverageCurve(labeled),
    temperature: fitTemperature(labeled),
  }
}

function equalWidthGroups(sorted: GradedRow[], bins: number): GradedRow[][] {
  const groups: GradedRow[][] = Array.from({ length: bins }, () => [])
  for (const row of sorted) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(row.confidence * bins)))
    groups[index].push(row)
  }
  return groups
}

function equalMassGroups(sorted: GradedRow[], bins: number): GradedRow[][] {
  const groups: GradedRow[][] = Array.from({ length: bins }, () => [])
  sorted.forEach((row, i) => {
    groups[Math.min(bins - 1, Math.floor((i * bins) / sorted.length))].push(row)
  })
  return groups
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
