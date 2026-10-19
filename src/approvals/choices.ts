// --- Ready-made answers on a decision card ---
//
// A card can offer a few choices (say, three free meeting slots), a
// suggested message the operator may edit before it goes, and a short
// context (what the other person said) shown above the question. The operator's
// pick and the final text are stored on the card and handed to the agent
// that raised it; the agent does the sending. Nothing here sends anything.
//
// All optional: a card without them is the plain yes/no card it always was.

export const CHOICE_LIMITS = {
  /** Most options a card may offer. More is a form, not a choice; the
   *  screen gate (#394) allows 3. */
  count: 3,
  label: 120,
  draft: 2000,
  say: 160,
  context: 600,
  /** The operator's final text, after editing. */
  text: 4000,
} as const

/** The spot in `draft` that takes the picked label. */
export const CHOICE_PLACEHOLDER = "{choice}"

export interface CardChoices {
  choices?: string[]
  draft?: string
  say?: string
  /** A few lines of background, shown above the question. */
  context?: string
}

function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""
}

/** A draft keeps its line breaks: it is a message, not a label. */
function block(v: unknown): string {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : ""
}

/** Validate what an agent sent. Empty input gives an empty object. */
export function buildChoices(input: { choices?: unknown; draft?: unknown; say?: unknown; context?: unknown }): { ok: true; value: CardChoices } | { ok: false; error: string } {
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
  const context = block(input.context)
  if (context) {
    if (context.length > CHOICE_LIMITS.context) return { ok: false, error: `context is longer than ${CHOICE_LIMITS.context} characters` }
    value.context = context
  }
  return { ok: true, value }
}

/** The suggested message for a pick, with `{choice}` filled in. */
export function draftFor(draft: string | undefined, choice: string | undefined): string {
  if (!draft) return ""
  return choice ? draft.split(CHOICE_PLACEHOLDER).join(choice) : draft
}

/**
 * The option the recommendation names, and the reason that is left. The
 * card stores its advice as one line ("Thursday 10:00: your calendar is
 * free"); when that line starts with an option, the card marks that option
 * and starts with it picked. The option must be the whole start: the line
 * ends there, or a separator and a space follow ("No: ..." names No; "Not
 * yet", "No strong view" and "No-one" name nothing, and "Thu 10" is not
 * named by "Thu 10:30"). An option only mentioned further on is
 * not the advice ("do not approve"). No match: nothing is picked, the line
 * shows whole.
 */
export function recommended(card: { recommend?: string; choices?: string[] }): { index: number; why: string } {
  const text = (card.recommend ?? "").trim()
  const low = text.toLowerCase()
  const choices = card.choices ?? []
  let index = -1
  choices.forEach((c, i) => {
    if (!low.startsWith(c.toLowerCase()) || !/^\s*($|[:,.;–—-](\s|$))/.test(text.slice(c.length))) return
    if (index < 0 || c.length > choices[index].length) index = i
  })
  if (index < 0) return { index, why: text }
  const why = text.slice(choices[index].length).replace(/^[\s:,.;–—-]+/, "")
  return { index, why: why.slice(0, 1).toUpperCase() + why.slice(1) }
}

/**
 * Check the operator's answer against the card. A yes on a card with
 * choices must say which one: approving "the meeting" without a date would
 * leave the agent to guess, which is the thing the card exists to avoid.
 * A plain yes (a Yes/No surface, or the CLI without --choice) is a yes to
 * the card's advice, so it takes the option the recommendation names
 * (#1064). With no such option it is refused, naming the options.
 */
export function resolveAnswer(
  card: CardChoices & { recommend?: string },
  verdict: "yes" | "no",
  answer: { choice?: string | number; text?: string },
): { ok: true; choice?: string; text?: string; suggested?: true } | { ok: false; error: string } {
  if (verdict === "no") return { ok: true }
  let choice: string | undefined
  let suggested = false
  const list = card.choices ?? []
  if (answer.choice !== undefined && answer.choice !== "") {
    if (!list.length) return { ok: false, error: "this card has no choices" }
    const n = typeof answer.choice === "number" ? answer.choice : Number(answer.choice)
    if (Number.isInteger(n) && n >= 1 && n <= list.length) choice = list[n - 1]
    else if (list.includes(oneLine(answer.choice))) choice = oneLine(answer.choice)
    else return { ok: false, error: `choice must be 1-${list.length} or one of the labels` }
  } else if (list.length) {
    const rec = recommended({ recommend: card.recommend, choices: list })
    if (rec.index < 0) {
      const options = list.map((l, i) => `${i + 1}. ${l}`).join(", ")
      return { ok: false, error: `this card offers choices and suggests none: pick one of ${options} (\`agentx approvals approve <key> --choice <n>\`)` }
    }
    choice = list[rec.index]
    suggested = true
  }
  let text = block(answer.text)
  if (!text && card.draft) text = draftFor(card.draft, choice)
  if (text.length > CHOICE_LIMITS.text) return { ok: false, error: `text is longer than ${CHOICE_LIMITS.text} characters` }
  return { ok: true, ...(choice ? { choice } : {}), ...(text ? { text } : {}), ...(suggested ? { suggested: true as const } : {}) }
}

/** Lines for the agent's result message. Empty for a plain card. */
export function answerLines(card: { choice?: string; text?: string; choice_suggested?: boolean }): string[] {
  const lines: string[] = []
  if (card.choice) lines.push(`Chosen: ${card.choice}${card.choice_suggested ? " (a plain yes, taken as the suggested option)" : ""}`)
  if (card.text) lines.push("Approved text (send exactly this, the operator may have edited it):", card.text)
  return lines
}
