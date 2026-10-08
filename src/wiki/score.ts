// --- Score the wiki against a question set (#824) ---
//
// The fleet test behind #824 scored the wiki by hand: each agent took 10
// to 12 real questions from its own past work and checked whether the
// wiki answered them (47% and 75%). This makes that repeatable, so the
// same set can be run before and after a week of daily contributions.
//
// A question set is JSON (an array) or JSON lines, one question each:
//
//   {"id": "q1", "question": "What is the vendor's billing contact's phone?", "expect": ["+1 555 0100"]}
//
// An answer scores the share of its expected facts it contains. Matching
// ignores case and spacing; a fact with five or more digits (a phone,
// an invoice number) also matches on its digits alone. Question sets
// hold real facts, so they belong outside the repository.

export interface ScoreQuestion {
  id: string
  question: string
  /** Facts a correct answer contains, copied as they should appear. */
  expect: string[]
}

export interface ScoreResult {
  id: string
  question: string
  expect: string[]
  found: string[]
  missing: string[]
  /** found / expected, 0–1. */
  score: number
  status: string
  answer: string
  citations: string[]
}

export interface ScoreReport {
  at: string
  questions: string
  agent: string
  /** Whether the shared wiki was searched too. */
  shared: boolean
  /** Mean of the question scores, 0–1. */
  score: number
  /** Questions every expected fact was found for. */
  full: number
  results: ScoreResult[]
}

export function parseQuestionSet(text: string): ScoreQuestion[] {
  const trimmed = text.trim()
  const raw: unknown[] = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  return raw.map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>
    const question = typeof r.question === "string" ? r.question.trim() : ""
    const expect = Array.isArray(r.expect) ? r.expect.filter((e): e is string => typeof e === "string" && !!e.trim()) : []
    if (!question || expect.length === 0) throw new Error(`question ${i + 1} needs a "question" and a non-empty "expect" list`)
    return { id: typeof r.id === "string" && r.id ? r.id : `q${i + 1}`, question, expect }
  })
}

const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").trim()
const digits = (s: string) => s.replace(/\D+/g, "")

/** Which expected facts the answer contains. */
export function matchFacts(answer: string, expect: string[]): { found: string[]; missing: string[] } {
  const text = norm(answer)
  const textDigits = digits(answer)
  const found: string[] = []
  const missing: string[] = []
  for (const fact of expect) {
    const d = digits(fact)
    const hit = text.includes(norm(fact)) || (d.length >= 5 && textDigits.includes(d))
    ;(hit ? found : missing).push(fact)
  }
  return { found, missing }
}

export function buildReport(
  meta: { questions: string; agent: string; shared: boolean; at?: string },
  answers: Array<{ q: ScoreQuestion; answer: string; status: string; citations: string[] }>,
): ScoreReport {
  const results = answers.map(({ q, answer, status, citations }) => {
    const { found, missing } = matchFacts(answer, q.expect)
    return { id: q.id, question: q.question, expect: q.expect, found, missing, score: found.length / q.expect.length, status, answer, citations }
  })
  const score = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0
  return {
    at: meta.at ?? new Date().toISOString(),
    questions: meta.questions, agent: meta.agent, shared: meta.shared,
    score, full: results.filter((r) => r.missing.length === 0).length, results,
  }
}

export interface ScoreDelta {
  id: string
  question: string
  before: number
  after: number
  /** Facts the later run found that the earlier one missed. */
  gained: string[]
  lost: string[]
}

/** Per-question change between two reports on the same set. */
export function compareReports(before: ScoreReport, after: ScoreReport): { before: number; after: number; deltas: ScoreDelta[] } {
  const prior = new Map(before.results.map((r) => [r.id, r]))
  const deltas = after.results.map((r) => {
    const b = prior.get(r.id)
    return {
      id: r.id, question: r.question,
      before: b?.score ?? 0, after: r.score,
      gained: r.found.filter((f) => !b?.found.includes(f)),
      lost: (b?.found ?? []).filter((f) => !r.found.includes(f)),
    }
  })
  return { before: before.score, after: after.score, deltas }
}
