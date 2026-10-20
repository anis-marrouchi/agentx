// --- The screen gatekeeper (#394, plan section 1b) ---
//
// What the fleet puts on the owner's screen passes one check, by script,
// no model:
//   - one question per card; a title and an ask short enough to read in
//     about ten seconds (title 120, ask 300 characters);
//   - at most 3 ready-made answers (a plain card has Yes, No, Not now);
//   - follow-up cards (resurface, bring-back, weekly, clean-up) share a
//     budget of 5 a day, at most 3 of them resurface cards;
//   - a title says what it is in words: a bare reference ("#402", a hash,
//     a request id) means nothing to someone glancing at a screen.
// A card that fails is returned to its author with the reason: refused
// when it is written, or not shown and told when the popup comes to it.
// Nothing here rewrites, removes or answers a card. The call and Focus
// hold is notify/hold.ts; the popup window takes no focus (card-window.ts).

export const SCREEN_LIMITS = { title: 120, ask: 300, answers: 3 } as const

export const FOLLOWUP_KINDS = ["resurface", "bring-back", "weekly", "cleanup"] as const
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number]

export const SCREEN_BUDGET = { perDay: 5, resurface: 3 } as const

// References an agent reads easily and the owner does not: links, issue
// and merge request numbers (with or without their project), ULID-like
// ids, request, delegation and send ids, and commit hashes. A hex run
// needs a digit, so a plain word made of a-f letters is not taken for one.
const REFERENCES: RegExp[] = [
  /\bhttps?:\/\/\S+/gi,
  /(?:[\w.-]+\/)*[\w.-]+[#!]\d+\b/g,
  /[#!]\d+\b/g,
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/gi,
  /\b(?:req|dlg|snd)-[\w-]+/gi,
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi,
]

/** The title with every reference taken out. */
export function stripReferences(text: string): string {
  return REFERENCES.reduce((t, re) => t.replace(re, " "), text)
}

/** Why a title that is only a reference may not go on screen, or null.
 *  A title with a reference must keep at least 2 words of letters once
 *  the references are out; a title with none is left to the other rules. */
export function referenceOnlyTitle(title: string): string | null {
  const rest = stripReferences(title)
  if (rest === title) return null
  const words = rest.split(/\s+/).filter((w) => /\p{L}/u.test(w))
  if (words.length >= 2) return null
  return `title is only a reference ("${title.trim()}"); say what it is in plain words, and put the link in the body or source`
}

/** Why this card may not go on the owner's screen, or null. */
export function cardRuleBreak(card: { title: string; ask: string; choices?: string[] }): string | null {
  if (card.title.length > SCREEN_LIMITS.title) return `title is longer than ${SCREEN_LIMITS.title} characters`
  const bare = referenceOnlyTitle(card.title)
  if (bare) return bare
  if (card.ask.length > SCREEN_LIMITS.ask) return `ask is longer than ${SCREEN_LIMITS.ask} characters`
  if ((card.ask.match(/\?/g) ?? []).length > 1) return "ask holds more than one question: one card asks one thing"
  if ((card.choices?.length ?? 0) > SCREEN_LIMITS.answers) return `more than ${SCREEN_LIMITS.answers} choices`
  return null
}

/** Why an agent's `agentx notify` may not go on the owner's screen, or
 *  null: the same ten-second rule, title 120 and message 300 (the message
 *  as shown, with its "To do:" line), and a title in words. */
export function noticeRuleBreak(title: string, message: string): string | null {
  if (title.length > SCREEN_LIMITS.title) return `title is longer than ${SCREEN_LIMITS.title} characters`
  const bare = referenceOnlyTitle(title)
  if (bare) return bare
  if (message.length > SCREEN_LIMITS.ask) return `message is longer than ${SCREEN_LIMITS.ask} characters`
  return null
}

/** An agent's notice as the owner reads it: the "To do:" line first,
 *  then the message. With nothing to do, it says so, so the owner never
 *  has to guess whether a notice wants something. */
export function withTodo(message: string, todo?: string): string {
  const what = todo?.trim().replace(/\s+/g, " ") || "nothing, FYI"
  return `To do: ${what}\n${message}`
}

/** Local midnight before `now`: the budget's day. */
function dayStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Why a follow-up card of this kind cannot be raised today, or null.
 *  `cards` is every card, of any status: an answered one was on screen too. */
export function followupBudgetRefusal(
  cards: Array<{ followup?: FollowupKind; created_at: string }>,
  kind: FollowupKind,
  now: number,
): string | null {
  const from = dayStart(now)
  const today = cards.filter((c) => c.followup && Date.parse(c.created_at) >= from)
  if (today.length >= SCREEN_BUDGET.perDay) {
    return `the follow-up screen budget is used up today (${SCREEN_BUDGET.perDay} cards): raise it again tomorrow`
  }
  if (kind === "resurface" && today.filter((c) => c.followup === "resurface").length >= SCREEN_BUDGET.resurface) {
    return `${SCREEN_BUDGET.resurface} resurface cards were already raised today: raise it again tomorrow`
  }
  return null
}

/** What the author hears when the popup does not show its card. */
export function returnedText(card: { id: string; title: string }, reason: string): string {
  return [
    `[screen gate] Your card ${card.id} ("${card.title}") was not shown to the owner: ${reason}.`,
    "It is still in his inbox, unchanged. If it must reach him on screen, close it (agentx_approval resolve) and raise one that passes:",
    `one question, title up to ${SCREEN_LIMITS.title} characters, ask up to ${SCREEN_LIMITS.ask}, at most ${SCREEN_LIMITS.answers} choices.`,
  ].join(" ")
}
