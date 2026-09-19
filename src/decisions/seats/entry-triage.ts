import { choice, noul, score } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, ScoreAnswer, StateValue } from "../types"

// Triaging raw wiki entries before anything expensive reads them.
//
// The numbers that motivate this: 10,185 unabsorbed raw entries have so
// far produced 257 articles. Absorb pays Sonnet to read every entry and
// write articles for the few that deserve one, at --max 5 per agent —
// 136 nightly runs to clear the backlog, four and a half months.
//
// Most of that spend is reading noise. Deciding whether an entry is worth
// keeping is a classification, not a composition, so it does not need a
// model that can write. The wiki's own absorb prompt already says as much:
//
//   "Choose the type BEFORE writing; if you can't pick one, the article
//    probably isn't needed."
//
// That is a Choice with a none option, stated in prose and handed to a
// writing model. Asked directly it costs about $0.00003 an entry, which
// puts the whole backlog around thirty cents.
//
// What this does NOT do is write the article. Jev cannot generate text.
// The output is a gate and a label; Sonnet still composes whatever
// survives. The saving is in what never reaches it.
//
// ---------------------------------------------------------------------
// MEASURED, AND IT DOES NOT WORK. Do not wire this in active mode.
//
// `agentx wiki triage-backtest` grades the gate against absorb's own
// verdicts — 815 entries absorb cited, 4,811 it passed over, free labels
// already on disk. On a balanced sample of 200:
//
//   default policy      recall 25%, filtering 72%
//   every threshold 0   recall 45%  (the type gate alone costs 55%)
//   type gate off too   recall 95% buys 4% filtering — nothing
//
// So the thresholds were never the problem. A rewritten question aimed
// straight at the label — "would a wiki cite this at all, even one
// sentence inside an article about something else?" — came out
// ANTI-correlated: mean 0.245 on entries absorb kept versus 0.323 on
// entries it discarded. Worse than a coin toss.
//
// Two readings, and they are not exclusive. Absorb merges: whether an
// entry gets cited depends on what else was in its batch of five and
// whether a related article already existed, so the label carries a lot
// of lottery. And whatever the model is judging when asked "is this
// worth keeping", it is not the thing absorb responds to.
//
// The honest state: this seat is unvalidated, the harness that would
// validate it exists, and the evidence so far says no. Left in the tree
// because the backtest is the useful artifact and because a future
// question may do better — but nothing should route through it until a
// run of `wiki triage-backtest --sweep` says otherwise.
// ---------------------------------------------------------------------

export const ENTRY_TRIAGE_SEAT = "entry-triage"

/** The wiki's own enum, plus the escape hatch its prompt describes. */
export const ENTRY_TYPES = {
  person: "A named human, team, or agent",
  project: "A named piece of work with a lifecycle",
  place: "A server, environment, repository, or system",
  concept: "A durable idea, term, or explanation",
  event: "Something that happened at a time — an incident, deploy, meeting",
  decision: "A choice made, and why",
  pattern: "A recurring way of doing or seeing something",
  none: "Nothing that fits a wiki article — chatter, a transient status, a duplicate, or noise",
} as const

export const entryTriageQuestions = {
  // The question that matches how absorb actually behaves.
  //
  // The three below ask whether an entry DESERVES AN ARTICLE. Measured
  // against absorb's own verdicts they filtered 4% of the corpus at 95%
  // recall — useless — because absorb mostly MERGES an entry into an
  // article that already exists. An entry can supply one sentence to a
  // person's page without being a person article itself, so "what type
  // is this?" and "is this worth reading?" are different questions and
  // only the second is the one the gate needs answered.
  citeWorthy: noul(
    "Would a curated wiki cite this entry for anything at all — a fact, a date, a name, a decision — even a single sentence inside an article about something else?",
  ),
  type: choice(ENTRY_TYPES, "What kind of wiki article, if any, does this entry belong in?"),
  worthKeeping: noul("Would this entry still be useful to someone in six months?"),
  procedure: noul("Does this entry describe how to do something, step by step?"),
  // Ordered low to high, so the expected score is directly comparable
  // across entries and thresholdable in code.
  durability: score(
    [
      "True only in the moment it was written",
      "True for days — a status, a run, a transient state",
      "True for months — a project, a person's role, a current setup",
      "True indefinitely — a decision, an incident that happened, a rule",
    ],
    "How long will what this entry says remain true?",
  ),
}

export type EntryTriageAnswers = AnswersFor<typeof entryTriageQuestions>

export interface TriageEntry {
  id: string
  date?: string
  source?: string
  sourceContext?: string
  content: string
}

/** Entries are already short; 2k is generous and keeps a batch cheap. */
export function triageState(entry: TriageEntry, maxChars = 2000): StateValue {
  const text = String(entry.content ?? "").replace(/\s+/g, " ").trim()
  return {
    date: entry.date ?? null,
    source: entry.source ?? null,
    context: entry.sourceContext ? clip(entry.sourceContext, 200) : null,
    content: clip(text, maxChars),
  }
}

export interface TriageVerdict {
  type: keyof typeof ENTRY_TYPES
  typeConfidence: number
  worthKeeping: number
  procedure: number
  durability: number
  /** Should this entry reach the writing model at all? */
  absorb: boolean
  /** Worth remembering but not worth an article — a candidate for the
   *  memory store rather than the wiki. */
  rememberOnly: boolean
}

export interface TriagePolicy {
  /** Minimum confidence in a non-none type before absorbing. */
  minTypeConfidence?: number
  /** Minimum P(useful in six months). */
  minWorth?: number
  /** Minimum expected durability, on the 0-3 rubric above. */
  minDurability?: number
}

/**
 * Three independent signals, because they fail differently.
 *
 * `type` can be confidently wrong about WHICH article an entry belongs in
 * while being right that it belongs in one. `worthKeeping` catches the
 * entry that fits a type but says nothing anyone needs. `durability`
 * catches the one that is genuinely useful today and meaningless next
 * week — the status ping, the "deploy started" line — which is most of
 * what a chat-sourced corpus contains.
 *
 * An entry that clears worth but not durability is not discarded: it is
 * flagged rememberOnly, because "useful but short-lived" describes a
 * memory, not an encyclopaedia article.
 */
export function triage(answers: EntryTriageAnswers, policy: TriagePolicy = {}): TriageVerdict {
  const type = answers.type as ChoiceAnswer
  const worth = (answers.worthKeeping as NoulAnswer).noul
  const procedure = (answers.procedure as NoulAnswer).noul
  const durability = (answers.durability as ScoreAnswer).score

  const minType = policy.minTypeConfidence ?? 0.5
  const minWorth = policy.minWorth ?? 0.5
  const minDurability = policy.minDurability ?? 1.5

  const typed = type.choice !== "none" && type.confidence >= minType
  const useful = worth >= minWorth
  const durable = durability >= minDurability

  return {
    type: type.choice as keyof typeof ENTRY_TYPES,
    typeConfidence: type.confidence,
    worthKeeping: worth,
    procedure,
    durability,
    absorb: typed && useful && durable,
    rememberOnly: !durable && useful,
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}
