import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// Which skill, if any, a task should start from.
//
// The incumbent is matchSkillsToTask() in agent/skills/loader.ts: regex
// triggers at 0.9, tag overlap at 0.3 per tag capped at 0.8, shared words
// over four characters at 0.2 each capped at 0.6, and anything over 0.1
// gets used. Those numbers are not wrong so much as unexamined — they were
// chosen to make a lexical score come out roughly sorted, and they answer
// "which skill shares the most words with this sentence", which is a
// different question from "which skill is this task about".
//
// The lexical matcher stays. It is free, it runs with no network, and it
// is a perfectly good way to narrow a hundred skills down to a handful.
// This seat re-ranks that handful, which is the same division of labour as
// wiki-rerank: cheap recall first, judgement second.
//
// `anyRelevant` is read FIRST and is the more valuable of the two answers.
// A Choice over skills always names one, and the failure that matters here
// is not picking the wrong skill — it is loading a skill at all for a task
// that needed none, which spends context on instructions that do not
// apply and quietly steers the agent toward them.
//
// One thing this seat can do that the incumbent cannot: rank by what a
// skill is FOR. The lexical path needs an author to have written trigger
// patterns and tags by hand, and across ten agent workspaces and 101 skill
// files, exactly zero have opted into auto-injection. A description is
// something every skill already has.

export const SKILL_SELECT_SEAT = "skill-select"

/** Enough to judge a skill by, small enough that a dozen fit in one
 *  request. The instructions themselves are deliberately excluded — they
 *  are thousands of tokens each and the description is what says what the
 *  skill is for. */
export interface SkillCandidate {
  name: string
  description: string
  category?: string | null
  tags?: string[]
}

export interface SkillSelectInput {
  /** The task, in the words it arrived in. */
  task: string
  /** Which agent is about to run it — a deploy skill means something
   *  different to devops than to a content writer. */
  agent?: string | null
  candidates: SkillCandidate[]
}

export function skillSelectState(input: SkillSelectInput): StateValue {
  return {
    task: clip(input.task, 1200),
    ...(input.agent ? { agent: input.agent } : {}),
    skills: input.candidates.map((c) => ({
      name: c.name,
      purpose: clip(c.description, 300),
      ...(c.category ? { category: c.category } : {}),
      ...(c.tags?.length ? { tags: c.tags.slice(0, 8) } : {}),
    })),
  }
}

/** Built per call — the option set IS the shortlist. */
export function skillSelectQuestions(candidates: SkillCandidate[]) {
  const criteria: Record<string, string> = {}
  for (const c of candidates) criteria[c.name] = clip(c.description, 300)

  return {
    anyRelevant: noul(
      "At least one of these skills is about the task at hand.",
      {
        true:
          "The task is the kind of work one of these skills exists for, and following it would change how the work is done — it names the same system, the same procedure or the same kind of artefact.",
        false:
          "None of them is about this task. They may share vocabulary with it, mention the same tools, or belong to the same project without bearing on what is being asked. Sharing words with a task is not being about it.",
      },
    ),
    best: choice(criteria, "Which skill is this task most about?"),
  }
}

export type SkillSelectAnswers = AnswersFor<ReturnType<typeof skillSelectQuestions>>

export interface SkillSelection {
  /** P(any of the shortlist applies). Read before `name`. */
  anyRelevant: number
  name: string
  /** Derived from the shape of the probabilities, never self-reported. */
  confidence: number
  ranked: Array<{ name: string; p: number }>
}

export function toSkillSelection(answers: SkillSelectAnswers): SkillSelection {
  const any = answers.anyRelevant as NoulAnswer
  const best = answers.best as ChoiceAnswer
  const ranked = Object.entries(best.probabilities ?? {})
    .map(([name, p]) => ({ name, p: Number(p) || 0 }))
    .sort((a, b) => b.p - a.p)
  return {
    anyRelevant: any.noul,
    name: best.choice,
    confidence: best.confidence,
    ranked,
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
