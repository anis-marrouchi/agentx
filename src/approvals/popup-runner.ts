import { readFocus, focusLabel, type FocusState } from "@/notify/focus"
import { summarize } from "@/requests/card-view"
import type { RequestRecord } from "@/requests/store"
import { CARD_LIMITS, listCards, readCard, type DecisionCard } from "./cards"
import { decide, requestStoreFor, type InboxContext } from "./inbox"
import { showPopup, type PopupAnswer, type PopupSettings } from "./popup"
import { readInboxState, recordPopped, recordWanted } from "./state"

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
//     in line, old or not, and each shows once more;
//   - a card the operator asks for (Show on Mac on the Approvals page)
//     goes first and shows again, whatever its age. `agentx approvals
//     popup <key>` shows one from the terminal without waiting for this;
//   - with no card waiting, a request that came to need attention in the
//     last day shows as a card, once (#459): Hand it back, Drop or Not
//     now. The banner that announces it is gone in seconds; the card
//     stays up like any other.
//
// Every popup ends with one log line saying how: the answer, "not now",
// "timed out" or "closed".

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
  show?: (card: DecisionCard, settings: PopupSettings, opts: { from?: string; speak?: (line: string) => Promise<unknown> }) => Promise<PopupAnswer>
  /** Says a card's line through the host's speaking queue, which waits
   *  while the microphone is open. Without it the popup runs `say`. */
  speak?: (line: string) => Promise<unknown>
  /** An agent's display name, for the card. */
  agentName?: (agentId: string) => string | undefined
  platform?: NodeJS.Platform
}

// Shared by every caller in the process: a config reload must not open a
// second dialog over the first.
let showing = false
// Request cards all say the same sentence: one that follows another
// within this long shows without it (#493).
const REQUEST_SAY_GAP_MS = 10 * 60_000
let requestSaidAt = -Infinity

/** The next card to show, or null. */
export function nextCardToPop(ctx: InboxContext): DecisionCard | null {
  const now = ctx.now ?? Date.now()
  const { popped = {}, snoozed, passAt, wanted = [] } = readInboxState(ctx.root)
  const pass = passAt ? Date.parse(passAt) : NaN
  const cards = listCards(ctx.root, "pending").filter((c) => Date.parse(c.expires) > now)
  const asked = cards.find((c) => wanted.includes(`card:${c.id}`))
  if (asked) return asked
  for (const card of cards) {
    const key = `card:${card.id}`
    if (popped[key]) continue
    const until = snoozed[key]
    if (until && Date.parse(until) > now) continue
    const created = Date.parse(card.created_at)
    if (now - created > POPUP_MAX_AGE_MS && !(created <= pass)) continue
    return card
  }
  return null
}

/** Requests that need attention, oldest first. */
function requestsWaiting(ctx: InboxContext): RequestRecord[] {
  try { return requestStoreFor(ctx)?.listByState("needs_attention") ?? [] } catch { return [] }
}

/** The next request to show: it came to need attention in the last day,
 *  was not shown yet, and was not put off. */
export function nextRequestToPop(ctx: InboxContext): RequestRecord | null {
  const now = ctx.now ?? Date.now()
  const { popped = {}, snoozed } = readInboxState(ctx.root)
  return requestsWaiting(ctx).find((r) => {
    const key = `request:${r.id}`
    const until = snoozed[key]
    return !popped[key] && !(until && Date.parse(until) > now) && now - r.updatedAt <= POPUP_MAX_AGE_MS
  }) ?? null
}

/** A request as the card the window shows. Not stored: the answer goes to
 *  the request through the inbox (yes hands it back, no drops it). */
export function requestAsCard(r: RequestRecord, now: number): DecisionCard {
  return {
    id: r.id,
    title: summarize(r.text, CARD_LIMITS.title),
    context: r.attentionReason ?? "It is not finished and nothing is retrying it.",
    ask: `Hand it back to ${r.agentId}, or drop it?`,
    say: "A request you made is not finished.",
    recommend: "",
    if_silent: "keep",
    expires: new Date(now + POPUP_MAX_AGE_MS).toISOString(),
    raised_by: r.agentId,
    created_at: new Date(r.createdAt).toISOString(),
    status: "pending",
    origin: { kind: "request", id: r.id },
  }
}

export async function popNext(deps: PopupRunnerDeps): Promise<PopupOutcome> {
  const { ctx, settings, log } = deps
  if (!settings.enabled || (deps.platform ?? process.platform) !== "darwin") return "off"
  if (showing) return "busy"
  const request = nextCardToPop(ctx) ? null : nextRequestToPop(ctx)
  const card = request ? requestAsCard(request, ctx.now ?? Date.now()) : nextCardToPop(ctx)
  if (!card) return "none"
  const focus = (deps.focus ?? readFocus)()
  if (focus.active) return "held"

  showing = true
  const key = `${request ? "request" : "card"}:${card.id}`
  try {
    // Marked first: a dialog that crashes must not come back every minute.
    const waiting = [...listCards(ctx.root, "pending").map((c) => `card:${c.id}`), ...requestsWaiting(ctx).map((r) => `request:${r.id}`)]
    recordPopped(ctx.root, key, waiting, ctx.now)
    log(`[approvals] popup: showing ${key} from ${card.raised_by}`)
    const now = ctx.now ?? Date.now()
    const repeat = !!request && now - requestSaidAt < REQUEST_SAY_GAP_MS
    if (request && settings.speak) requestSaidAt = now
    // An agent on another node has no name here: say which node it is on.
    const from = deps.agentName?.(card.raised_by) ?? (card.node ? `${card.raised_by} on ${card.node}` : undefined)
    const answer = await (deps.show ?? showPopup)(card, repeat ? { ...settings, speak: false } : settings,
      { from, speak: deps.speak })
    if (answer.action === "dismiss") {
      log(`[approvals] popup: ${key} left waiting: ${answer.why ?? "no answer"} (${focusLabel(focus)} when shown)`)
      return "shown"
    }
    // Answered somewhere else while the dialog was up: the first answer stands.
    const stillWaiting = request ? requestStoreFor(ctx)?.get(request.id)?.state === "needs_attention" : readCard(ctx.root, card.id)?.status === "pending"
    if (!stillWaiting) {
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

/** Put a waiting card back in line for the popup. The daemon shows it on its next minute. */
export function popAgain(ctx: InboxContext, key: string, enabled: boolean): { ok: true; message: string } | { ok: false; error: string } {
  if (!enabled) return { ok: false, error: "the Mac popup is off; turn it on with `agentx approvals settings --popup on`" }
  const card = key.startsWith("card:") ? readCard(ctx.root, key.slice(5)) : null
  if (!card) return { ok: false, error: `no card "${key}"; the popup shows decision cards only` }
  if (card.status !== "pending") return { ok: false, error: `${key} is already ${card.status}` }
  recordWanted(ctx.root, key)
  return { ok: true, message: `${key} will show on the Mac within a minute` }
}
