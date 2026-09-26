import { choice, noul } from "../questions"
import type { AnswersFor, ChoiceAnswer, NoulAnswer, StateValue } from "../types"

// How an agent shows up on screen for this voice turn.
//
// Decided on every voice turn, because the same agent should sometimes
// only talk, sometimes point at the screen while the user drives, and
// sometimes run a live lesson. A rule cannot tell "what's on my calendar"
// (talk) from "show me how to export this" (teach) from "where's the
// export button" (watch); a person hears the difference at once.
//
// The policy stays in code, not in the seat:
//   - below MIN_CONFIDENCE (the probability of the chosen mode, the number
//     that is logged and calibrated) the turn falls back to talk;
//   - act only when the agent's config allows actions, else talk: a
//     request to do something is answered and done by the agent's turn,
//     never turned into a lesson the listener did not ask for;
//   - teach and watch only when the listener asked to be shown or
//     coached (ASKS_TO_BE_SHOWN), else talk: a lesson takes the screen
//     and the door, so it is never the seat's guess alone;
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
      act: "The user asks the agent to do something on screen itself: click, fill in, operate an app for them.",
      teach: "The user wants to learn how to do something in an app, step by step, with the agent leading and showing where.",
      watch: "The user is driving and wants a coach: where a control is, what to do next, while they do it themselves.",
      quiet: "The agent should not appear on screen at all: a private matter, or the user is presenting or recording.",
    },
    "How the agent should show up on screen for this turn.",
  ),
  persist: noul("The agent's on-screen presence should stay after this turn, because the conversation is likely to continue on screen."),
  nextAction: choice(
    {
      speak: "Just say something.",
      point: "Move the agent's cursor to a control so the user sees where it is.",
      highlight: "Outline a control or area so the user sees what to look at.",
      click: "Press a control for the user.",
      type: "Type text into a field for the user.",
      wait_for_user: "Wait for the user to do something or say something first.",
    },
    "The agent's first on-screen action this turn.",
  ),
}

export type PresenceModeAnswers = AnswersFor<typeof presenceModeQuestions>

export interface PresenceModeInput {
  agent: string
  /** What the user just said. */
  request: string
  /** Frontmost app and window, when known. */
  app?: string | null
  window?: string | null
  /** Whether this agent may click and type for the user. */
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
  override?: "no-decision" | "low-confidence" | "actions-not-allowed" | "not-asked-to-show"
}

export const TALK: PresenceDecision = { mode: "talk", persist: false, nextAction: "speak", chose: null, probability: 0, override: "no-decision" }

/** The listener asked to be shown, taught or coached, in English or French.
 *  "Go merge PR 40" or "finish the drafts" never match: those are work. */
export const ASKS_TO_BE_SHOWN =
  /\b(show|teach|guide|walk|coach|watch)\s+(me|us)\b|\bhow\s+(do|can|would|should|to)\b|\bwhere\s+(is|are|do|can|'s)\b|\bwhere's\b|\bstep\s+by\s+step\b|\b(tutorial|lesson)\b|\b(montre|explique|guide)[- ]moi\b|\bcomment\s+(on|je|faire)\b|\bo[uù]\s+(est|sont|se\s+trouve)\b/i

/** Apply the policy to the seat's answers; null answers mean talk.
 *  `request` is what the listener said; teach and watch need it to ask. */
export function toPresence(answers: PresenceModeAnswers | null, actionsAllowed: boolean, request: string, min = MIN_CONFIDENCE): PresenceDecision {
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
  if (chosen === "act" && !actionsAllowed) { chosen = "talk"; override = "actions-not-allowed" }
  if ((chosen === "teach" || chosen === "watch") && !ASKS_TO_BE_SHOWN.test(request)) { chosen = "talk"; override = "not-asked-to-show" }
  if ((nextAction === "click" || nextAction === "type") && chosen !== "act") nextAction = "highlight"
  if (chosen === "talk" || chosen === "quiet") nextAction = "speak"
  return { mode: chosen, persist: chosen !== "quiet" && persist, nextAction, chose, probability, ...(override ? { override } : {}) }
}
