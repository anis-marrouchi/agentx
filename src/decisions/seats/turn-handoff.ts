import { choice, noul } from "../questions"
import type { AnswersFor, StateValue } from "../types"

// Two seats around the moment an agent hands the conversation back.
//
// turn-handoff: the agent ended its turn by asking the user something.
// Some of those questions are the point (a public change, money, a third
// party). Others ask permission for the next local step of the very task
// the user asked for, and cost a full round trip for a "yes go ahead".
// Measured over two weeks of task history: 7% of turns ended in a question,
// and 17% of those got a bare approval back.
//
// approval-binding: the user's message is short and the agent's previous
// reply was a question. "yes go ahead" means nothing on its own; routing
// and context selection judged it as a trivial acknowledgement and moved an
// approved coding turn to the cheap model. Binding the approval to what it
// approves is the fix this seat measures.
//
// Both are shadow only. turn-handoff gets a free outcome label: the user's
// next message on the same conversation either approves or redirects.

export const TURN_HANDOFF_SEAT = "turn-handoff"
export const APPROVAL_BINDING_SEAT = "approval-binding"

export const turnHandoffQuestions = {
  nextStep: choice(
    {
      proceed:
        "The question asks permission for a local, reversible next step that is already inside what the user asked for, such as writing or testing code in the working copy, reading, or running checks.",
      ask_outward:
        "The next step changes something outside the working copy or is hard to undo: pushing, publishing, merging, deploying, deleting, spending money, or messaging someone other than the user.",
      ask_ambiguous:
        "The agent cannot tell what the user wants: several different goals are plausible, or the user must choose between options with different results.",
    },
    "What the agent should do with the question it ended its turn on.",
  ),
}

export const approvalBindingQuestions = {
  approves: noul(
    "The user's message approves the plan or step the agent proposed at the end of its previous reply.",
    {
      true: 'The message accepts the proposal, including terse replies such as "yes", "go ahead" or "ok do it", possibly with small additions that do not change the plan.',
      false: "The message declines, changes the plan, asks something new, or answers a different question than the one the agent asked.",
    },
  ),
}

export type TurnHandoffAnswers = AnswersFor<typeof turnHandoffQuestions>
export type ApprovalBindingAnswers = AnswersFor<typeof approvalBindingQuestions>

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)

const QUESTION_TAIL = /(should i|want me to|shall i|do you want|which (one|option|task)|let me know)[^\n]*$/i

/** The reply hands the turn back with a question. */
export function endsWithQuestion(reply: string): boolean {
  const text = reply.trim()
  if (!text) return false
  if (/\?\s*(\*\*)?\s*$/.test(text)) return true
  return QUESTION_TAIL.test(text.split("\n").slice(-3).join(" "))
}

const APPROVAL = /^\s*(yes|yep|yeah|ok(ay)?|sure|go( ahead)?|proceed|do it|please do|confirmed?|approved?|go-ahead|let'?s go|oui|نعم)\b/i

/** A short message that reads as a plain approval. Conservative on purpose:
 *  it is used as the outcome label for turn-handoff. */
export function isBareApproval(message: string): boolean {
  return message.trim().length <= 160 && APPROVAL.test(message)
}

/** A message short enough that it only makes sense against the agent's
 *  previous reply. */
export function isShortReply(message: string): boolean {
  return message.trim().length <= 160
}

export function turnHandoffState(input: { agent: string; channel: string; request: string; reply: string }): StateValue {
  return {
    agent: input.agent,
    channel: input.channel,
    request: clip(input.request, 1500),
    agentReplyEnding: tail(input.reply, 1200),
  }
}

export function approvalBindingState(input: { agent: string; channel: string; message: string; previousReply: string }): StateValue {
  return {
    agent: input.agent,
    channel: input.channel,
    userMessage: input.message,
    agentPreviousReplyEnding: tail(input.previousReply, 1200),
  }
}
