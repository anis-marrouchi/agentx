import { labelsOf } from "./questions"
import type { AnyAnswer, AnyQuestion, RawAnswer } from "./types"

// Turning what a model said into a distribution we can do arithmetic on.
//
// Everything a caller reads off an answer except the raw numbers is computed
// here: the argmax, the expected score, and both confidence statistics. The
// model supplies `probabilities` (or `noul`) and nothing else.
//
// Nothing in this file throws. A model that returns garbage yields a uniform
// distribution with `repaired: true`, because a seat that throws on the
// critical path is worse than a seat that says "I don't know" — and a
// repaired row is visible in the shadow store, so the failure is measured
// rather than hidden.

export interface NormalizeOptions {
  /** Rescale so the values sum to 1. Default true. Mirrors the Python
   *  system-one-adapter's `normalize_probabilities`. */
  normalize?: boolean
  /** Mass given to a label the model omitted entirely. Default 1e-6. */
  epsilon?: number
}

export interface NormalizedDistribution {
  probs: Record<string, number>
  /** True when the model's output had to be corrected: a missing or extra
   *  label, a negative or non-finite value, or an all-zero distribution.
   *  Recorded per call so "how often does the backend misbehave" is itself
   *  a measured quantity rather than a hunch. */
  repaired: boolean
}

export function normalizeDistribution(
  raw: unknown,
  labels: readonly string[],
  opts: NormalizeOptions = {},
): NormalizedDistribution {
  const normalize = opts.normalize ?? true
  const epsilon = opts.epsilon ?? 1e-6
  const source: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  let repaired = raw === null || typeof raw !== "object" || Array.isArray(raw)
  for (const key of Object.keys(source)) {
    if (!labels.includes(key)) repaired = true
  }

  const probs: Record<string, number> = {}
  let sum = 0
  for (const label of labels) {
    if (!(label in source)) {
      probs[label] = epsilon
      sum += epsilon
      repaired = true
      continue
    }
    const value = Number(source[label])
    if (!Number.isFinite(value) || value < 0) {
      probs[label] = 0
      repaired = true
      continue
    }
    probs[label] = value
    sum += value
  }

  if (labels.length === 0) return { probs, repaired }

  if (sum <= 0) {
    // The model gave us nothing usable. Uniform is the honest answer: it
    // carries zero confidence, so a confidence-gated call site escalates.
    const uniform = 1 / labels.length
    for (const label of labels) probs[label] = uniform
    return { probs, repaired: true }
  }

  if (normalize) {
    for (const label of labels) probs[label] = probs[label] / sum
    if (Math.abs(sum - 1) > 1e-6) repaired = true
  }

  return { probs, repaired }
}

/** Largest probability. Simple, but not comparable across different option
 *  counts — uniform over 2 is 0.5, uniform over 10 is 0.1. */
export function pMax(probs: Record<string, number>): number {
  const values = Object.values(probs)
  if (values.length === 0) return 0
  return Math.max(...values)
}

/** 1 - H(p) / ln(k). Zero on a uniform distribution, one on a point mass,
 *  and comparable across option counts because it divides out ln(k) — which
 *  is why this, not pMax, is what `confidence` reports. */
export function normalizedNegEntropy(probs: Record<string, number>): number {
  const values = Object.values(probs).filter((v) => Number.isFinite(v) && v > 0)
  const k = Object.keys(probs).length
  if (k <= 1) return 1
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0) return 0
  let h = 0
  for (const v of values) {
    const p = v / total
    h -= p * Math.log(p)
  }
  return clamp01(1 - h / Math.log(k))
}

/** Expected value over a distribution whose keys are level indices. */
export function expectedScore(probs: Record<string, number>): number {
  let total = 0
  let weighted = 0
  for (const [key, value] of Object.entries(probs)) {
    const level = Number(key)
    if (!Number.isFinite(level) || !Number.isFinite(value) || value <= 0) continue
    total += value
    weighted += level * value
  }
  return total > 0 ? weighted / total : 0
}

export function confidenceFor(probs: Record<string, number>): number {
  return normalizedNegEntropy(probs)
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/** Build the public answer from a question and what the model reported.
 *  The caller-visible `choice`, `score`, `confidence` and `legend` are all
 *  derived right here — the model never reports any of them. */
export function finalizeAnswer(
  question: AnyQuestion,
  raw: RawAnswer,
  opts: NormalizeOptions = {},
): { answer: AnyAnswer; repaired: boolean } {
  if (question.type === "noul") {
    const value = Number((raw as { noul?: unknown }).noul)
    const ok = Number.isFinite(value) && value >= 0 && value <= 1
    return {
      answer: { type: "noul", noul: ok ? value : 0.5 },
      repaired: !ok,
    }
  }

  const labels = labelsOf(question)
  const { probs, repaired } = normalizeDistribution(
    (raw as { probabilities?: unknown }).probabilities,
    labels,
    opts,
  )
  const max = pMax(probs)
  const negEntropy = normalizedNegEntropy(probs)

  if (question.type === "choice") {
    let best = labels[0]
    for (const label of labels) if (probs[label] > probs[best]) best = label
    return {
      answer: {
        type: "choice",
        choice: best,
        confidence: confidenceFor(probs),
        probabilities: probs,
        pMax: max,
        negEntropy,
      },
      repaired,
    }
  }

  const legend: Record<string, string> = {}
  question.criteria.forEach((description, i) => {
    legend[String(i)] = description
  })
  return {
    answer: {
      type: "score",
      score: expectedScore(probs),
      confidence: confidenceFor(probs),
      legend,
      probabilities: probs,
      pMax: max,
      negEntropy,
    },
    repaired,
  }
}
