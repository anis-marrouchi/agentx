import type { DecisionCard } from "@/approvals/cards"

// --- What the daemon asked, and the yes the person clicked (#1892 phase 7) ---
//
// The card file under .agentx/approvals is written by many processes and
// can be written by an agent with a shell, before or after the person
// answers. So the file never decides what is shown or granted:
//
//  1. When the daemon raises a source-consent card, it keeps the card as
//     it wrote it here (`rememberAsk`).
//  2. The popup shows that remembered card (`askedCard`), and shows
//     nothing for a source-consent card the daemon did not ask or whose
//     file differs from what it asked.
//  3. When the person clicks Yes, the popup runner records the yes with
//     the remembered values (`recordPopupYes`), and only if the file still
//     matches the ask.
//  4. The turn the daemon starts to tell the agent the answer is recorded
//     (`recordAnswerTurn`): only that task may read from "approvals:<card>".
//
// In memory only, on purpose: a restart ends every ask and every yes (the
// safe side). Another process (`agentx approvals popup` in a terminal)
// has none of this either, so its yes lets nothing be read.

export interface PopupYes {
  cardId: string
  clickedAt: number
  agentId: string
  sources: string[]
  minutes: number
  taskId?: string
  chat?: string
  /** The card's own deadline for an answer, as asked. */
  expires: number
}

const DAY_MS = 24 * 3600_000
const asks = new Map<string, { card: DecisionCard; at: number }>()
const yeses = new Map<string, PopupYes>()
const answerTurns = new Map<string, string>()

/** The fields a person reads or that grant something. */
function shownFields(c: DecisionCard): string {
  return JSON.stringify([c.id, c.title, c.ask, c.context ?? null, c.say ?? null, c.recommend, c.choices ?? null, c.draft ?? null,
    c.raised_by, c.expires, c.popup_only ?? null, c.node ?? null, c.if_silent, c.origin ?? null])
}

function prune(now: number): void {
  for (const [id, a] of asks) if (now - a.at > DAY_MS) asks.delete(id)
  for (const [id, y] of yeses) if (now - y.clickedAt > DAY_MS) { yeses.delete(id); answerTurns.delete(id) }
}

/** Called by the daemon right after it wrote a source-consent card. */
export function rememberAsk(card: DecisionCard, now: number = Date.now()): void {
  if (card.origin?.kind !== "source-consent") return
  asks.set(card.id, { card: structuredClone(card), at: now })
  prune(now)
}

/** The source-consent card as the daemon asked it, or why it may not be
 *  shown: unknown here, or the file changed since. */
export function askedCard(file: DecisionCard): { card: DecisionCard } | { refused: string } {
  const a = asks.get(file.id)
  if (!a) return { refused: "this daemon did not raise this card (or restarted since); ask again" }
  if (shownFields(file) !== shownFields(a.card)) return { refused: "the card was changed after it was asked; ask again" }
  return { card: { ...structuredClone(a.card), status: file.status } }
}

/** Called by the popup runner right after the person's Yes was recorded.
 *  `fileNow` is the card file as it is now. Records nothing unless the
 *  daemon asked this card and the file still matches the ask. */
export function recordPopupYes(fileNow: DecisionCard | null, at: number): void {
  if (!fileNow || fileNow.origin?.kind !== "source-consent") return
  const asked = askedCard(fileNow)
  if ("refused" in asked) return
  const c = asked.card
  const o = c.origin
  if (o?.kind !== "source-consent" || !c.popup_only || c.node) return
  if (!Array.isArray(o.sources) || typeof o.minutes !== "number") return
  yeses.set(c.id, {
    cardId: c.id, clickedAt: at, agentId: o.agentId, sources: [...o.sources], minutes: o.minutes,
    ...(o.taskId ? { taskId: o.taskId } : {}), ...(o.chat ? { chat: o.chat } : {}),
    expires: Date.parse(c.expires),
  })
  prune(at)
}

export function popupYesFor(cardId: string): PopupYes | null {
  return yeses.get(cardId) ?? null
}

/** The daemon started the turn that tells the agent this card's answer. */
export function recordAnswerTurn(cardId: string, taskId: string): void {
  answerTurns.set(cardId, taskId)
}

export function answerTurnFor(cardId: string): string | null {
  return answerTurns.get(cardId) ?? null
}

/** Tests, and nothing else. Also what a restart does. */
export function clearPopupYes(): void {
  asks.clear()
  yeses.clear()
  answerTurns.clear()
}
