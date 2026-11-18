import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// The due-time seat: did this run set a due time its agent owes? (#1908)
//
// An agent can write "Due 12:00Z, set by me" in a reply or in a note on an
// issue, and nothing in the daemon knows. The time passes and nobody is
// woken. The owner's ruling: whether a wake-up stands behind a due time is
// decided here, not left to the agent's own will.
//
// The seat reads what the run said (its final reply, and the notes it
// posted while it ran) and answers two typed questions. It judges yes or
// no only. The daemon does no time arithmetic with the answer: the time
// itself comes from the record the agent makes when it is asked (a promise
// with `due` and `closeWhen`), see src/requests/due-gate.ts.
//
// The asymmetry: a missed commitment is a due time nobody is woken for, a
// false one is one extra question to the agent, which it answers with
// "Due: none". So the caller asks on a fairly sure yes, and a missing
// answer (seat off, backend down, timeout) changes nothing.

export const DUE_TIME_SEAT = "due-time"

export interface DueTimeInput {
  agent: string
  /** The channel the run answered on: telegram, a2a, github… */
  channel?: string | null
  /** The run's final reply. */
  reply: string
  /** What the agent posted while it ran: issue notes, comments, messages. */
  notes?: string[]
  /** When the run ended, ISO. Lets "tomorrow" and "at 15:00" be read. */
  now?: string
}

const REPLY_MAX = 4000
const NOTE_MAX = 800
const NOTES_MAX = 8

export function dueTimeState(input: DueTimeInput): StateValue {
  return {
    agent: input.agent,
    channel: input.channel ?? null,
    now: input.now ?? null,
    // The end of a long reply is where a due time is stated.
    finalReply: tail(input.reply, REPLY_MAX),
    notesPosted: (input.notes ?? []).slice(-NOTES_MAX).map((n) => clip(n, NOTE_MAX)),
  }
}

export const dueTimeQuestions = {
  commits: noul(
    "The text sets a due time that this agent owes: its own deadline for something it will do or deliver later, or one it accepted from someone.",
    {
      true:
        "The agent names a time or a day by which it itself will do, deliver, post, check or review something that is not done yet: \"I will post the review by 15:00Z\", \"Due 12:00Z, set by me\", \"I'll check again tomorrow morning\", \"Accepted, you get it before Friday\".",
      false:
        "No time is owed by this agent: a time something already happened (\"merged at 09:30Z\"), a schedule or a deadline that belongs to someone else, a time only quoted from the request, a conditional offer (\"if you want, I can do it by 15:00\"), or work that is finished in this reply.",
    },
  ),
  owner: choice(
    {
      this_agent: "This agent owes it: it set the due time for itself, or accepted it.",
      another_agent: "Another agent owes it: this agent only passed the due time on or reports it.",
      person: "A person owes it: the owner, a client, a reviewer.",
      none: "No due time is set in the text.",
    },
    "Who owes the due time the text sets, if it sets one.",
  ),
}

export type DueTimeAnswers = AnswersFor<typeof dueTimeQuestions>

/** P(the run set a due time its agent owes). */
export function commitsDueTime(answers: DueTimeAnswers): number {
  return (answers.commits as NoulAnswer).noul
}

export function dueTimeOwner(answers: DueTimeAnswers): string | null {
  return (answers.owner as ChoiceAnswer)?.choice ?? null
}

/** At or above this P(commits), the gate asks the agent for a record.
 *  Above the middle on purpose: the ask is cheap but not free (one short
 *  turn in the agent's session), so an even guess does not start one. */
export const ASK_AT = 0.7

export interface DueTimePolicy {
  /** The gate asks at or above this P(commits). */
  minCommits?: number
}

/** Whether the answer says a due time was set that needs a record. Pure. */
export function needsDueRecord(answers: DueTimeAnswers, policy: DueTimePolicy = {}): boolean {
  const p = commitsDueTime(answers)
  if (!Number.isFinite(p)) return false
  return p >= (policy.minCommits ?? ASK_AT)
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function tail(s: string, max: number): string {
  return s.length > max ? `…${s.slice(-max)}` : s
}
