import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// Re-ranking a BM25 shortlist.
//
// Measured on the operator's own wiki (11,656 articles, 12 queries):
// BM25 alone gets R@1 33.3%, R@3 41.7%. Two thirds of queries do not put
// the right article first. BM25 is a bag-of-words match, so it does well
// on "gitlab token expired" and badly on "the bot keeps repeating itself
// what is wrong" — the synonym cases score 33% / 33%.
//
// Shape follows TypeSafe's semantic_find cookbook rather than their
// rerank one. Rerank scores each query-candidate pair separately, which
// is N calls; semantic_find scores 218 line ids against one query with a
// single Choice, and the per-option probabilities ARE the ranking. One
// call for the whole shortlist, and the candidates are compared against
// each other rather than each judged alone — which is what ranking means.
//
// The companion Noul is the part that keeps this honest. A Choice must
// return something: asked which of 30 articles answers a question the
// wiki has no answer to, it will still name one, with a confident-looking
// probability. `answerable` is the question that can say no, and code
// reads it first.

export const WIKI_RERANK_SEAT = "wiki-rerank"

// Measured on the 12-query eval, sweeping candidate count against
// excerpt length under a fixed state budget:
//
//   k=120 x 150 chars   R@1 25.0%   (worse than BM25's 33.3%)
//   k=60  x 300 chars   R@1 41.7%
//   k=30  x 600 chars   R@1 41.7%
//   k=30  x 900 chars   R@1 50.0%   <- default
//   k=20  x 1100 chars  R@1 50.0%
//
// Candidates and excerpt trade against one another, and excerpt wins.
// More candidates raises the ceiling — what the shortlist could contain —
// while starving the re-ranker of the text it needs to rank with. At 150
// characters a candidate is barely more than its title, and the result is
// worse than no re-ranking at all. Raise k only alongside the state
// budget, never instead of the excerpt.
export const DEFAULT_SHORTLIST = 30
export const DEFAULT_EXCERPT_CHARS = 900

export interface RerankCandidate {
  id: string
  title: string
  tags?: string[]
  excerpt: string
}

export interface RerankInput {
  query: string
  candidates: RerankCandidate[]
  /** Per-candidate excerpt budget. See DEFAULT_EXCERPT_CHARS — this is
   *  the lever that actually moves accuracy. */
  excerptChars?: number
}

export function rerankState(input: RerankInput): StateValue {
  const budget = input.excerptChars ?? DEFAULT_EXCERPT_CHARS
  return {
    query: input.query,
    candidates: input.candidates.map((c) => ({
      id: c.id,
      title: c.title,
      tags: c.tags?.length ? c.tags.join(", ") : null,
      excerpt: clip(c.excerpt, budget),
    })),
  }
}

/** Built per call, because the option set IS the candidate set. */
export function rerankQuestions(candidates: RerankCandidate[]) {
  const criteria: Record<string, string> = {}
  for (const c of candidates) criteria[c.id] = c.title
  return {
    best: choice(criteria, "Which candidate answers the query?"),
    answerable: noul("Do any of the candidates answer the query?"),
  }
}

export type RerankAnswers = AnswersFor<ReturnType<typeof rerankQuestions>>

export interface RerankResult {
  /** Candidate ids, best first, by the Choice's per-option probability. */
  ranked: string[]
  scores: Record<string, number>
  /** P(the shortlist contains an answer at all). */
  answerable: number
  /** The Choice's own confidence — flat means it could not separate them. */
  confidence: number
}

/**
 * Turn one answer into a ranking.
 *
 * Ties keep the incoming order, so a Choice that genuinely cannot
 * separate the candidates degrades to BM25's ranking rather than to an
 * arbitrary one.
 */
export function toRanking(
  answers: RerankAnswers,
  candidates: RerankCandidate[],
): RerankResult {
  const best = answers.best as ChoiceAnswer
  const scores: Record<string, number> = {}
  for (const c of candidates) scores[c.id] = best.probabilities[c.id] ?? 0

  const order = new Map(candidates.map((c, i) => [c.id, i]))
  const ranked = [...candidates.map((c) => c.id)].sort((a, b) => {
    const diff = scores[b] - scores[a]
    return diff !== 0 ? diff : (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })

  return {
    ranked,
    scores,
    answerable: (answers.answerable as NoulAnswer).noul,
    confidence: best.confidence,
  }
}

function clip(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) : flat
}
