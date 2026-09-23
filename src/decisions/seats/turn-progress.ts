import { choice } from "../questions"
import type { AnswersFor, ChoiceAnswer, StateValue } from "../types"

// The turn-progress seat: is a long agent turn getting somewhere?
//
// A turn has one hard cap, the agent's maxExecutionMinutes. It is the
// safety net and stays authoritative: it works when a decision backend is
// slow or down. What the cap cannot tell apart is a long turn doing real
// work (an end-to-end run, a big refactor) from one repeating the same
// failing step. Both look identical to a timer, and both end the same way
// at the cap: the work so far is lost and the user gets an error.
//
// The trigger is deliberately mechanical and cheap:
//   - a checkpoint every few minutes of a running turn, and
//   - immediately, once per signature, when one tool call repeats
//     several times in a turn (the clearest looping signal there is).
//
// Shadow only for now. Every row is linked to its task, so the eventual
// promotion (extend a progressing turn, stop a looping one early) can be
// judged against how those turns actually ended.

export const TURN_PROGRESS_SEAT = "turn-progress"

export const turnProgressQuestions = {
  progress: choice(
    {
      progressing:
        "Recent steps move the task forward: new files, commands or checks, results that differ from earlier ones, or a long step whose output shows it advancing.",
      looping:
        "The agent repeats the same or near-identical step (same command, same check, same edit retried with small tweaks) and gets the same failure or result each time.",
      blocked:
        "Progress depends on something the agent cannot change from here: missing access or credentials, a service that is down, or a decision only the user can make.",
    },
    "How the agent's current turn is going, judged from its most recent steps.",
  ),
}

export type TurnProgressAnswers = AnswersFor<typeof turnProgressQuestions>

export interface TurnStep {
  tool: string
  input: string
  result?: string
  error?: boolean
}

export interface TurnProgressInput {
  agent: string
  request: string
  elapsedMinutes: number
  budgetMinutes: number
  steps: TurnStep[]
  /** Most repeated tool call in the turn, when it repeats at all. */
  repeated?: { call: string; times: number }
  trigger: "checkpoint" | "repetition"
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export function turnProgressState(input: TurnProgressInput): StateValue {
  return {
    agent: input.agent,
    request: clip(input.request, 1500),
    elapsedMinutes: Math.round(input.elapsedMinutes),
    budgetMinutes: input.budgetMinutes,
    trigger: input.trigger,
    recentSteps: input.steps.map(s => ({
      tool: s.tool,
      input: clip(s.input, 300),
      ...(s.result !== undefined ? { result: clip(s.result, 300) } : {}),
      ...(s.error ? { failed: true } : {}),
    })),
    ...(input.repeated ? { mostRepeatedCall: input.repeated } : {}),
  }
}

export function turnProgressVerdict(answers: TurnProgressAnswers): string | null {
  return (answers.progress as ChoiceAnswer)?.choice ?? null
}
