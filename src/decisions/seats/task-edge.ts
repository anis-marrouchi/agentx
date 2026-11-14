import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// Whether one job needs more than the agent's own model, and whether it
// is worth splitting among sub-agents.
//
// The task-tier seat asks the opposite question: can this job run on a
// cheaper model. This seat looks the other way. An agent runs every day
// on one strong model, and a few jobs are harder than that model does
// reliably. Those jobs go to the edge model (the most capable one the
// operator names in `decisions.routing.edgeModels`) for that job only.
// The next job is back on the agent's own model.
//
// A separate seat, not a second question on task-tier, so each direction
// has its own mode, its own rows and its own soak. Moving a job down and
// moving a job up fail in different ways and are promoted on different
// evidence.
//
// Direction of failure: a missing or unsure answer KEEPS THE AGENT'S OWN
// MODEL and adds no sub-agent hint. A wrong "yes" costs money and quota;
// a wrong "no" leaves the job where it would have run anyway. So only an
// explicit, confident "yes" from an ACTIVE seat changes anything.
//
// Two Nouls on one shared state, one call. Both are about the TASK, not
// about model names, for the reason given in task-tier.ts: the answer
// must keep its meaning when someone edits the model list.

export const TASK_EDGE_SEAT = "task-edge"

export interface TaskEdgeInput {
  /** The task, in the words it arrived in. */
  message: string
  agent: string
  channel?: string | null
  /** True when this continues an existing session. */
  isFollowUp?: boolean
  /** The agent's own instructions, clipped: they say what work is routine
   *  for this agent. */
  agentPrompt?: string | null
}

export function taskEdgeState(input: TaskEdgeInput): StateValue {
  return {
    task: clip(input.message, 2000),
    agent: input.agent,
    channel: input.channel ?? null,
    continuesExistingSession: input.isFollowUp ?? false,
    ...(input.agentPrompt ? { agentInstructions: clip(input.agentPrompt, 600) } : {}),
  }
}

export const taskEdgeQuestions = {
  needsEdge: noul(
    "This task is harder than a strong everyday model does reliably, and needs the most capable model available.",
    {
      true:
        "It is at the limit of what a strong model gets right: designing or changing the architecture of a system, a root cause that earlier attempts did not find, a subtle concurrency, security or data-loss problem, a long build with many dependent steps and nobody checking in between, a decision that cannot be undone and turns on fine reasoning, or research that must weigh sources that disagree.",
      false:
        "It is ordinary work for a strong model: a routine code change or review, a clear bug with a known cause, answering a question, writing a message or a summary, a status report, a lookup, routing or acknowledging something, or a scheduled check.",
    },
  ),
  subagentsHelp: noul(
    "This task would be done faster or better if separate workers did parts of it at the same time.",
    {
      true:
        "It has several parts that do not depend on each other (many files, repositories, issues, sources or items to handle the same way), or it needs a wide search whose raw results the main worker does not need to keep, or it asks for an independent second review of the work.",
      false:
        "It is one line of work where each step needs the result of the step before, or it is small: one file, one question, one message, one command.",
    },
  ),
}

// Implied work (`decisions.routing.impliedWork`).
//
// A person often describes a problem and asks for nothing: "we cannot see
// whether an agent is still working on its job". Read as a sentence it is
// a remark, and needsEdge scores it as one (0.25 to 0.37 on live Jev,
// 2026-11-14, with or without "asked or implied" in the question). The
// work it leads to can still be large. Two more questions on the same
// state, in the same call, read that:
//
//   workAsked     asked outright, implied by a problem, or no work wanted
//   designChange  the problem needs a change to the design, not one fix
//
// Live Jev, same day (workAsked=implied / designChange):
//
//   the visibility remark above                            0.98 / 0.85
//   "the staging login page shows a typo in the footer"    0.99 / 0.10
//   "invoices sometimes show the wrong currency and
//    nobody knows when it happens"                            - / 0.86
//   "the cron for backups failed last night, disk full"      - / 0.30
//   "thanks, the deploy looks good now"                    none / -
//
// The words of the request are never rewritten: the seat returns typed
// answers and the agent is the one that states the job back.
export const impliedWorkQuestions = {
  workAsked: choice(
    {
      asked: "The message asks outright for something to be done or answered.",
      implied:
        "The message describes a problem, a complaint or something that does not work, and asks for nothing. Work to find the cause or fix it is implied.",
      none: "The message only informs, thanks, agrees or chats. No work is wanted.",
    },
    "What does the sender of this message want from the agent?",
  ),
  designChange: noul(
    "Fixing the problem this message describes needs a change to how the system is designed, not one local fix.",
    {
      true:
        "The problem comes from how parts of the system work together, shows up in many places or over time, and its cause is not stated, so someone must investigate and design a change.",
      false:
        "The cause and the place are clear and one small change fixes it, or the message describes no problem.",
    },
  ),
}

/** The questions of one call: the two base ones, plus the implied-work
 *  pair when that reading is switched on. */
export function taskEdgeQuestionsFor(impliedWork: boolean) {
  return impliedWork ? { ...taskEdgeQuestions, ...impliedWorkQuestions } : taskEdgeQuestions
}

export type TaskEdgeAnswers = AnswersFor<typeof taskEdgeQuestions>
export type ImpliedWorkAnswers = AnswersFor<typeof impliedWorkQuestions>

/** P(the message implies work it does not ask for), or null when the
 *  answer is missing or malformed. */
export function impliedWork(answers: Record<string, unknown> | null | undefined): number | null {
  const p = ((answers?.workAsked as ChoiceAnswer | undefined)?.probabilities as Record<string, unknown> | undefined)?.implied
  return typeof p === "number" && Number.isFinite(p) ? p : null
}

export function needsEdge(answers: TaskEdgeAnswers): number {
  return (answers.needsEdge as NoulAnswer).noul
}

export function subagentsHelp(answers: TaskEdgeAnswers): number {
  return (answers.subagentsHelp as NoulAnswer).noul
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
