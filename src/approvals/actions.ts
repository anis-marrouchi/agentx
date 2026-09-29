import { CARD_LIMITS, listCards, readCard, saveCard, type ActionResult, type CardAction, type DecisionCard } from "./cards"

// --- Card actions: what the daemon does when the operator says yes ---
//
// Run by the daemon's approvals sweep (sweep.ts), whichever process
// recorded the yes. Only a yes runs an action; a no, an expiry or an
// if_silent of "approve" never does.

/** Cards the operator said yes to whose action hasn't run. */
export function cardsAwaitingAction(root: string): DecisionCard[] {
  return listCards(root, "decided").filter((c) => c.verdict === "yes" && c.action && !c.action_result)
}

/**
 * Run a card's action once. The attempt is recorded before it runs, so a
 * crash or a hung send leaves "interrupted" rather than a second send.
 */
export async function runCardAction(
  root: string,
  card: DecisionCard,
  run: (action: CardAction) => Promise<void>,
  now: () => number = Date.now,
): Promise<ActionResult> {
  if (!card.action) return { at: new Date(now()).toISOString(), ok: false, error: "no action" }
  saveCard(root, { ...card, action_result: { at: new Date(now()).toISOString(), ok: false, error: "interrupted before it finished" } })
  let result: ActionResult
  try {
    await run(card.action)
    result = { at: new Date(now()).toISOString(), ok: true }
  } catch (e: any) {
    result = { at: new Date(now()).toISOString(), ok: false, error: String(e?.message ?? e).slice(0, CARD_LIMITS.note) }
  }
  const latest = readCard(root, card.id) ?? card
  saveCard(root, { ...latest, action_result: result })
  return result
}
