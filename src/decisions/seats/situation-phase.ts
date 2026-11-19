import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// --- situation-phase: the unsure messages at the end of a talk (#1892, phase 5) ---
//
// The courtesy gate's word list (situations/courtesy.ts) answers most
// messages in code. A short message it cannot place ("ok", "👍", "thanks
// John", "perfect, thanks") is "unsure", and unsure always passes: it may
// be the answer to a question the agent asked. This seat is asked about
// those messages only, and only once the talk is ending or has ended: one
// call, three questions (design 6: phase, needs a reply, importance).
//
// The asymmetry is the whole design: a wrong "no reply" is a person who
// never hears back, a wrong "reply" is one more turn. So the gate acts only
// on a confident "no reply" (P(needs a reply) at or under a low threshold),
// only in active mode, and only after the calibration report shows a false
// "no reply" rate under the limit the owner set. A missing answer (seat
// off, backend down, credits out, timeout) is today's rule: it passes.
//
// The state is what is known when the message arrives: its text, who sent
// it (person, bot, agent), the channel, whether it is a group, the talk's
// phase and why it got there. Nothing from the agent's answer.

export const SITUATION_PHASE_SEAT = "situation-phase"

export type SituationImportance = "low" | "normal" | "high"

export interface SituationPhaseInput {
  message: string
  senderKind: "person" | "bot" | "agent"
  channel: string
  group: boolean
  phase: "ending" | "ended"
  /** Why the talk is in this phase ("the goodbye was sent"). */
  why?: string
  /** Minutes since the phase changed. */
  minutesInPhase?: number
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

export function situationPhaseState(input: SituationPhaseInput): StateValue {
  return {
    message: clip(input.message ?? "", 1000),
    sender: input.senderKind,
    channel: input.channel,
    chat: input.group ? "group" : "private",
    phase: input.phase,
    phaseWhy: clip(input.why ?? "", 200),
    minutesInPhase: Math.max(0, Math.round(input.minutesInPhase ?? 0)),
  }
}

export const situationPhaseQuestions = {
  phase: choice(
    {
      during: "The talk goes on: the message adds something, answers a question, or asks for something.",
      ending: "The other side is closing the talk, but a short goodbye from the agent is still due.",
      ended: "The talk is over: the message only acknowledges, thanks or says goodbye after the end.",
    },
    "Where the conversation is after this message arrived.",
  ),
  needsReply: noul(
    "This message needs a reply from the agent.",
    {
      true:
        "It asks or confirms something the agent must act on, answers a question the agent asked (\"ok\", \"yes\", \"perfect\" can be that answer), starts a new topic, or would leave the sender waiting without a reply.",
      false:
        "It only acknowledges, thanks or says goodbye after the talk already ended, and nobody would expect an answer to it.",
    },
  ),
  importance: choice(
    {
      low: "Routine: an automated party, a pleasantry, nothing at stake.",
      normal: "An ordinary talk with a person.",
      high: "Something is at stake: a client, money, a deadline, a promise, or an upset sender.",
    },
    "How much this talk matters to the owner.",
  ),
}

export type SituationPhaseAnswers = AnswersFor<typeof situationPhaseQuestions>

/** P(the message needs a reply). NaN when the answer is malformed. */
export function pNeedsReply(answers: SituationPhaseAnswers): number {
  const a = answers.needsReply as NoulAnswer | undefined
  return Number(a?.noul)
}

/** At or under this P(needs a reply), the seat says "no reply needed".
 *  Low on purpose, like the other skip seats (wake-gate SKIP_BELOW). */
export const NO_REPLY_BELOW = 0.2

/** The seat says no reply is needed. A malformed answer is never a no. */
export function saysNoReply(answers: SituationPhaseAnswers, below = NO_REPLY_BELOW): boolean {
  const p = pNeedsReply(answers)
  return Number.isFinite(p) && p <= below
}

export function seatPhase(answers: SituationPhaseAnswers): string | null {
  return (answers.phase as ChoiceAnswer | undefined)?.choice ?? null
}

export function seatImportance(answers: SituationPhaseAnswers): SituationImportance | null {
  const c = (answers.importance as ChoiceAnswer | undefined)?.choice
  return c === "low" || c === "normal" || c === "high" ? c : null
}
