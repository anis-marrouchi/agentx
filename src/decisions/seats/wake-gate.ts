import { noul } from "../questions"
import type { AnswersFor, NoulAnswer, StateValue } from "../types"

// Whether an incoming event needs an agent run at all.
//
// Issue #621, step 1. Most of the fleet's spend is GitHub events and
// delegations, and a share of those runs end with the agent reading the
// event, finding nothing to do and saying so — at flagship rates, after
// paying for the whole session context. A wake gate asks a cheap typed
// question BEFORE anything is spawned: does this event need a run?
//
// This file is the seat definition only. Nothing on the dispatch path
// asks it yet, on purpose: a seat that can skip a run has to be backtested
// on recorded traffic and have its false-skip rate stated before it may
// block anything (scripts/backtest-jev.ts does that replay). When the seat
// is wired in, the asymmetry is the whole design: a wrong skip is a
// request nobody answered, a wrong run is one more run — so the caller
// skips only on an explicit, confident "no", and a missing answer (seat
// off, backend down, timeout) always runs the agent.
//
// The state is deliberately limited to what is known BEFORE the run: the
// event text, where it came from, which agent would take it, and whether
// it continues a session. Nothing from the run's outcome (status, turns,
// tokens, the reply) may ever reach this state, or a backtest would be
// grading the seat on an answer it was shown.

export const WAKE_GATE_SEAT = "wake-gate"

export interface WakeGateInput {
  /** The event, in the words it arrived in. */
  message: string
  agent: string
  /** The channel the event came in on: telegram, github, cron, mesh… */
  channel?: string | null
  /** True when the event continues an existing session. */
  continuesExistingSession?: boolean
}

export function wakeGateState(input: WakeGateInput): StateValue {
  return {
    event: clip(input.message, 2000),
    agent: input.agent,
    channel: input.channel ?? null,
    continuesExistingSession: input.continuesExistingSession ?? false,
  }
}

export const wakeGateQuestions = {
  needsRun: noul(
    "This event needs an agent to run: someone or something is waiting for a reply, a decision or work from it.",
    {
      true:
        "It asks a question, gives an instruction, reports a problem, requests a review, mentions the agent, continues a conversation it is part of, or is a scheduled job with pending work. Anything a person would expect an answer or an action to follow.",
      false:
        "Nothing would come of a run: an automated notification with no request in it, a bot's own status line or echo, a duplicate of an event already handled, a bare acknowledgement that needs no answer, a message addressed to someone else, or a heartbeat with nothing pending.",
    },
  ),
}

export type WakeGateAnswers = AnswersFor<typeof wakeGateQuestions>

export function needsRun(answers: WakeGateAnswers): number {
  return (answers.needsRun as NoulAnswer).noul
}

/** Below this P(needs a run), the gate would skip the run.
 *
 *  Low on purpose, like the other skip seats: this is not the point at
 *  which a run becomes unlikely to matter, it is the point past which the
 *  model actively believes nobody is waiting. A wrong skip is invisible —
 *  the person simply never hears back — so the threshold errs on running. */
export const SKIP_BELOW = 0.2

export interface WakeGatePolicy {
  /** A skip needs the model to actively believe no run is needed. */
  maxNeedsRun?: number
}

/** Whether the gate would skip the run. Pure: the threshold is the only
 *  knob, and it is compared against the probability directly (a Noul has no
 *  confidence to gate on — see monitor-prefilter's shouldSkip). */
export function shouldSkipRun(answers: WakeGateAnswers, policy: WakeGatePolicy = {}): boolean {
  const p = needsRun(answers)
  if (!Number.isFinite(p)) return false
  return p <= (policy.maxNeedsRun ?? SKIP_BELOW)
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
