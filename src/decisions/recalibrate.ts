import type { GradedRow } from "./store"

// Recalibration with covariates.
//
// `fitTemperature` assumes one miscalibration curve for a whole seat. That
// is usually false. A model can be well calibrated answering about a cron
// runner and badly overconfident answering about a chat agent, and a single
// scalar averages the two into something wrong for both.
//
// This fits p(correct | confidence, covariates) with logistic regression on
// the logit of the reported confidence plus one-hot covariates. With no
// covariates it reduces to Platt scaling, which is already a strict
// generalisation of temperature scaling on a binary outcome — so the
// covariate model can only help in-sample.
//
// Which is exactly why nothing here reports an in-sample number. More
// parameters always fit the training data better; the only question worth
// asking is whether they predict BETTER OUT OF SAMPLE. `compareCalibrators`
// runs k-fold cross-validation over raw, temperature and covariate models
// and reports held-out log loss for each. If the covariate model does not
// win there, it does not get used.

/** Target: was the seat's prediction right? Calibrating `confidence` this
 *  way covers Choice, Score and Noul uniformly, because answerView already
 *  projects all three to (predicted, confidence). */
function outcome(row: GradedRow): number {
  return row.predicted === row.truth ? 1 : 0
}

const EPS = 1e-6

export function logit(p: number): number {
  const clamped = Math.min(1 - EPS, Math.max(EPS, p))
  return Math.log(clamped / (1 - clamped))
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

export interface DesignSpec {
  /** Covariate names, read from row.features first and then from the row's
   *  own fields (question, model, backend, structureMode, predicted). */
  covariates: string[]
  /** Levels appearing fewer than this many times are folded into the
   *  reference level. Rare levels are noise with a free parameter attached. */
  minLevelCount?: number
}

export interface Design {
  X: number[][]
  y: number[]
  names: string[]
  /** level -> column, per covariate. The dropped reference level is absent. */
  levels: Record<string, string[]>
}

function covariateValue(row: GradedRow, name: string): string {
  const fromFeatures = row.features?.[name]
  if (fromFeatures !== undefined && fromFeatures !== null) return String(fromFeatures)
  const own = (row as unknown as Record<string, unknown>)[name]
  return own === undefined || own === null ? "(none)" : String(own)
}

export function buildDesign(rows: GradedRow[], spec: DesignSpec): Design {
  const minCount = spec.minLevelCount ?? 5
  const levels: Record<string, string[]> = {}

  for (const name of spec.covariates) {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const value = covariateValue(row, name)
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    const kept = [...counts.entries()]
      .filter(([, n]) => n >= minCount)
      .map(([value]) => value)
      .sort()
    // Drop one level as the reference, or the design is collinear with
    // the intercept and the fit is not identified.
    levels[name] = kept.slice(1)
  }

  const names = ["intercept", "logitConfidence"]
  for (const name of spec.covariates) for (const level of levels[name]) names.push(`${name}=${level}`)

  const X: number[][] = []
  const y: number[] = []
  for (const row of rows) {
    const features = [1, logit(row.confidence)]
    for (const name of spec.covariates) {
      const value = covariateValue(row, name)
      for (const level of levels[name]) features.push(value === level ? 1 : 0)
    }
    X.push(features)
    y.push(outcome(row))
  }

  return { X, y, names, levels }
}

/**
 * Logistic regression by iteratively reweighted least squares.
 *
 * Newton's method rather than gradient descent: it converges in a handful
 * of iterations with no learning rate to guess at, which matters because
 * this runs unattended on a few hundred rows. The ridge term is not
 * optional — with one-hot covariates and a small sample, a level that
 * happens to be perfectly separable sends its weight to infinity.
 */
export function fitLogistic(
  X: number[][],
  y: number[],
  opts: { l2?: number; iterations?: number } = {},
): number[] {
  const l2 = opts.l2 ?? 1
  const iterations = opts.iterations ?? 25
  const n = X.length
  const d = n > 0 ? X[0].length : 0
  let w = new Array(d).fill(0)
  if (n === 0 || d === 0) return w

  for (let iter = 0; iter < iterations; iter++) {
    // Hessian (X'WX + lambda I) and gradient X'(y - p) - lambda w
    const H: number[][] = Array.from({ length: d }, () => new Array(d).fill(0))
    const g = new Array(d).fill(0)

    for (let i = 0; i < n; i++) {
      let z = 0
      for (let j = 0; j < d; j++) z += w[j] * X[i][j]
      const p = sigmoid(z)
      const weight = Math.max(p * (1 - p), 1e-8)
      const residual = y[i] - p
      for (let j = 0; j < d; j++) {
        g[j] += residual * X[i][j]
        for (let k = j; k < d; k++) H[j][k] += weight * X[i][j] * X[i][k]
      }
    }
    for (let j = 0; j < d; j++) {
      // Never penalise the intercept: shrinking it biases the base rate.
      if (j > 0) {
        H[j][j] += l2
        g[j] -= l2 * w[j]
      }
      for (let k = 0; k < j; k++) H[j][k] = H[k][j]
    }

    const step = solve(H, g)
    if (!step) break
    let delta = 0
    for (let j = 0; j < d; j++) {
      w[j] += step[j]
      delta += Math.abs(step[j])
    }
    if (delta < 1e-8) break
  }
  return w
}

/** Gaussian elimination with partial pivoting. Returns null on a singular
 *  system, which the caller treats as "stop iterating" rather than a crash. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    if (Math.abs(M[pivot][col]) < 1e-12) return null
    ;[M[col], M[pivot]] = [M[pivot], M[col]]

    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = M[r][col] / M[col][col]
      if (factor === 0) continue
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c]
    }
  }
  // Full Gauss-Jordan above, so the matrix is diagonal and back-substitution
  // is a single division per row.
  const x = new Array(n)
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i]
  return x
}

export interface RecalibrationModel {
  weights: number[]
  names: string[]
  levels: Record<string, string[]>
  covariates: string[]
  n: number
}

export function fitRecalibrator(rows: GradedRow[], spec: DesignSpec): RecalibrationModel {
  const labeled = rows.filter((r) => r.truth !== undefined)
  const design = buildDesign(labeled, spec)
  return {
    weights: fitLogistic(design.X, design.y),
    names: design.names,
    levels: design.levels,
    covariates: spec.covariates,
    n: labeled.length,
  }
}

/** Corrected probability that this row's prediction is right. */
export function applyRecalibrator(model: RecalibrationModel, row: GradedRow): number {
  let z = model.weights[0] + model.weights[1] * logit(row.confidence)
  let col = 2
  for (const name of model.covariates) {
    const value = covariateValue(row, name)
    for (const level of model.levels[name] ?? []) {
      if (value === level) z += model.weights[col]
      col++
    }
  }
  return sigmoid(z)
}

// ---------------------------------------------------------------------------
// Honest comparison
// ---------------------------------------------------------------------------

export interface CalibratorScore {
  name: string
  /** Held-out log loss, averaged over folds. Lower is better. */
  logLoss: number
  /** Held-out Brier score. */
  brier: number
}

export interface CalibratorComparison {
  insufficient: boolean
  n: number
  minN: number
  folds: number
  scores: CalibratorScore[]
  /** The winner on held-out log loss. */
  best?: string
  /** Fitted on everything, for use once `best` says it is worth using. */
  model?: RecalibrationModel
}

/**
 * k-fold cross-validated comparison of raw confidence, a single global
 * temperature, and the covariate model.
 *
 * The whole point of this function is that it can say "the covariates are
 * not worth it". More parameters always look better in-sample, so an
 * in-sample improvement is not evidence of anything.
 */
export function compareCalibrators(
  rows: GradedRow[],
  spec: DesignSpec,
  opts: { folds?: number; minN?: number; rng?: () => number } = {},
): CalibratorComparison {
  const folds = opts.folds ?? 5
  const minN = opts.minN ?? 100
  const labeled = rows.filter((r) => r.truth !== undefined)
  const base = { insufficient: labeled.length < minN, n: labeled.length, minN, folds, scores: [] }
  if (base.insufficient) return base

  const rng = opts.rng ?? Math.random
  const shuffled = [...labeled]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  const predictors: Record<string, number[]> = { raw: [], temperature: [], covariate: [] }
  const actuals: number[] = []

  for (let fold = 0; fold < folds; fold++) {
    const test = shuffled.filter((_, i) => i % folds === fold)
    const train = shuffled.filter((_, i) => i % folds !== fold)
    if (train.length === 0 || test.length === 0) continue

    const flat = fitRecalibrator(train, { ...spec, covariates: [] })
    const full = fitRecalibrator(train, spec)

    for (const row of test) {
      actuals.push(outcome(row))
      predictors.raw.push(row.confidence)
      predictors.temperature.push(applyRecalibrator(flat, row))
      predictors.covariate.push(applyRecalibrator(full, row))
    }
  }

  const scores = Object.entries(predictors).map(([name, predicted]) => ({
    name,
    logLoss: binaryLogLoss(predicted, actuals),
    brier: binaryBrier(predicted, actuals),
  }))
  const best = [...scores].sort((a, b) => a.logLoss - b.logLoss)[0]?.name

  return {
    ...base,
    scores,
    best,
    model: best === "covariate" ? fitRecalibrator(labeled, spec) : fitRecalibrator(labeled, { ...spec, covariates: [] }),
  }
}

function binaryLogLoss(predicted: number[], actual: number[]): number {
  if (predicted.length === 0) return 0
  let sum = 0
  for (let i = 0; i < predicted.length; i++) {
    const p = Math.min(1 - EPS, Math.max(EPS, predicted[i]))
    sum += actual[i] === 1 ? -Math.log(p) : -Math.log(1 - p)
  }
  return sum / predicted.length
}

function binaryBrier(predicted: number[], actual: number[]): number {
  if (predicted.length === 0) return 0
  let sum = 0
  for (let i = 0; i < predicted.length; i++) sum += (predicted[i] - actual[i]) ** 2
  return sum / predicted.length
}
