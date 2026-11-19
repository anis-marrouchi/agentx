import type { DecisionCard } from "@/approvals/cards"

// --- A yes the person clicked in the daemon's popup (#1892 phase 7) ---
//
// The card file under .agentx/approvals is written by many processes and
// can be written by an agent with a shell. So the file alone never grants
// a read: the daemon's popup runner, when the person clicks Yes on a
// source-consent card, keeps here what that card showed (agent, sources,
// minutes, the asking task) and when. The consent check needs this
// record, and takes its values from it, not from the file.
//
// In memory only, on purpose: a restart ends every yes (the safe side).
// A yes recorded by another process (`agentx approvals popup` in a
// terminal) is not here either, so it lets nothing be read.

export interface PopupYes {
  cardId: string
  clickedAt: number
  agentId: string
  sources: string[]
  minutes: number
  taskId?: string
  chat?: string
  /** The card's own deadline for an answer, as shown. */
  expires: number
}

const yeses = new Map<string, PopupYes>()

/** Called by the popup runner right after the person's Yes was recorded.
 *  `card` is the card as it was shown. Anything but a source-consent
 *  card records nothing. */
export function recordPopupYes(card: DecisionCard, at: number): void {
  const o = card.origin
  if (o?.kind !== "source-consent" || !card.popup_only || card.node) return
  if (!Array.isArray(o.sources) || typeof o.minutes !== "number") return
  yeses.set(card.id, {
    cardId: card.id, clickedAt: at, agentId: o.agentId, sources: [...o.sources], minutes: o.minutes,
    ...(o.taskId ? { taskId: o.taskId } : {}), ...(o.chat ? { chat: o.chat } : {}),
    expires: Date.parse(card.expires),
  })
  // Old ones go: nothing lives past a day.
  for (const [id, y] of yeses) if (at - y.clickedAt > 24 * 3600_000) yeses.delete(id)
}

export function popupYesFor(cardId: string): PopupYes | null {
  return yeses.get(cardId) ?? null
}

/** Tests, and nothing else. */
export function clearPopupYes(): void {
  yeses.clear()
}
