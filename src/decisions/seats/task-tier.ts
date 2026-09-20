import { noul } from "../questions"
import type { AnswersFor, NoulAnswer, StateValue } from "../types"

// Whether a task needs the flagship model.
//
// Every claude-code agent on both nodes runs claude-opus-5. Much of what
// they actually do is not hard: acknowledging a message, reading a file
// and saying what is in it, restating a status, routing a mention. Those
// turns cost flagship rates for work a small model finishes correctly.
//
// A single Noul, not a Choice over model names, and that is deliberate.
// The models available differ per node, per tier and per provider, and a
// Choice whose options are a fleet's current model list is a decision that
// silently changes meaning every time someone edits config. The question
// that stays stable is about the TASK: does this need the strongest model
// available. Mapping that answer onto a specific model is policy, and
// policy belongs in code where it can be read.
//
// Direction of failure is the whole design. A seat is fail-open by
// contract — askSeat returns null when it is off or unreachable — and here
// "open" must mean KEEP THE FLAGSHIP. A missing answer that quietly
// downgrades a model would turn an outage into silently worse work across
// the fleet, which is far more expensive than the tokens it saved. So the
// caller only ever downgrades on an explicit, confident "no".

export const TASK_TIER_SEAT = "task-tier"

export interface TaskTierInput {
  /** The task, in the words it arrived in. */
  message: string
  agent: string
  /** Where it came from — a cron heartbeat and a customer message are not
   *  the same kind of work even when they read alike. */
  channel?: string | null
  /** True when this continues an existing session. A follow-up inherits
   *  the difficulty of what it is following up on, and switching models
   *  mid-conversation is its own hazard. */
  isFollowUp?: boolean
  /** Tools the agent could reach for. A task that will touch production
   *  is not a cheap task however simply it is phrased. */
  toolsAvailable?: number
}

export function taskTierState(input: TaskTierInput): StateValue {
  return {
    task: clip(input.message, 2000),
    agent: input.agent,
    channel: input.channel ?? null,
    continuesExistingSession: input.isFollowUp ?? false,
    ...(input.toolsAvailable ? { toolsAvailable: input.toolsAvailable } : {}),
  }
}

export const taskTierQuestions = {
  needsFlagship: noul(
    "This task needs the strongest available model to be done correctly.",
    {
      true:
        "Doing it well takes real reasoning: writing or reviewing code, diagnosing a failure, planning work across several steps, weighing a judgement, handling money, touching production or anything irreversible, following a long or ambiguous instruction, or work where being subtly wrong would not be noticed. Anything where a weaker model would produce something that LOOKS right belongs here.",
      false:
        "It is mechanical and its result is obvious on sight: acknowledging or confirming a message, restating or formatting something already written, a greeting, a status echo, reading one file and reporting what it says, a lookup with one right answer, a scheduled heartbeat with nothing to decide.",
    },
  ),
}

export type TaskTierAnswers = AnswersFor<typeof taskTierQuestions>

export function needsFlagship(answers: TaskTierAnswers): number {
  return (answers.needsFlagship as NoulAnswer).noul
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
