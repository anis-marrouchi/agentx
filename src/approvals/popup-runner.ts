import { readFocus, focusLabel, type FocusState } from "@/notify/focus"
import { listCards, readCard, type DecisionCard } from "./cards"
import { decide, type InboxContext } from "./inbox"
import { showPopup, type PopupAnswer, type PopupSettings } from "./popup"
import { readInboxState, recordPopped } from "./state"

// --- When the Mac popup shows a card ---
//
// Called by the daemon every minute, never awaited by the sweep:
//   - macOS only, and only when approvals.popup.enabled is on;
//   - one popup at a time, oldest waiting card first;
//   - each card is shown once. Not now, Cancel or no answer leaves it in
//     the inbox, where the dashboard, the CLI and the digest still have it;
//   - in Focus (system or the widget hold) nothing shows: the card is not
//     marked shown, so it pops on the first minute after Focus ends. Same
//     rule as `agentx notify`: held, never dropped;
//   - cards put off with "later" wait until they come back;
//   - cards older than a day don't pop, so switching the popup on doesn't
//     replay a backlog one dialog at a time;
//   - a check-in (checkin.ts) puts every card waiting at that moment back
//     in line, old or not, and each shows once more.

export interface PopupRunnerSettings extends PopupSettings {
  enabled: boolean
}

export const POPUP_MAX_AGE_MS = 24 * 3_600_000

export type PopupOutcome = "off" | "busy" | "none" | "held" | "shown"

export interface PopupRunnerDeps {
  ctx: InboxContext
  settings: PopupRunnerSettings
  log: (msg: string) => void
  focus?: () => FocusState
  show?: (card: DecisionCard, settings: PopupSettings, opts: { from?: string }) => Promise<PopupAnswer>
  /** An agent's display name, for the card. */
  agentName?: (agentId: string) => string | undefined
  platform?: NodeJS.Platform
}

// Shared by every caller in the process: a config reload must not open a
// second dialog over the first.
let showing = false

/** The next card to show, or null. */
export function nextCardToPop(ctx: InboxContext): DecisionCard | null {
  const now = ctx.now ?? Date.now()
  const { popped = {}, snoozed, passAt } = readInboxState(ctx.root)
  const pass = passAt ? Date.parse(passAt) : NaN
  for (const card of listCards(ctx.root, "pending")) {
    const key = `card:${card.id}`
    if (popped[key]) continue
    const until = snoozed[key]
    if (until && Date.parse(until) > now) continue
    if (Date.parse(card.expires) <= now) continue
    const created = Date.parse(card.created_at)
    if (now - created > POPUP_MAX_AGE_MS && !(created <= pass)) continue
    return card
  }
  return null
}

export async function popNext(deps: PopupRunnerDeps): Promise<PopupOutcome> {
  const { ctx, settings, log } = deps
  if (!settings.enabled || (deps.platform ?? process.platform) !== "darwin") return "off"
  if (showing) return "busy"
  const card = nextCardToPop(ctx)
  if (!card) return "none"
  const focus = (deps.focus ?? readFocus)()
  if (focus.active) return "held"

  showing = true
  const key = `card:${card.id}`
  try {
    // Marked first: a dialog that crashes must not come back every minute.
    const waiting = listCards(ctx.root, "pending").map((c) => `card:${c.id}`)
    recordPopped(ctx.root, key, waiting, ctx.now)
    log(`[approvals] popup: showing ${key} from ${card.raised_by}`)
    const answer = await (deps.show ?? showPopup)(card, settings, { from: deps.agentName?.(card.raised_by) })
    if (answer.action === "dismiss") {
      log(`[approvals] popup: ${key} left waiting (${focusLabel(focus)} when shown)`)
      return "shown"
    }
    // Answered somewhere else while the dialog was up: the first answer stands.
    if (readCard(ctx.root, card.id)?.status !== "pending") {
      log(`[approvals] popup: ${key} was answered elsewhere; popup answer ignored`)
      return "shown"
    }
    const r = await decide(ctx, key, answer.action, {
      by: "operator (popup)",
      ...(answer.action === "yes" ? { choice: answer.choice, text: answer.text } : {}),
    })
    log(r.ok ? `[approvals] popup: ${r.message}` : `[approvals] popup: ${key} not recorded: ${r.error}`)
    return "shown"
  } catch (e: any) {
    log(`[approvals] popup failed for ${key}: ${e?.message ?? e}`)
    return "shown"
  } finally {
    showing = false
  }
}
