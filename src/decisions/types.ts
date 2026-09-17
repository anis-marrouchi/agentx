// Typed-decision seat — the wire contract.
//
// This mirrors TypeSafe AI's "System One" shape (POST /v1/systemone) on
// purpose: one `state` plus a map of named questions, with every answer
// returned in a single call carrying a full probability distribution.
// Mirroring it means a future Jev backend is a new file in ./backends,
// not a refactor of every call site.
//
// Three question types, and only three. A call site that wants prose does
// not belong here.
//
// Two deliberate divergences from "whatever is easiest to ask a model for":
//
//   - `NoulAnswer` has NO `confidence` field, because Jev's noul answer has
//     none. A consumer reaching for it is a compile error today rather than
//     a surprise on the day we swap backends.
//
//   - The model is never asked for `choice`, `score`, `confidence` or
//     `legend`. It reports `probabilities` and nothing else; the rest is
//     derived in ./normalize.ts. Self-reported confidence is the exact
//     thing this module exists to replace — see src/graph/classifier.ts,
//     where `graph.autoApproveConfidence` defaults to 1.0 (i.e. disabled)
//     precisely because the model's own number isn't trusted.

/** A JSON-compatible value. State is JSON-only: no images, matching Jev. */
export type StateValue =
  | string
  | number
  | boolean
  | null
  | StateValue[]
  | { [key: string]: StateValue }

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** A yes/no question. `criteria` optionally describes either outcome. */
export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions?: string
  readonly criteria?: {
    readonly true?: string
    readonly false?: string
  }
}

/** Select one of a named set. `criteria` maps label -> description
 *  (`null` leaves a label undescribed). */
export interface ChoiceQuestion<L extends string = string> {
  readonly type: "choice"
  readonly instructions?: string
  readonly criteria: Readonly<Record<L, string | null>>
}

/** Place the state on an ordered rubric. Index i describes level i, so the
 *  array order IS the scale. At least two levels. */
export interface ScoreQuestion {
  readonly type: "score"
  readonly instructions?: string
  readonly criteria: readonly string[]
}

export type AnyQuestion = NoulQuestion | ChoiceQuestion<string> | ScoreQuestion

/** Questions keyed by the names their answers come back under. */
export type Questions = Record<string, AnyQuestion>

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Probability of "yes". No confidence — the probability IS the answer, and
 *  distance from 0.5 is the only uncertainty signal a binary has. */
export interface NoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

export interface ChoiceAnswer<L extends string = string> {
  readonly type: "choice"
  /** argmax of `probabilities`, derived — never model-reported. */
  readonly choice: L
  /** Derived from the shape of `probabilities`. See confidenceFor(). */
  readonly confidence: number
  readonly probabilities: Readonly<Record<L, number>>
  /** Both statistics are kept on every answer because Jev's own confidence
   *  formula is unpublished; storing both lets the swap-day comparison run
   *  against already-collected shadow rows without recollecting them. */
  readonly pMax: number
  readonly negEntropy: number
}

export interface ScoreAnswer {
  readonly type: "score"
  /** Expected value over the rubric, so it may fall between levels. */
  readonly score: number
  readonly confidence: number
  /** Rubric descriptions keyed by level index, echoed back for display. */
  readonly legend: Readonly<Record<string, string>>
  readonly probabilities: Readonly<Record<string, number>>
  readonly pMax: number
  readonly negEntropy: number
}

export type AnyAnswer = NoulAnswer | ChoiceAnswer<string> | ScoreAnswer

/** The answer shape implied by a question shape.
 *
 *  Inference reads `criteria` directly rather than going through
 *  `ChoiceQuestion<infer L>`, so a question built by hand (not via the
 *  ./questions.ts builders) still narrows correctly. */
export type AnswerFor<Q extends AnyQuestion> =
  Q extends { type: "noul" } ? NoulAnswer
  : Q extends { type: "score" } ? ScoreAnswer
  : Q extends { type: "choice"; criteria: infer C } ? ChoiceAnswer<Extract<keyof C, string>>
  : never

export type AnswersFor<Q extends Questions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]>
}

// ---------------------------------------------------------------------------
// Raw model output
// ---------------------------------------------------------------------------
//
// What a backend is allowed to receive from a model, before normalization.
// Narrower than the public answer on purpose — see the header.

export interface RawNoulAnswer {
  readonly noul: number
}

export interface RawDistributionAnswer {
  readonly probabilities: Record<string, unknown>
}

export type RawAnswer = RawNoulAnswer | RawDistributionAnswer

export type RawAnswers = Record<string, RawAnswer>
