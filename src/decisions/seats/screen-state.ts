import { noul } from "../questions"
import type { AnswersFor, NoulAnswer, StateValue } from "../types"

// Turning "what I see" into "whether it is so".
//
// Perception and judgement are split on purpose. A vision model is good at
// saying what is on a screen and bad at knowing when that settles a
// question — asked "is it recording", it will read a recorder's window and
// answer yes, which is an inference about the world presented as a reading
// of the pixels. So computer-use/look.ts gets the observation, and the
// verdict is taken here against a stated boundary.
//
// `observable` is the question that matters and it is read FIRST.
//
// The whole handicap this seat exists to remove is that the system had no
// way to say "I cannot tell". A lesson told Screen Studio to record, it did
// not record, and every check in the pipeline was really a check that a
// function had returned — so the run continued and reported success. A
// verifier that can only answer yes or no will answer one of them when the
// evidence is absent, which is the same failure wearing a probability.
//
// Measured limits, so nobody trusts this further than it goes. On
// 2026-09-20, against a screen that WAS recording, asked whether a
// recording was in progress from a menu bar capture:
//
//   claude-sonnet-5                 no   (missed it, native resolution)
//   qwen3-vl-235b-a22b-instruct     no   (missed it)
//   qwen3-vl-30b-a3b-instruct       yes  — but cited "the red dot", and
//                                   macOS draws that indicator in purple,
//                                   so the right answer came from a prior
//                                   rather than from the image
//
// macOS draws it at about six points. That is below what these models
// resolve reliably, and "a model said yes" is not the same as "a model saw
// it". Small status indicators are a known blind spot; ask a process or a
// file for those, and keep this for what is plainly visible — a dialog
// covering a field, a page that has loaded, a field with text in it, a
// toggle that is plainly on.

export const SCREEN_STATE_SEAT = "screen-state"

export const screenStateQuestions = {
  /** Read first. Whether the evidence gathered settles the claim AT ALL.
   *
   *  About ALL the evidence, not only the image. A system check can settle
   *  a question the screenshot cannot — a capture process in the process
   *  list decides "is it recording" outright — and an earlier cut of this
   *  seat asked only about the image, so it answered 10% and returned
   *  "cannot tell" while a deterministic probe was holding the answer. */
  observable: noul(
    "The evidence gathered — the screenshot and the system checks together — is enough to settle the claim, either way.",
    {
      true:
        "Something in the evidence decides it. Either the observation names a specific visible detail that bears on the claim and was legible, or a system check directly establishes the claim true or false. A system check alone is sufficient: it does not need the image to agree with it, or the image to have shown anything at all.",
      false:
        "Nothing decides it. The deciding detail is not in frame, too small or blurred, or covered; the observation only describes context — which application is open, what the screen generally shows — without the detail itself; and no system check settles it either. Absence of evidence in a capture that could not have shown the evidence is not evidence of absence. This is also false when a check says the question is not answerable from a screenshot and the observation nonetheless claims to have seen it: that is a guess, however specific it sounds.",
    },
  ),
  /** Only meaningful when `observable` is high. */
  holds: noul(
    "The claim is true of the screen right now.",
    {
      true:
        "The visible evidence shows the claimed state is in effect: the indicator is present, the text is there, the element is visible and unobstructed, the action has plainly already happened.",
      false:
        "The visible evidence shows the claimed state is NOT in effect. An application being open, capable of the action, or offering it, is not the action having happened — a recorder on screen is not a recording, an unpressed button is not a pressed one, an offered dialog is not a chosen one. A system check that directly contradicts the observation outweighs it: the checks are deterministic readings of the machine, the observation is a model's reading of an image.",
    },
  ),
}

export type ScreenStateAnswers = AnswersFor<typeof screenStateQuestions>

export interface ScreenStateInput {
  /** What is being asserted about the screen, in plain words. */
  claim: string
  /** What the vision model reported seeing. */
  observation: string
  /** The specific detail it rested on, if any. */
  evidence: string
  /** Its own uncalibrated reading. Included as a data point, and named as
   *  one, so it informs the judgement without becoming it. */
  reading: "yes" | "no" | "unclear"
  /** Which part of the screen was captured, in words. */
  region: string
  /** What the accessibility tree said, when it said anything. A tree that
   *  lists the control corroborates an observation that mentions it. */
  treeNote?: string
  /** Deterministic facts from the system — a process list, a file size.
   *
   *  The seat cannot see the screen, so an observation is otherwise the
   *  only evidence it has and a confident wrong one is indistinguishable
   *  from a confident right one. These are the facts that can contradict
   *  it, including the fact that something is not knowable from here. */
  probes?: Array<{ checked: string; found: string }>
}

export function screenStateState(input: ScreenStateInput): StateValue {
  return {
    claim: input.claim,
    capturedRegion: input.region,
    whatWasSeen: input.observation,
    decidingDetail: input.evidence || null,
    visionModelReading: input.reading,
    ...(input.treeNote ? { accessibilityTree: input.treeNote } : {}),
    ...(input.probes?.length ? { systemChecks: input.probes } : {}),
  }
}

export interface Verdict {
  /** P(the image could settle it). */
  observable: number
  /** P(the claim holds). Only meaningful when `observable` is high. */
  holds: number
}

export function toVerdict(answers: ScreenStateAnswers): Verdict {
  return {
    observable: (answers.observable as NoulAnswer).noul,
    holds: (answers.holds as NoulAnswer).noul,
  }
}
