import { noul } from "../questions"
import type { AnswersFor, StateValue } from "../types"

// Whether a task that is starting needs a watcher (#1030).
//
// A task with a due time was handed to a one-off agent chat. The chat
// ended halfway, nothing was watching, and the due time passed in silence.
// The watcher checkpoint asks this seat, at every task start, whether the
// task carries a deadline, a promise to the owner, or a hand-off to another
// agent.
//
// Direction of failure: a missing or uncertain answer means ATTACH. A
// watcher that was not needed closes by itself when the task ends with a
// result; a watcher that was needed and skipped is the incident this seat
// exists to prevent. So the caller only skips on a confident "no", and only
// when the seat is active.

export const TASK_WATCH_SEAT = "task-watch"

export type TaskWatchKind = "dispatch" | "delegation" | "cron"

export interface TaskWatchInput {
  /** The task, in the words it arrived in. */
  message: string
  agent: string
  kind: TaskWatchKind
  channel?: string | null
  /** The agent that handed the task over, when one did. */
  delegator?: string | null
  /** A due time the caller gave, ISO. */
  dueAt?: string | null
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function taskWatchState(input: TaskWatchInput): StateValue {
  return {
    task: clip(input.message, 2000),
    agent: input.agent,
    kind: input.kind,
    channel: input.channel ?? null,
    handedOverBy: input.delegator ?? null,
    dueAt: input.dueAt ?? null,
  }
}

export const taskWatchQuestions = {
  needsWatcher: noul(
    "Someone should notice if this task is not finished: it carries a deadline, a promise to the owner, or a hand-off to another agent.",
    {
      true:
        "The task names a due time or a date, schedules or publishes something for later, answers a request the owner approved or is waiting on, or was handed over by another agent that expects a result back. If it silently stopped halfway, a person or an agent would be let down.",
      false:
        "A self-contained question or chat turn whose answer is the whole result: nobody waits on it after the reply, and nothing is due later.",
    },
  ),
}

export type TaskWatchAnswers = AnswersFor<typeof taskWatchQuestions>

/** The probability that the task needs a watcher. */
export function needsWatcher(answers: TaskWatchAnswers): number {
  return answers.needsWatcher.noul
}
