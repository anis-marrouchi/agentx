import { createCard, readCard, saveCard, type CardInput, type CardSettings, type DecisionCard } from "@/approvals/cards"
import { CHOICE_LIMITS } from "@/approvals/choices"
import type { LearnedDraftsOrigin } from "@/approvals/origin"
import { type LearnedRow, type LearnedTemplateStore, type OpenCard } from "./learned"

// --- The owner's weekly card for learned templates (#1990) ---
//
// Owner's words (2026-11-19): "yes but i dont want these to go stale and
// i dont want to overwhelm the user". So:
//
//   - one decision card a week holds that week's drafts (at most
//     situations.learned.maxDrafts, 2 by default), and none when there is
//     nothing new. It is raised by the situation-learn workflow's `card`
//     step, owner-only (popup_only: a yes counts only in the popup);
//   - with two drafts it offers "Use both", "Only: <first>", "Only:
//     <second>"; No turns both down. One draft: yes or no. More than two:
//     yes uses all, no turns all down; one by one with
//     `agentx situation learned answer <id> yes|no`;
//   - the card file under .agentx/approvals can be written by any process
//     on this machine, an agent's shell included. So it never answers:
//     the answer is sealed (learned.ts) only from the popup this daemon
//     shows (popup-runner.ts), which shows the card rebuilt from the
//     sealed state, not the file, or from the operator-key route;
//   - the card expires before the next weekly run, which drops what was
//     left unanswered (learned.ts startWeek).

export const LEARNED_CARD_KIND = "learned-drafts" as const
/** Who the card is from: the workflow, not an agent. */
export const LEARNED_CARD_BY = "situation-learn"
/** A card lasts until shortly before the next weekly run. */
export const LEARNED_CARD_DAYS = 6

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

/** One draft as the owner reads it: its title, its sentences, its note
 *  guidance, in at most `max` characters (`agentx situation learned`
 *  shows all of it). */
function draftLine(r: LearnedRow, n: number, max: number): string {
  const parts = [r.rules.during && `During: ${r.rules.during}`, r.rules.ending && `Ending: ${r.rules.ending}`, r.rules.ended && `After: ${r.rules.ended}`,
    r.noteGuidance && `Note: ${r.noteGuidance}`].filter(Boolean)
  return cut(`${n}. ${r.title} (${r.id}). ${parts.join(" ")}`, max)
}

/** The choices for a card of two drafts. */
export function cardChoices(rows: Array<Pick<LearnedRow, "title">>): string[] | undefined {
  if (rows.length !== 2) return undefined
  const [a, b] = rows.map((r) => cut(`Only: ${r.title}`, CHOICE_LIMITS.label))
  return a === b ? ["Use both", "Only the first", "Only the second"] : ["Use both", a, b]
}

/** The card for this week's drafts, and the lines it also says. Built
 *  the same way when it is raised and when the popup shows it. */
export function learnedCardInput(rows: LearnedRow[], said: string[], expires: number): CardInput {
  const n = rows.length
  const also = said.length ? cut(`Also: ${said.join(" ")}`, 240) : ""
  const room = CHOICE_LIMITS.context - (also ? also.length + 1 : 0)
  const per = Math.floor((room - (n - 1)) / Math.max(1, n))
  const context = [...rows.map((r, i) => draftLine(r, i + 1, per)), ...(also ? [also] : [])].join("\n")
  const choices = cardChoices(rows)
  const title = n === 1 ? cut(`Learned template to approve: ${rows[0].title}`, 120) : `Learned templates to approve: ${n} drafts`
  const ask = n === 1
    ? "Use this learned template on the talks you name it on? No turns it down for good."
    : n === 2
      ? "Which of this week's learned templates may be used on the talks you name them on? No turns both down."
      : "Use all of this week's learned templates on the talks you name them on? One by one: agentx situation learned answer <id> yes|no."
  return {
    title, ask,
    recommend: "Your call: no agent decides this. Left unanswered, the drafts are dropped at next week's run.",
    if_silent: "discard",
    expires: new Date(expires).toISOString(),
    source: "agentx situation learned",
    raised_by: LEARNED_CARD_BY,
    context,
    ...(choices ? { choices } : {}),
  }
}

