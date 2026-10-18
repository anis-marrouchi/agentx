import { noul } from "../questions"
import type { AnswersFor, NoulAnswer, StateValue } from "../types"

// Whether a task that is starting needs a watcher (#1030).
//
// A task with a due time was handed from its scheduler to a one-off chat.
// The chat ended halfway, nothing was watching, and the due time passed in
// silence. The question asked here is the one that would have caught it:
// does this task carry something that must not be dropped quietly.
//
// Fail-safe in the opposite direction to most seats. A missing or
// uncertain answer ATTACHES a watcher: an extra alert costs a glance, a
// missed deadline costs the promise. The caller only skips on a confident
// "no" (see src/watchers/checkpoint.ts).

export const TASK_WATCH_SEAT = "task-watch"

export interface TaskWatchInput {
  message: string
  agent: string
  /** How the task started: "dispatch", "delegation" or "cron". */
  source: string
  channel?: string | null
  /** The agent that handed the task on, when there is one. */
  delegator?: string | null
  /** Due time as ISO, when the caller named one. */
  dueAt?: string | null
}

export function taskWatchState(input: TaskWatchInput): StateValue {
  return {
    task: clip(input.message, 2000),
    agent: input.agent,
    startedBy: input.source,
    channel: input.channel ?? null,
    handedOnBy: input.delegator ?? null,
    dueAt: input.dueAt ?? null,
  }
}

export const taskWatchQuestions = {
  needsWatcher: noul(
    "This task must not end silently: someone is counting on it being finished.",
    {
      true:
        "The task carries a deadline or a scheduled time, a promise made to the owner or a client (publish, send, deliver, pay, reply by a date), or it was handed on by another agent who expects the result back.",
      false:
        "Nothing depends on it finishing: a question answered in the same turn, a greeting, a status lookup, a routine check whose next run repeats it anyway.",
    },
  ),
}

export type TaskWatchAnswers = AnswersFor<typeof taskWatchQuestions>

export function needsWatcher(answers: TaskWatchAnswers): number {
  return (answers.needsWatcher as NoulAnswer).noul
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
