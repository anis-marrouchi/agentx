import { noul } from "../questions"
import type { AnswersFor, NoulAnswer, Questions, StateValue } from "../types"

// Whether an earlier message of today's conversation is needed to answer
// the current one.
//
// Issue #636. A fresh session opens with up to 30 earlier messages of the
// day rendered into the prompt (SessionStore.buildHistoryContext). Many of
// them are about another topic. This seat scores each candidate message in
// ONE call — one state, one Noul per message — and the caller drops the
// ones the model actively believes are not needed.
//
// The asymmetry matches the wake gate: a wrongly kept message costs a few
// hundred tokens, a wrongly dropped one can cost the answer. So a message
// is dropped only on an explicit, confident "not needed", and any failure
// (seat off, backend down, timeout, a missing answer) keeps everything.
//
// This file is the seat definition only — the floor (which messages are
// never asked about) and the policy live in src/agents/context-prune.ts.

export const CONTEXT_PRUNE_SEAT = "context-prune"

export interface ContextPruneCandidate {
  /** Stable key for the answer, e.g. "m3". */
  key: string
  name: string
  content: string
}

export interface ContextPruneInput {
  /** The message the agent is about to answer. */
  current: string
  /** Messages the floor already keeps, for context — never asked about. */
  kept: Array<{ name: string; content: string }>
  candidates: ContextPruneCandidate[]
  /** Per-message character cap inside the state. */
  maxCharsPerMessage?: number
}

export function contextPruneState(input: ContextPruneInput): StateValue {
  const max = input.maxCharsPerMessage ?? 1500
  return {
    currentMessage: clip(input.current, 4000),
    alwaysKept: input.kept.map((m) => `${m.name}: ${clip(m.content, max)}`),
    candidates: Object.fromEntries(
      input.candidates.map((c) => [c.key, `${c.name}: ${clip(c.content, max)}`]),
    ),
  }
}

export function contextPruneQuestions(candidates: ContextPruneCandidate[]): Questions {
  const questions: Questions = {}
  for (const c of candidates) {
    questions[c.key] = noul(
      `Candidate message "${c.key}" is needed to answer currentMessage well: the answer would be worse, wrong or would have to ask again without it.`,
      {
        true:
          "It holds something the answer depends on: the thread currentMessage continues, a fact, number, name, link, decision, instruction or constraint the answer must use, or what a short reply such as \"yes\", \"do it\" or \"the second one\" refers to.",
        false:
          "It is about a different topic or task, or it is fully superseded by the messages in alwaysKept, and the answer to currentMessage would be just as good without it.",
      },
    )
  }
  return questions
}

export type ContextPruneAnswers = AnswersFor<Questions>

/** P(needed) for one candidate, or NaN when the answer is missing. */
export function neededProbability(answers: ContextPruneAnswers, key: string): number {
  const a = answers[key] as NoulAnswer | undefined
  return a && typeof a.noul === "number" ? a.noul : Number.NaN
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