/** What the weekly run needs of the card files (learn.ts). */
export interface LearnedCards {
  raise(input: CardInput, origin: LearnedDraftsOrigin): { ok: true; card: DecisionCard } | { ok: false; error: string }
  /** Close a card: "expired" at the next run, "answered" once every
   *  draft got the owner's sealed answer. Only a pending card changes. */
  close(id: string, how: "expired" | "answered"): void
  /** The file shows an answer from a person (not the expiry). Never
   *  approves anything: it only keeps learning from pausing. */
  answered(id: string): boolean
}

export function learnedCards(root: string, opts: { now?: () => number; settings?: () => CardSettings } = {}): LearnedCards {
  const now = () => (opts.now ?? Date.now)()
  return {
    raise: (input, origin) => createCard(root, input, { now: now(), origin, popupOnly: true, ...(opts.settings ? { settings: opts.settings() } : {}) }),
    close: (id, how) => {
      const c = readCard(root, id)
      if (!c || c.status !== "pending") return
      const at = new Date(now()).toISOString()
      saveCard(root, how === "expired"
        ? { ...c, status: "expired", outcome: "discard", decided_by: "expiry", decided_at: at, agent_notified_at: at }
        : { ...c, status: "resolved", decided_by: "owner", decided_at: at, resolution: "answered with agentx situation learned answer", agent_notified_at: at })
    },
    answered: (id) => {
      const c = readCard(root, id)
      return !!c && c.status === "decided" && c.decided_by !== "expiry"
    },
  }
}

/** The rows of the open card, in order, or why it cannot be shown. */
function openRows(store: LearnedTemplateStore, card: OpenCard): LearnedRow[] | null {
  const rows = card.drafts.map((id) => store.get(id))
  return rows.every((r): r is LearnedRow => !!r && r.sealed) ? rows : null
}

/** The card as the popup shows it: rebuilt from the sealed state, never
 *  from the file, which any process on this machine can write. Refused
 *  for any card that is not this daemon's open learned-templates card. */
export function learnedCardShown(store: LearnedTemplateStore, file: DecisionCard): { card: DecisionCard } | { refused: string } {
  const open = store.openCard()
  if (!open || open.id !== file.id || file.origin?.kind !== LEARNED_CARD_KIND) return { refused: "not this week's learned-templates card of this daemon" }
  const rows = openRows(store, open)
  if (!rows) return { refused: "a draft of this card changed after it was drafted" }
  const input = learnedCardInput(rows, open.said, open.expires)
  const { title, ask, recommend, context, choices, expires, source } = input as Record<string, any>
  const card: DecisionCard = {
    ...file,
    title, ask, recommend, context, expires, source,
    raised_by: LEARNED_CARD_BY, if_silent: "discard", popup_only: true,
    origin: { kind: LEARNED_CARD_KIND, drafts: [...open.drafts] },
  }
  delete card.node
  delete card.draft
  delete card.say
  if (choices) card.choices = choices
  else delete card.choices
  return { card }
}

/** The drafts a popup answer says yes to. Null: the answer names no
 *  option this card offers (nothing is sealed). */
export function yesDrafts(drafts: string[], shownChoices: string[] | undefined, verdict: "yes" | "no", choice?: string): string[] | null {
  if (verdict === "no") return []
  if (drafts.length !== 2) return [...drafts]
  const i = (shownChoices ?? []).indexOf(choice ?? "")
  if (i === 0) return [...drafts]
  if (i === 1) return [drafts[0]]
  if (i === 2) return [drafts[1]]
  return null
}

/** The owner answered the card in this daemon's popup: seal each draft's
 *  yes or no. `shown` is the card as learnedCardShown built it. */
export function learnedCardAnswer(store: LearnedTemplateStore, shown: DecisionCard, verdict: "yes" | "no", choice: string | undefined, cards?: LearnedCards): Array<{ id: string; yes: boolean; ok: boolean; error?: string }> {
  const open = store.openCard()
  if (!open || open.id !== shown.id) return []
  const yes = yesDrafts(open.drafts, shown.choices, verdict, choice)
  if (!yes) return []
  const out = open.drafts.map((id) => {
    const r = store.answer(id, yes.includes(id))
    return r.ok ? { id, yes: yes.includes(id), ok: true } : { id, yes: yes.includes(id), ok: false, error: r.error }
  })
  // The popup already closed the file; this covers any other path.
  cards?.close(open.id, "answered")
  return out
}

/** One line for the log. */
export function answeredLine(rows: Array<{ id: string; yes: boolean; ok: boolean }>): string {
  return rows.map((r) => `${r.id} ${r.ok ? (r.yes ? "approved" : "turned down") : "not sealed"}`).join("; ")
}

