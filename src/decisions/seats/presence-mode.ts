import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// How an agent shows up on screen for this voice turn.
//
// Decided on every voice turn, because the same agent should sometimes
// only talk, sometimes point at the screen while Anis drives, and
// sometimes run a live lesson. A rule cannot tell "what's on my calendar"
// (talk) from "show me how to export this" (teach) from "where's the
// export button" (watch); a person hears the difference at once.
//
// The policy stays in code, not in the seat:
//   - below MIN_CONFIDENCE (the probability of the chosen mode, the number
//     that is logged and calibrated) the turn falls back to talk;
//   - act only when the agent's config allows actions, else teach;
//   - click and type only in act, else highlight.

export const PRESENCE_MODE_SEAT = "presence-mode"

export const PRESENCE_MODES = ["talk", "act", "teach", "watch", "quiet"] as const
export type PresenceMode = (typeof PRESENCE_MODES)[number]
export const NEXT_ACTIONS = ["speak", "point", "highlight", "click", "type", "wait_for_user"] as const
export type NextAction = (typeof NEXT_ACTIONS)[number]

export const presenceModeQuestions = {
  mode: choice(
    {
      talk: "Answer by voice only: a question, a status, a decision. Nothing on screen needs showing.",
      act: "Anis asks the agent to do something on screen itself: click, fill in, operate an app for him.",
      teach: "Anis wants to learn how to do something in an app, step by step, with the agent leading and showing where.",
      watch: "Anis is driving and wants a coach: where a control is, what to do next, while he does it himself.",
      quiet: "The agent should not appear on screen at all: a private matter, or Anis is presenting or recording.",
    },
    "How the agent should show up on screen for this turn.",
  ),
  persist: noul("The agent's on-screen presence should stay after this turn, because the conversation is likely to continue on screen."),
  nextAction: choice(
    {
      speak: "Just say something.",
      point: "Move the agent's cursor to a control so Anis sees where it is.",
      highlight: "Outline a control or area so Anis sees what to look at.",
      click: "Press a control for Anis.",
      type: "Type text into a field for Anis.",
      wait_for_user: "Wait for Anis to do something or say something first.",
    },
    "The agent's first on-screen action this turn.",
  ),
}

export type PresenceModeAnswers = AnswersFor<typeof presenceModeQuestions>

export interface PresenceModeInput {
  agent: string
  /** What Anis just said. */
  request: string
  /** Frontmost app and window, when known. */
  app?: string | null
  window?: string | null
  /** Whether this agent may click and type for Anis. */
  actionsAllowed: boolean
  /** Mode of the previous voice turn, if the agent is still on screen. */
  previousMode?: PresenceMode | null
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

export function presenceModeState(input: PresenceModeInput): StateValue {
  return {
    agent: input.agent,
    request: clip(input.request, 800),
    frontmostApp: input.app ?? null,
    window: input.window ? clip(input.window, 120) : null,
    actionsAllowed: input.actionsAllowed,
    previousMode: input.previousMode ?? null,
  }
}

/** Below this, the mode falls back to talk. */
export const MIN_CONFIDENCE = 0.55

export interface PresenceDecision {
  mode: PresenceMode
  persist: boolean
  nextAction: NextAction
  /** What the seat chose, and its probability, before any fallback. */
  chose: PresenceMode | null
  probability: number
  /** Why the seat's choice was not used as is, when it was not. */
  override?: "no-decision" | "low-confidence" | "actions-not-allowed"
}

export const TALK: PresenceDecision = { mode: "talk", persist: false, nextAction: "speak", chose: null, probability: 0, override: "no-decision" }

/** Apply the policy to the seat's answers; null answers mean talk. */
export function toPresence(answers: PresenceModeAnswers | null, actionsAllowed: boolean, min = MIN_CONFIDENCE): PresenceDecision {
  if (!answers) return TALK
  const mode = answers.mode as ChoiceAnswer<PresenceMode>
  const next = answers.nextAction as ChoiceAnswer<NextAction>
  const probability = mode.probabilities[mode.choice] ?? 0
  const persist = (answers.persist as NoulAnswer).noul >= 0.5
  const chose = mode.choice
  if (probability < min) return { mode: "talk", persist: false, nextAction: "speak", chose, probability, override: "low-confidence" }
  let chosen = mode.choice
  let nextAction = next.choice
  let override: PresenceDecision["override"]
  if (chosen === "act" && !actionsAllowed) { chosen = "teach"; override = "actions-not-allowed" }
  if ((nextAction === "click" || nextAction === "type") && chosen !== "act") nextAction = "highlight"
  if (chosen === "talk" || chosen === "quiet") nextAction = "speak"
  return { mode: chosen, persist: chosen !== "quiet" && persist, nextAction, chose, probability, ...(override ? { override } : {}) }
}
