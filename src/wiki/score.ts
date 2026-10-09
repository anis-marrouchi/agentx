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
// an invoice number) also matches on its digits alone. "a|b" accepts
// either spelling (a date or an amount written two ways). Question sets
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
  /** How the pages were picked for this question. */
  method?: string
  /** Wall time of the question, in milliseconds. */
  ms?: number
  /** Model spend of the question, in dollars. Unset when it is not known
   *  (the catalog method, or a call that reported no cost). */
  costUsd?: number
}

/** What a run was asked with, so two reports show what changed between them. */
export interface ScoreSettings {
  method: string
  linkedPages: number
  linkedChars: number
  live: boolean
  notes: boolean
  navigatorModel: string
  answerModel: string
}

export interface ScoreReport {
  at: string
  questions: string
  agent: string
  /** Whether the shared wiki was searched too. */
  shared: boolean
  /** Unset in reports written before #863. */
  settings?: ScoreSettings
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
    // "2027-03-31|31/03/2027": any one spelling counts.
    const hit = fact.split("|").some((alt) => {
      const d = digits(alt)
      return (!!alt.trim() && text.includes(norm(alt))) || (d.length >= 5 && textDigits.includes(d))
    })
    ;(hit ? found : missing).push(fact)
  }
  return { found, missing }
}

export function buildReport(
  meta: { questions: string; agent: string; shared: boolean; at?: string; settings?: ScoreSettings },
  answers: Array<{ q: ScoreQuestion; answer: string; status: string; citations: string[]; method?: string; ms?: number; costUsd?: number }>,
): ScoreReport {
  const results = answers.map(({ q, answer, status, citations, method, ms, costUsd }) => {
    const { found, missing } = matchFacts(answer, q.expect)
    return {
      id: q.id, question: q.question, expect: q.expect, found, missing, score: found.length / q.expect.length, status, answer, citations,
      ...(method ? { method } : {}), ...(ms !== undefined ? { ms } : {}), ...(costUsd !== undefined ? { costUsd } : {}),
    }
  })
  const score = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0
  return {
    at: meta.at ?? new Date().toISOString(),
    questions: meta.questions, agent: meta.agent, shared: meta.shared,
    ...(meta.settings ? { settings: meta.settings } : {}),
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
  /** Wall time and spend of the question in each run, when recorded. */
  ms?: { before?: number; after?: number }
  costUsd?: { before?: number; after?: number }
}

/** Mean time and spend per question of one report, over the questions
 *  that recorded them. Unset when none did. */
export interface RunCost {
  meanMs?: number
  meanCostUsd?: number
  /** Questions with no recorded spend: the mean leaves them out. */
  unpriced: number
}

export function runCost(report: ScoreReport): RunCost {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined)
  const ms = report.results.flatMap((r) => (r.ms === undefined ? [] : [r.ms]))
  const usd = report.results.flatMap((r) => (r.costUsd === undefined ? [] : [r.costUsd]))
  return { meanMs: mean(ms), meanCostUsd: mean(usd), unpriced: report.results.length - usd.length }
}

export interface ReportComparison {
  before: number
  after: number
  deltas: ScoreDelta[]
  /** Settings that differ, as "key: before → after". Unknown when either
   *  report predates recorded settings. A fair test changes one. */
  changed: string[] | "unknown"
  /** Question ids only one of the two reports holds. */
  onlyBefore: string[]
  onlyAfter: string[]
  cost: { before: RunCost; after: RunCost }
}

/** Per-question change between two reports on the same set. */
export function compareReports(before: ScoreReport, after: ScoreReport): ReportComparison {
  const prior = new Map(before.results.map((r) => [r.id, r]))
  const deltas = after.results.map((r) => {
    const b = prior.get(r.id)
    return {
      id: r.id, question: r.question,
      before: b?.score ?? 0, after: r.score,
      gained: r.found.filter((f) => !b?.found.includes(f)),
      lost: (b?.found ?? []).filter((f) => !r.found.includes(f)),
      ...(b?.ms !== undefined || r.ms !== undefined ? { ms: { before: b?.ms, after: r.ms } } : {}),
      ...(b?.costUsd !== undefined || r.costUsd !== undefined ? { costUsd: { before: b?.costUsd, after: r.costUsd } } : {}),
    }
  })
  const afterIds = new Set(after.results.map((r) => r.id))
  return {
    before: before.score, after: after.score, deltas,
    changed: settingsChanged(before, after),
    onlyBefore: before.results.filter((r) => !afterIds.has(r.id)).map((r) => r.id),
    onlyAfter: after.results.filter((r) => !prior.has(r.id)).map((r) => r.id),
    cost: { before: runCost(before), after: runCost(after) },
  }
}

function settingsChanged(before: ScoreReport, after: ScoreReport): string[] | "unknown" {
  if (!before.settings || !after.settings) return "unknown"
  const a: Record<string, unknown> = { ...before.settings, agent: before.agent, shared: before.shared }
  const b: Record<string, unknown> = { ...after.settings, agent: after.agent, shared: after.shared }
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k])
    .map((k) => `${k}: ${String(a[k])} → ${String(b[k])}`)
}
