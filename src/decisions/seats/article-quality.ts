import { choice, noul, score } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, ScoreAnswer, StateValue } from "../types"

// Grading what absorb wrote.
//
// The failure that motivated this is not a bad article, it is a
// plausible one. A client contact's page recorded the invoice thread in
// detail — two dated exchanges, the hourly rate, the instalment — and
// under "How to reach him" said "WhatsApp, in Arabic". The channel, not
// the number. It reads well and cannot answer either question a person
// article exists for: who is this, and how do I reach them.
//
// That is invisible to every check absorb already runs. The JSON parsed,
// the type was valid, the wikilinks resolved, the length was in range.
// Nothing in the pipeline asks whether the article is USEFUL, because
// that is a judgement, and judgements were expensive until they weren't.
//
// Deliberately type-agnostic. A person needs a phone number and a place
// needs a hostname, but both fail the same way — recounting history
// while omitting identity — and one rubric over the whole corpus is
// comparable in a way seven type-specific ones are not.

export const ARTICLE_QUALITY_SEAT = "article-quality"

export const articleQualityQuestions = {
  identityFirst: noul(
    "Does the article state what the subject is before recounting what happened to it?",
  ),
  hasIdentifiers: noul(
    "Does the article contain a concrete identifier — a phone number, address, URL, path, account or handle?",
  ),
  standsAlone: noul(
    "Could a reader who has never seen the source material act on this article without going back to it?",
  ),
  completeness: score(
    [
      "A log of events; the subject itself is barely described",
      "Describes the subject loosely, but a reader would still have to ask basics",
      "Covers the subject, with one or two facts a reader would expect and not find",
      "A reader could act on this without asking anything further",
    ],
    "How completely does this article describe its subject?",
  ),
}

/**
 * The gap options, narrowed to what can apply to this type.
 *
 * A Choice must return something. The first version offered
 * "contact-details" to every article and it won on concept pages about
 * invoice registers and bank downloaders — you do not phone a register.
 * With one strongly-worded attractor in the set, the model picks it
 * rather than the weaker option that actually fits, so the answer said
 * more about the option list than the article.
 *
 * Excluding inapplicable options is not a thumb on the scale. It is
 * declining to ask a question the article cannot answer.
 */
export function gapCriteria(type?: string): Record<string, string> {
  const base: Record<string, string> = {
    none: "Nothing important is missing",
    purpose: "Does not say what the subject is for, or why it matters to us",
    identifiers: "Describes things by name where a concrete value was available",
    relationships: "Does not connect the subject to the projects or people around it",
    "too-narrative": "Mostly a chronology of events rather than a description",
  }
  // Only a thing you contact or visit can be missing a way to reach it.
  if (type === "person" || type === "place" || type === "project") {
    base["contact-details"] = "No way to reach, locate or access the subject"
  }
  if (type === "person" || type === "project") {
    base["role-or-org"] = "Does not say what the subject's role is, or what it belongs to"
  }
  return base
}

/** Questions for one article. The gap options depend on its type. */
export function articleQualityQuestionsFor(type?: string) {
  return {
    ...articleQualityQuestions,
    biggestGap: choice(gapCriteria(type), "What is most conspicuously missing from this article?"),
  }
}

export type ArticleQualityAnswers = AnswersFor<ReturnType<typeof articleQualityQuestionsFor>>

export interface ArticleForReview {
  path: string
  title: string
  type?: string
  tags?: string[]
  body: string
}

/** The whole article, because the judgement is about what is absent —
 *  and a truncated article is missing things for the wrong reason. */
export function articleQualityState(a: ArticleForReview, maxChars = 12_000): StateValue {
  const body = String(a.body ?? "").trim()
  return {
    title: a.title,
    type: a.type ?? null,
    tags: a.tags?.length ? a.tags.join(", ") : null,
    body: body.length > maxChars ? `${body.slice(0, maxChars)}\n…[truncated]` : body,
    truncated: body.length > maxChars,
  }
}

export interface QualityVerdict {
  completeness: number
  identityFirst: number
  hasIdentifiers: number
  standsAlone: number
  biggestGap: string
  /** Good enough to leave alone. */
  adequate: boolean
  /** Worth queueing for a rewrite pass. */
  needsRework: boolean
}

export function gradeArticle(
  answers: ArticleQualityAnswers,
  opts: { minCompleteness?: number } = {},
): QualityVerdict {
  const completeness = (answers.completeness as ScoreAnswer).score
  const identityFirst = (answers.identityFirst as NoulAnswer).noul
  const hasIdentifiers = (answers.hasIdentifiers as NoulAnswer).noul
  const standsAlone = (answers.standsAlone as NoulAnswer).noul
  const gap = (answers.biggestGap as ChoiceAnswer).choice
  const floor = opts.minCompleteness ?? 2

  return {
    completeness,
    identityFirst,
    hasIdentifiers,
    standsAlone,
    biggestGap: gap,
    // standsAlone is the one that decides it. An article can open with a
    // tidy identity line and still send the reader back to the source.
    adequate: completeness >= floor && standsAlone >= 0.5,
    needsRework: completeness < floor || standsAlone < 0.5,
  }
}
