import { askSeat } from "@/decisions/seat"
import {
  SKILL_SELECT_SEAT,
  skillSelectQuestions,
  skillSelectState,
  toSkillSelection,
  type SkillCandidate,
  type SkillSelectAnswers,
} from "@/decisions/seats/skill-select"
import { matchSkillsToTask } from "./loader"
import type { Skill } from "./types"

// Choosing a skill for a task, in two stages.
//
//   1. matchSkillsToTask — lexical, free, no network. Narrows a hundred
//      skills to a handful. Good at recall, indifferent about precision.
//   2. the skill-select seat — judgement over that handful.
//
// Same division as wiki-rerank, and for the same reason: the cheap stage
// is the one that has to look at everything.
//
// Stage 1 only sees skills whose author wrote trigger patterns or tags, so
// it is also the stage that limits what is reachable. SHORTLIST_FLOOR is
// deliberately lower than the injection threshold the incumbent uses —
// recall is stage one's job, and the seat is what says no.

/** Below this the lexical matcher is reporting noise, but the bar is low
 *  on purpose: a skill the shortlist never mentions cannot be chosen. */
const SHORTLIST_FLOOR = 0.1

/** How many the seat is asked to judge. Beyond a dozen the request grows
 *  without the answer improving — the lexical stage is not sorting well
 *  enough for the twelfth candidate to be a contender. */
const SHORTLIST_SIZE = 12

export interface SkillPick {
  /** The chosen skill, or null when nothing applies. */
  skill: Skill | null
  /** P(any shortlisted skill is about this task). */
  anyRelevant: number
  confidence: number
  /** What the lexical stage put forward, best first. */
  shortlist: Array<{ name: string; lexical: number; p?: number }>
  /** True when the seat answered; false when this is the lexical result
   *  alone, because a seat that is off must not look like a judgement. */
  judged: boolean
  reason: string
}

/**
 * Rank a workspace's skills against a task.
 *
 * Returns a pick, never applies it — whether a skill is loaded, suggested
 * or ignored is the caller's policy, and this deliberately has no opinion
 * about per-turn context injection.
 */
export async function pickSkillForTask(
  skills: Skill[],
  task: string,
  opts: { agent?: string | null; minRelevant?: number } = {},
): Promise<SkillPick> {
  const minRelevant = opts.minRelevant ?? 0.6

  const lexical = matchSkillsToTask(skills, task)
    .filter((m) => m.relevance >= SHORTLIST_FLOOR)
    .slice(0, SHORTLIST_SIZE)

  const shortlist = lexical.map((m) => ({
    name: m.skill.frontmatter.name,
    lexical: m.relevance,
  }))

  if (lexical.length === 0) {
    return {
      skill: null, anyRelevant: 0, confidence: 0, shortlist, judged: false,
      reason: "no skill mentions anything in this task",
    }
  }

  // One candidate is not a choice. Still worth asking whether it applies,
  // but a Choice over a single option carries no information, so the
  // lexical score stands and the Noul is not paid for either.
  if (lexical.length === 1) {
    return {
      skill: lexical[0].skill, anyRelevant: lexical[0].relevance,
      confidence: lexical[0].relevance, shortlist, judged: false,
      reason: `only ${lexical[0].skill.frontmatter.name} matched (${lexical[0].matchReason})`,
    }
  }

  const candidates: SkillCandidate[] = lexical.map((m) => ({
    name: m.skill.frontmatter.name,
    description: m.skill.frontmatter.description,
    category: m.skill.frontmatter.category ?? null,
    tags: m.skill.frontmatter.tags,
  }))

  const result = await askSeat(
    SKILL_SELECT_SEAT,
    skillSelectState({ task, agent: opts.agent ?? null, candidates }),
    skillSelectQuestions(candidates),
    {
      // What the lexical matcher would have done, so agreement between the
      // two is measurable rather than assumed.
      incumbent: { best: candidates[0].name },
      features: { agent: opts.agent ?? "unknown", candidates: candidates.length },
    },
  )

  if (!result) {
    return {
      skill: lexical[0].skill, anyRelevant: lexical[0].relevance,
      confidence: lexical[0].relevance, shortlist, judged: false,
      reason: `seat off — lexical top match (${lexical[0].matchReason})`,
    }
  }

  const selection = toSkillSelection(result.answers as SkillSelectAnswers)
  const ranked = shortlist.map((s) => ({
    ...s,
    p: selection.ranked.find((r) => r.name === s.name)?.p ?? 0,
  })).sort((a, b) => (b.p ?? 0) - (a.p ?? 0))

  // Read anyRelevant FIRST. The Choice named something regardless.
  if (selection.anyRelevant < minRelevant) {
    return {
      skill: null, anyRelevant: selection.anyRelevant, confidence: selection.confidence,
      shortlist: ranked, judged: true,
      reason: `nothing on the shortlist is about this task (${selection.anyRelevant.toFixed(2)} below ${minRelevant})`,
    }
  }

  const chosen = lexical.find((m) => m.skill.frontmatter.name === selection.name)
  if (!chosen) {
    // Named something outside the option set. Refuse rather than guess.
    return {
      skill: null, anyRelevant: selection.anyRelevant, confidence: selection.confidence,
      shortlist: ranked, judged: true,
      reason: `seat chose "${selection.name}", which was not on the shortlist`,
    }
  }

  return {
    skill: chosen.skill, anyRelevant: selection.anyRelevant,
    confidence: selection.confidence, shortlist: ranked, judged: true,
    reason: `${selection.name} (confidence ${selection.confidence.toFixed(2)})`,
  }
}
