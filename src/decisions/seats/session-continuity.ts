import { noul } from "../questions"
import type { AnswersFor, NoulAnswer, StateValue } from "../types"

// The session-continuity seat.
//
// Every production agent is claude-code tier, which means `claude --resume`
// replays its own transcript on every turn and agentx never owns the
// messages array. The one lever agentx does own is WHEN to stop resuming.
// That is what drives the cache-read bill: devops-agent reads 186M cached
// tokens a week at a 60:1 read-to-write ratio, and every one of those reads
// is a turn re-reading a transcript agentx chose to keep alive.
//
// Today three hand-tuned mechanical triggers decide it: turn count, last
// turn's context size, and 12 hours of silence. None of them knows whether
// the conversation is actually continuous. A new task that changed the
// subject entirely still resumes a 150K-token transcript, because it
// arrived 40 minutes after the last one.
//
// Those thresholds were not derived, they were tuned after an incident —
// sessions rotating on cumulative usage (3.3M vs 195K) read to users as
// the agent developing amnesia mid-task. That is the signature of a number
// picked under pressure and never measured since.
//
// A WARNING ABOUT THIS SEAT SPECIFICALLY.
//
// Its two sides are not equally measurable. The cost of keeping a session
// alive is exact — it is in lastTurnContextTokens. The cost of killing one
// too early is amnesia, which shows up as a confused user, not a metric.
// Optimising only the side you can measure is how the original incident
// happened. So:
//
//   - the seat may only recommend rotating EARLY, never skipping a
//     mechanical rotation. The safety triggers stay authoritative.
//   - `needsHistory` is the labelled question, not `continues`. Whether
//     the reply actually depended on earlier context is the thing that
//     hurts when wrong, and it is the thing a human can judge.
//
// Ground truth here is weaker than the monitor pre-filter's, which derives
// its labels for free. Expect to label these by hand, lowest-confidence
// first, and do not promote this seat on the cost number alone.

export const SESSION_CONTINUITY_SEAT = "session-continuity"

// One clause each, in the state's own vocabulary — see the note on phrasing
// in monitor-prefilter.ts. These two are deliberately close but not
// identical: a request can change subject while still depending on earlier
// context ("forget the deploy, what was that token you mentioned?"), and
// rotating on that one is precisely the amnesia case.
export const sessionContinuityQuestions = {
  continues: noul("Is the new request part of the same piece of work as the previous request?"),
  needsHistory: noul("Does the new request refer to something stated earlier in the conversation?"),
}

export type SessionContinuityAnswers = AnswersFor<typeof sessionContinuityQuestions>

export interface ContinuityInput {
  /** The request about to be dispatched. */
  message: string
  /** The previous user message in this chat, if any. */
  previousMessage?: string | null
  /** Requests BEFORE `previousMessage`, oldest first.
   *
   *  Empty by default. The benchmark showed why the option exists: on
   *  subject changes with no lexical signpost, two messages alone left the
   *  model genuinely unsure (`continues` 0.58 where a clean change scored
   *  0.22), and no policy threshold recovers a number that never separated.
   *  A subject boundary is visible against a run of requests in a way it is
   *  not against one predecessor.
   *
   *  Bounded and off unless asked for, because this runs before every
   *  resumed turn and the whole point of the seat is to be cheaper than
   *  what it guards. */
  recentRequests?: string[]
  minutesSinceLastTurn: number | null
  turnCount: number
  lastTurnContextTokens: number | null
  agentId: string
  channel: string
}

/** Small on purpose. Deciding whether two requests are the same piece of
 *  work needs the two requests, not the transcript between them — and this
 *  runs before a task that has not started yet, so it must be cheap.
 *
 *  `recentRequests` widens that deliberately narrow window, and stays
 *  absent from the state entirely when empty so the default call is
 *  byte-identical to what it always was. */
export function continuityState(input: ContinuityInput): StateValue {
  const earlier = (input.recentRequests ?? []).filter(Boolean)
  return {
    newRequest: clip(input.message, 1200),
    previousRequest: input.previousMessage ? clip(input.previousMessage, 800) : null,
    ...(earlier.length
      ? { earlierRequests: earlier.map((r) => clip(r, 400)) }
      : {}),
    minutesSinceLastTurn: input.minutesSinceLastTurn,
    turnsSoFar: input.turnCount,
    currentContextTokens: input.lastTurnContextTokens,
    agent: input.agentId,
    channel: input.channel,
  }
}

export interface RotatePolicy {
  /** Both nouls must sit at or below this to rotate early. */
  maxContinuity?: number
  /** True when a mechanical trigger already fired. The seat must not
   *  override those — it can only act when they did NOT fire. */
  mechanicalRotation: boolean
}

/**
 * Should this session rotate EARLY, before any mechanical trigger?
 *
 * Deliberately one-directional. When a threshold has already decided to
 * rotate, this returns false and the threshold wins: the seat can save
 * money by rotating sooner, never by keeping a session alive that the
 * safety rules wanted dead.
 *
 * Both questions must agree. They are correlated but not identical — a
 * request can change subject while still needing earlier context ("ignore
 * the deploy, what was that token you mentioned?"), and rotating on that
 * one is exactly the amnesia case.
 */
export function shouldRotateEarly(
  answers: SessionContinuityAnswers,
  policy: RotatePolicy,
): boolean {
  if (policy.mechanicalRotation) return false

  const maxContinuity = policy.maxContinuity ?? 0.2

  const continues = (answers.continues as NoulAnswer).noul
  const needsHistory = (answers.needsHistory as NoulAnswer).noul

  // Threshold the probabilities directly. There is no second gate, and
  // there was never anything for one to read.
  //
  // This used to also require a "confidence" derived as |noul - 0.5| * 2.
  // A Noul has no confidence: TypeSafe's own primitive documentation says
  // it "does not return a separate confidence value" and warns that a
  // value near 0.5 does not mean medium anything — the probability IS the
  // answer, and the documented way to act on one is to threshold it.
  // types.ts has said the same thing about NoulAnswer since it was
  // written; the gate here contradicted it.
  //
  // It was not merely redundant, it silently halved the threshold. Both
  // nouls at or below 0.2 already forces the derived value to 0.6 or
  // more, so a floor of 0.8 was really the demand that both sit at or
  // below 0.1 — the seat enforced 0.1 while its own docstring, its
  // config and every discussion of it said 0.2. A benchmark sweep found
  // the floor binding on every cell and read it as a tuning knob. It was
  // a misuse of the primitive wearing a knob's clothes.
  return continues <= maxContinuity && needsHistory <= maxContinuity
}

function clip(value: string, max: number): string {
  const text = String(value ?? "")
  return text.length > max ? text.slice(0, max) : text
}
