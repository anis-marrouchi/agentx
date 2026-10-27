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

/** A control or place on screen, for "where is the export button". */
const CONTROL = String.raw`(button|menu|option|setting|tab|icon|field|toggle|switch|checkbox|panel|sidebar|toolbar|bar|link|control|shortcut|bouton|r[ée]glage|param[eè]tre|onglet|ic[oô]ne|champ|barre|raccourci)s?`

/** The listener asked to be shown how to do something on screen, in
 *  English or French. Work ("Go merge PR 40", "finish the drafts") and
 *  status questions ("where are we on the launch", "how do things look
 *  today", "comment on the PR") never match: a lesson takes the screen,
 *  so only a request about doing something in an app opens one (#1493). */
export const ASKS_TO_BE_SHOWN = new RegExp([
  String.raw`\b(teach|coach)\s+(me|us)\b`,
  String.raw`\bwalk\s+(me|us)\s+through\b`,
  String.raw`\bguide\s+(me|us)\s+(through|to|in)\b`,
  String.raw`\bwatch\s+me\b`,
  String.raw`\bshow\s+(me|us)\s+(how|where)\b`,
  String.raw`\bshow\s+(me|us)\s+(the|that|this)\s+(\S+\s+){0,3}${CONTROL}\b`,
  String.raw`\bhow\s+(do|can|would|should)\s+(i|we)\b`,
  String.raw`\bhow\s+to\s+(do|use|make|add|open|find|get|set|turn|change|create|export|import|save|delete|remove|move|insert|draw|edit)\b`,
  String.raw`\bwhere\s+(do|can|should)\s+(i|we)\s+(find|click|go|set|change|turn)\b`,
  String.raw`\bwhere(\s+is|\s+are|'s|\s+'s)\s+(the|that|this|my)\s+(\S+\s+){0,3}${CONTROL}\b`,
  String.raw`\b(montre|apprends|guide)[- ]moi\b`,
  String.raw`\bexplique[- ]moi\s+comment\b`,
  String.raw`\bcomment\s+(est-ce\s+qu[e']\s*)?(je|j'|on)\s*(fais|fait|peux|peut|dois|doit|ajoute|ouvre|trouve|exporte|mets|met)\b`,
  String.raw`\bcomment\s+faire\b`,
  String.raw`\bo[uù]\s+(est|sont|se\s+trouvent?)\s+(le|la|les|l')\s*(\S+\s+){0,3}${CONTROL}\b`,
  String.raw`\bo[uù]\s+(puis-je|je\s+peux|est-ce\s+que\s+je\s+peux)\s+(trouver|cliquer|r[ée]gler|changer)\b`,
].join("|"), "i")

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
