import type {
  AnswerFor,
  AnyQuestion,
  ChoiceQuestion,
  NoulQuestion,
  Questions,
  ScoreQuestion,
} from "./types"

// Question builders.
//
// These exist for one reason: `choice({ billing: null, technical: null })`
// must produce a question whose answer's `choice` field is typed
// `"billing" | "technical"`, not `string`. That is what makes a `switch`
// over a decision exhaustive at the call site.
//
// TypeScript here is 4.9.5 (package.json pins ^4.9.3), so there are no
// `const` type parameters. We do not need them: the KEYS of an object
// literal already infer as literal types. `score`'s array literal does
// widen to `string[]`, which costs nothing because a score is a number.

/** Jev caps a Choice at 255 options; anything larger needs two-stage
 *  narrowing. Enforced here from day one so the constraint surfaces while
 *  writing the question rather than on the day a Jev key arrives. */
export const MAX_CHOICE_OPTIONS = 255

export function noul(instructions?: string, criteria?: NoulQuestion["criteria"]): NoulQuestion {
  const q: NoulQuestion = { type: "noul" }
  return { ...q, ...(instructions ? { instructions } : {}), ...(criteria ? { criteria } : {}) }
}

export function choice<C extends Record<string, string | null>>(
  criteria: C,
  instructions?: string,
): ChoiceQuestion<Extract<keyof C, string>> {
  const labels = Object.keys(criteria)
  if (labels.length < 2) {
    throw new Error(`choice() needs at least 2 options, got ${labels.length}`)
  }
  if (labels.length > MAX_CHOICE_OPTIONS) {
    throw new Error(
      `choice() supports at most ${MAX_CHOICE_OPTIONS} options (Jev's cap), got ${labels.length} — ` +
        `narrow the set first, or split into two stages`,
    )
  }
  return {
    type: "choice",
    ...(instructions ? { instructions } : {}),
    criteria: criteria as Readonly<Record<Extract<keyof C, string>, string | null>>,
  }
}

export function score(criteria: readonly string[], instructions?: string): ScoreQuestion {
  if (criteria.length < 2) {
    throw new Error(`score() needs at least 2 rubric levels, got ${criteria.length}`)
  }
  return { type: "score", ...(instructions ? { instructions } : {}), criteria }
}

/** The labels a distribution-shaped question ranges over, in a stable order.
 *  Choice: its option labels. Score: level indices as strings, "0".."n-1".
 *  Noul has no distribution and returns []. */
export function labelsOf(q: AnyQuestion): string[] {
  if (q.type === "choice") return Object.keys(q.criteria)
  if (q.type === "score") return q.criteria.map((_, i) => String(i))
  return []
}

/** Throws on any question the seat cannot honour, so a bad question fails
 *  at the call site instead of costing a round trip. */
export function validateQuestions(questions: Questions): void {
  const names = Object.keys(questions)
  if (names.length === 0) throw new Error("at least one question is required")
  for (const name of names) {
    const q = questions[name]
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length
      if (n < 2) throw new Error(`question "${name}": choice needs at least 2 options, got ${n}`)
      if (n > MAX_CHOICE_OPTIONS) {
        throw new Error(
          `question "${name}": choice has ${n} options, over the ${MAX_CHOICE_OPTIONS} cap`,
        )
      }
    } else if (q.type === "score") {
      if (q.criteria.length < 2) {
        throw new Error(
          `question "${name}": score needs at least 2 rubric levels, got ${q.criteria.length}`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Compile-time assertions
// ---------------------------------------------------------------------------
//
// tsconfig.json only includes src/**, so `pnpm typecheck` never sees test/.
// These live here so the inference contract is checked by the typechecker on
// every build. The function is never called and never exported; esbuild drops
// it. If TypeScript is upgraded and inference shifts, this breaks the build
// rather than silently degrading `choice` to `string`.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

function _assertInferenceContract() {
  const q = choice({ billing: null, technical: "needs an engineer" })
  const _labels: Expect<Equal<AnswerFor<typeof q>["choice"], "billing" | "technical">> = true

  const n = noul("is this urgent?")
  // @ts-expect-error — noul answers carry no confidence; mirroring Jev means
  // reaching for one is a compile error today, not a bug on swap day.
  type _NoConfidence = AnswerFor<typeof n>["confidence"]

  const s = score(["poor", "fine", "good"])
  const _score: Expect<Equal<AnswerFor<typeof s>["score"], number>> = true

  return [_labels, _score] as const
}
