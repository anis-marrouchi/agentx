import { randomBytes } from "crypto"
import { getDecisionBackend } from "./backend"
import { answerView } from "./store"
import type { Questions, StateValue } from "./types"

// Does the question hold still?
//
// Everything else in this module measures the BACKEND — is its confidence
// calibrated, does it beat the incumbent. Nothing measured the QUESTIONS,
// and a badly-phrased question does not announce itself: it produces
// plausible numbers that happen to move every time you ask.
//
// TypeSafe's own consistency cookbook is the method. Ask the same rubric
// over the same state N times, with a throwaway `uid` in the state so each
// repeat is an independent draw rather than a cached one, and look at the
// spread. Their published figure for jev across a 14-question rubric is a
// mean per-question standard deviation of 0.0102; sampled LLM answers move
// far more, and on the judgment calls disagree with themselves at
// temperature 0.
//
// What this is for, concretely: a compound question — "did it leave
// anything unresolved, surprising, risky, or needing a decision" — is four
// questions sharing a name, and it scatters. An atomic one holds. This
// turns that from an opinion about phrasing into a number, BEFORE any
// ground truth exists to calibrate against. It is the cheapest quality
// signal available: fifteen samples of a two-question seat costs about a
// twentieth of a cent.
//
// It does not tell you the answer is RIGHT. A question can be perfectly
// stable and perfectly wrong. Stability is a precondition for calibration
// being meaningful, not a substitute for measuring it.

/** The vendor's review band: act below LOW or above HIGH, escalate between. */
export const UNCERTAINTY_LOW = 0.3
export const UNCERTAINTY_HIGH = 0.7

export type BandDecision = "no" | "uncertain" | "yes"

export function band(
  probability: number,
  low = UNCERTAINTY_LOW,
  high = UNCERTAINTY_HIGH,
): BandDecision {
  if (probability <= low) return "no"
  if (probability > high) return "yes"
  return "uncertain"
}

export interface QuestionConsistency {
  question: string
  type: string
  n: number
  mean: number
  /** Population standard deviation of the per-sample probability. For a
   *  Noul that probability is P(true); for Choice and Score it is the
   *  winning label's share. */
  stdev: number
  min: number
  max: number
  /** Distinct predicted labels across the samples. More than one means the
   *  seat's own answer flips between identical calls. */
  distinctAnswers: string[]
  /** Distinct band decisions. Two or more means the samples straddle a
   *  threshold, so which action fires is decided by luck. */
  bands: BandDecision[]
  /** True when the samples disagree about what to DO, not merely by how
   *  much. This is the finding that matters. */
  crossesThreshold: boolean
  samples: number[]
}

export interface ConsistencyReport {
  backend: string
  model: string
  samples: number
  /** Mean of the per-question standard deviations — TypeSafe publishes
   *  0.0102 for jev over a 14-question rubric, as a reference point. */
  meanStdev: number
  unstable: string[]
  questions: QuestionConsistency[]
  usage: { inputTokens: number; outputTokens: number }
  totalMs: number
}

/**
 * Resample one state N times and report the spread per question.
 *
 * The `uid` is not decoration. Without a field that changes per call the
 * backend may serve a cached answer, and a cache returns a standard
 * deviation of zero for any question, however badly phrased.
 */
export async function measureConsistency(
  backendName: string,
  state: StateValue,
  questions: Questions,
  opts: { samples?: number; model?: string; low?: number; high?: number } = {},
): Promise<ConsistencyReport> {
  const samples = Math.max(2, opts.samples ?? 15)
  const backend = getDecisionBackend(backendName)
  const started = Date.now()

  const runs = await Promise.all(
    Array.from({ length: samples }, (_, i) =>
      backend.decide({
        state: withUid(state, `${i}:${randomBytes(4).toString("hex")}`),
        questions,
        model: opts.model,
      }),
    ),
  )

  const names = Object.keys(questions)
  const usage = runs.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.usage.inputTokens,
      outputTokens: acc.outputTokens + r.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  )

  const perQuestion = names.map((name) => {
    const views = runs.map((r) => answerView((r.answers as Record<string, any>)[name]))
    // The right scalar differs by type, and getting it wrong is silent.
    //
    // For a Noul the quantity is P(true) — that is what the answer IS, and
    // what the 0.30/0.70 band is defined on. Using the winning label's
    // probability instead reports 1-p whenever the answer is "no", so a
    // P(true) of 0.26 displays as 0.74 and every noul lands above 0.5,
    // which makes the band useless. For Choice and Score there is no
    // single "true" outcome, so the winning label's probability is the
    // comparable scalar.
    const probs = views.map((v, i) => {
      const answer = (runs[i].answers as Record<string, any>)[name]
      return answer.type === "noul" ? answer.noul : v.topProb
    })
    const answers = [...new Set(views.map((v) => v.predicted))]
    const bands = [...new Set(probs.map((p) => band(p, opts.low, opts.high)))]
    const m = mean(probs)
    return {
      question: name,
      type: (runs[0].answers as Record<string, any>)[name].type,
      n: samples,
      mean: m,
      stdev: stdev(probs, m),
      min: Math.min(...probs),
      max: Math.max(...probs),
      distinctAnswers: answers,
      bands,
      crossesThreshold: answers.length > 1 || bands.length > 1,
      samples: probs,
    }
  })

  return {
    backend: backendName,
    model: runs[0].model,
    samples,
    meanStdev: mean(perQuestion.map((q) => q.stdev)),
    unstable: perQuestion.filter((q) => q.crossesThreshold).map((q) => q.question),
    questions: perQuestion,
    usage,
    totalMs: Date.now() - started,
  }
}

/** Add a throwaway field without disturbing a string state's meaning. */
export function withUid(state: StateValue, uid: string): StateValue {
  if (state !== null && typeof state === "object" && !Array.isArray(state)) {
    return { ...(state as Record<string, StateValue>), uid }
  }
  return { uid, state }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stdev(values: number[], m: number): number {
  if (values.length < 2) return 0
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length)
}
