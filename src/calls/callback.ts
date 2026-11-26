// --- The agent calls the owner back (#2265) ---
//
// When a request the owner asked for himself is done, starts waiting on
// him, or needs his attention, and it ran longer than
// calls.callback.afterMinutes (or he said "call me when it's done"), the
// agent that has it calls him: a voice call on the widget and the phone,
// placed by the daemon. It hangs off the request store's own state
// changes (every close path: close, closeVerified, settle; wait; needs
// attention), so there is no poller and no schedule (noqta#609).
//
// When the owner-words check reopens a request that already rang "Done",
// the agent rings once more with a correction, "Not done after all"
// (#2281). Each reopen is a round: the correction and the next done are
// keyed by it, so the real done after a correction rings again.
//
// Requests closed on another node are not in this store and never call
// back from here.

import type { CallsConfig } from "@/daemon/config"
import { OWNER_BY, type RequestRecord, type RequestStore } from "@/requests/store"
import type { CallService } from "./service"
import { callbackRef, type CallbackRef, type CallbackState } from "./store"

/** Where a request counts as the owner's own ask: his voice widget, the
 *  Hub (dashboard), the phone app and its calls (webrtc), and his own
 *  Telegram and WhatsApp. The request store opens a request on those only
 *  for an owner turn (requests/tracker.ts isOwnerTurn), so the channel
 *  says who asked. Agent-to-agent (a2a), schedules, forges and the
 *  daemon's own channels never call back. */
export const OWNER_CHANNELS: ReadonlySet<string> = new Set(["voice", "dashboard", "app", "webrtc", "telegram", "whatsapp"])

/** Senders the daemon uses on the owner's surfaces: not his asks. */
const DAEMON_SENDERS: ReadonlySet<string> = new Set(["camera"])

/** "call me when it's done", "call me back once…", "ring me when…". */
const ASKED_TO_CALL = /\b(call|ring|phone)\s+me(\s+back)?\s+(when|once|as\s+soon\s+as|after)\b/i

const base = (channel: string) => channel.toLowerCase().split("@")[0]

/** Did the owner ask for this himself (#2265 C4)? Not an agent's promise,
 *  not a standing order, and asked on one of his own channels. */
export function askedByOwner(r: Pick<RequestRecord, "channel" | "sender" | "promise" | "standing">): boolean {
  if (r.promise || r.standing) return false
  if (DAEMON_SENDERS.has((r.sender ?? "").toLowerCase())) return false
  return OWNER_CHANNELS.has(base(r.channel))
}

/** Should this change of state call the owner back? */
export function wantsCallback(r: RequestRecord, state: CallbackState, cfg: CallsConfig["callback"], now: number): boolean {
  if (!cfg.enabled || !askedByOwner(r)) return false
  // The done it corrects already passed the time rule (#2281).
  if (state === "reopened") return true
  // He closed it himself: he knows.
  if (state === "done" && r.closedBy === OWNER_BY) return false
  if (ASKED_TO_CALL.test(r.text)) return true
  return now - r.createdAt >= cfg.afterMinutes * 60_000
}

/** A request's headline for the ring: the agent's or the model's, else
 *  the owner's words, cut short. */
export function headlineOf(r: Pick<RequestRecord, "headline" | "text">): string {
  const words = (r.headline || r.text).replace(/\s+/g, " ").trim()
  return words.length > 120 ? `${words.slice(0, 119)}…` : words
}

/** One line on a request, for the opener the agent reads when he answers. */
export function callbackBrief(r: RequestRecord, state: CallbackState): string {
  const title = `"${headlineOf(r)}" (${r.id})`
  if (state === "done") return `${title} is done. Proof: ${r.evidence ?? "none given"}`
  if (state === "waiting_owner") return `${title} waits on them: ${r.question ?? r.need ?? "an answer"}`
  if (state === "reopened") return `${title} is not done after all, though they were called and told it was: ${r.attentionReason ?? "the close did not do what they asked"}`
  return `${title} is stuck: ${r.attentionReason ?? "no reason given"}`
}

export interface CallbackDeps {
  calls: () => CallService | null
  config: () => CallsConfig
  now?: () => number
  log: (msg: string) => void
}

/** Hooks the call-back onto the request store. Never throws into the
 *  path that changed the request. Returns the function that removes it. */
export function attachCallbacks(store: RequestStore, deps: CallbackDeps): () => void {
  const fire = (r: RequestRecord, state: CallbackState) => {
    try {
      const calls = deps.calls()
      if (!calls) return
      if (!wantsCallback(r, state, deps.config().callback, deps.now?.() ?? Date.now())) return
      // Round n is the n-th owner-words reopen; a correction follows the
      // done of the round before it (#2281).
      const round = state === "done" || state === "reopened" ? r.ownerReopens ?? 0 : 0
      const ref: CallbackRef = callbackRef(r.id, state, round)
      const after = state === "reopened" ? callbackRef(r.id, "done", round - 1) : undefined
      void calls.callback({ agentId: r.askedAgent ?? r.agentId, ref, headline: headlineOf(r), after })
        .then((o) => { if (o.placed !== "skipped") deps.log(`[calls] call-back for ${r.id} (${state}): ${o.placed}`) })
        .catch((e: any) => deps.log(`[calls] call-back for ${r.id} failed: ${e?.message ?? e}`))
    } catch (e: any) {
      deps.log(`[calls] call-back for ${r.id} failed: ${e?.message ?? e}`)
    }
  }
  const offDone = store.onDone((r) => fire(r, "done"))
  const offSettled = store.onSettled((r) => fire(r, "done"))
  const offOwner = store.onNeedsOwner((r, state) => fire(r, state))
  const offReopened = store.onReopened((r) => fire(r, "reopened"))
  return () => { offDone(); offSettled(); offOwner(); offReopened() }
}
