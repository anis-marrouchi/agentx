import { describe, it, expect } from "vitest"
import {
  DEFAULT_EXCERPT_CHARS, DEFAULT_SHORTLIST, rerankQuestions, rerankState, toRanking,
  type RerankCandidate,
} from "../../src/decisions/seats/wiki-rerank"
import { finalizeAnswer } from "../../src/decisions/normalize"
import type { AnswersFor } from "../../src/decisions/types"

const candidates: RerankCandidate[] = [
  { id: "a1", title: "GITLAB_TOKEN Expired", tags: ["incident"], excerpt: "The token expired." },
  { id: "a2", title: "WhatsApp Echo Loop", tags: ["incident"], excerpt: "Bot replied to itself." },
  { id: "a3", title: "Globex DevOps Environment", excerpt: "Staging deploy steps." },
]

function answers(probs: Record<string, number>, answerable = 0.9) {
  const q = rerankQuestions(candidates)
  return {
    best: finalizeAnswer(q.best, { probabilities: probs }).answer,
    answerable: finalizeAnswer(q.answerable, { noul: answerable }).answer,
  } as AnswersFor<ReturnType<typeof rerankQuestions>>
}

describe("rerankQuestions", () => {
  it("makes the candidate set the option set, keyed by id not title", () => {
    const q = rerankQuestions(candidates)
    expect(Object.keys(q.best.criteria)).toEqual(["a1", "a2", "a3"])
    // Titles are the descriptions; ids are the keys, because titles are
    // not unique across a wiki and a Choice needs distinct keys.
    expect(q.best.criteria.a1).toBe("GITLAB_TOKEN Expired")
  })

  it("stays under Jev's 255-option cap at the default shortlist", () => {
    expect(DEFAULT_SHORTLIST).toBeLessThanOrEqual(255)
  })
})

describe("rerankState", () => {
  it("clips excerpts to the budget and flattens whitespace", () => {
    const state = rerankState({
      query: "q",
      candidates: [{ id: "a", title: "T", excerpt: "x  \n\n  y".padEnd(5000, "z") }],
      excerptChars: 50,
    }) as any
    expect(state.candidates[0].excerpt).toHaveLength(50)
    expect(state.candidates[0].excerpt).not.toMatch(/\n/)
  })

  it("keeps the whole shortlist inside the state budget at the defaults", () => {
    const many: RerankCandidate[] = Array.from({ length: DEFAULT_SHORTLIST }, (_, i) => ({
      id: `a${i}`,
      title: `Article ${i}`.padEnd(80, "t"),
      excerpt: "z".repeat(4000),
    }))
    const size = JSON.stringify(rerankState({ query: "q", candidates: many })).length
    // Blowing the backend's budget silently truncates the tail of the
    // shortlist, dropping candidates from ranking with no error. The
    // Jev-class backends allow 90k chars; this asserts the defaults fit
    // with room to spare, which they did NOT at the original 24k.
    expect(size).toBeLessThan(90_000)
    expect(DEFAULT_SHORTLIST * DEFAULT_EXCERPT_CHARS).toBeLessThan(90_000)
  })
})

describe("toRanking", () => {
  it("orders by the choice's per-option probability", () => {
    const r = toRanking(answers({ a1: 0.2, a2: 0.7, a3: 0.1 }), candidates)
    expect(r.ranked).toEqual(["a2", "a1", "a3"])
    expect(r.scores.a2).toBeCloseTo(0.7, 6)
  })

  it("falls back to the incoming order on a tie, not an arbitrary one", () => {
    // A Choice that cannot separate the candidates should degrade to
    // BM25's ranking rather than reshuffling it.
    const r = toRanking(answers({ a1: 1 / 3, a2: 1 / 3, a3: 1 / 3 }), candidates)
    expect(r.ranked).toEqual(["a1", "a2", "a3"])
  })

  it("surfaces answerable separately, because a Choice must pick something", () => {
    // Asked which of 30 articles answers a question the wiki cannot
    // answer, the Choice still names one. The Noul is what says no.
    const r = toRanking(answers({ a1: 0.5, a2: 0.3, a3: 0.2 }, 0.12), candidates)
    expect(r.ranked[0]).toBe("a1")
    expect(r.answerable).toBeCloseTo(0.12, 6)
  })

  it("scores every candidate, including ones the model ignored", () => {
    const r = toRanking(answers({ a1: 0.9, a2: 0.1, a3: 0 }), candidates)
    expect(Object.keys(r.scores).sort()).toEqual(["a1", "a2", "a3"])
  })
})
