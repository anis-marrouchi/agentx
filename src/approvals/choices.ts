// --- Ready-made answers on a decision card ---
//
// A card can offer a few choices (say, three free meeting slots) and a
// suggested message the operator may edit before it goes. The operator's
// pick and the final text are stored on the card and handed to the agent
// that raised it; the agent does the sending. Nothing here sends anything.
//
// All optional: a card without them is the plain yes/no card it always was.

export const CHOICE_LIMITS = {
  /** Most options a card may offer. More is a form, not a choice. */
  count: 5,
  label: 120,
  draft: 2000,
  say: 160,
  /** The operator's final text, after editing. */
  text: 4000,
} as const

/** The spot in `draft` that takes the picked label. */
export const CHOICE_PLACEHOLDER = "{choice}"

export interface CardChoices {
  choices?: string[]
  draft?: string
  say?: string
}

function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""
}

/** A draft keeps its line breaks: it is a message, not a label. */
function block(v: unknown): string {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : ""
}

/** Validate what an agent sent. Empty input gives an empty object. */
export function buildChoices(input: { choices?: unknown; draft?: unknown; say?: unknown }): { ok: true; value: CardChoices } | { ok: false; error: string } {
  const value: CardChoices = {}
  if (input.choices !== undefined && input.choices !== null) {
    if (!Array.isArray(input.choices)) return { ok: false, error: "choices must be a list of short labels" }
    const labels = input.choices.map(oneLine).filter(Boolean)
    if (labels.length !== input.choices.length) return { ok: false, error: "every choice must be a non-empty label" }
    if (labels.length > CHOICE_LIMITS.count) return { ok: false, error: `at most ${CHOICE_LIMITS.count} choices` }
    if (labels.some((l) => l.length > CHOICE_LIMITS.label)) return { ok: false, error: `a choice is longer than ${CHOICE_LIMITS.label} characters` }
    if (new Set(labels).size !== labels.length) return { ok: false, error: "choices must be different from each other" }
    if (labels.length) value.choices = labels
  }
  const draft = block(input.draft)
  if (draft) {
    if (draft.length > CHOICE_LIMITS.draft) return { ok: false, error: `draft is longer than ${CHOICE_LIMITS.draft} characters` }
    value.draft = draft
  }
  const say = oneLine(input.say)
  if (say) {
    if (say.length > CHOICE_LIMITS.say) return { ok: false, error: `say is longer than ${CHOICE_LIMITS.say} characters` }
    value.say = say
  }
  return { ok: true, value }
}

/** The suggested message for a pick, with `{choice}` filled in. */
export function draftFor(draft: string | undefined, choice: string | undefined): string {
  if (!draft) return ""
  return choice ? draft.split(CHOICE_PLACEHOLDER).join(choice) : draft
}

/**
 * Check the operator's answer against the card. A yes on a card with
 * choices must say which one: approving "the meeting" without a date would
 * leave the agent to guess, which is the thing the card exists to avoid.
 */
export function resolveAnswer(
  card: CardChoices,
  verdict: "yes" | "no",
  answer: { choice?: string | number; text?: string },
): { ok: true; choice?: string; text?: string } | { ok: false; error: string } {
  if (verdict === "no") return { ok: true }
  let choice: string | undefined
  const list = card.choices ?? []
  if (answer.choice !== undefined && answer.choice !== "") {
    if (!list.length) return { ok: false, error: "this card has no choices" }
    const n = typeof answer.choice === "number" ? answer.choice : Number(answer.choice)
    if (Number.isInteger(n) && n >= 1 && n <= list.length) choice = list[n - 1]
    else if (list.includes(oneLine(answer.choice))) choice = oneLine(answer.choice)
    else return { ok: false, error: `choice must be 1-${list.length} or one of the labels` }
  } else if (list.length) {
    return { ok: false, error: "this card offers choices: pick one (Mac popup, or `agentx approvals approve <key> --choice <n>`)" }
  }
  let text = block(answer.text)
  if (!text && card.draft) text = draftFor(card.draft, choice)
  if (text.length > CHOICE_LIMITS.text) return { ok: false, error: `text is longer than ${CHOICE_LIMITS.text} characters` }
  return { ok: true, ...(choice ? { choice } : {}), ...(text ? { text } : {}) }
}

/** Lines for the agent's result message. Empty for a plain card. */
export function answerLines(card: { choice?: string; text?: string }): string[] {
  const lines: string[] = []
  if (card.choice) lines.push(`Chosen: ${card.choice}`)
  if (card.text) lines.push("Approved text (send exactly this, the operator may have edited it):", card.text)
  return lines
}
