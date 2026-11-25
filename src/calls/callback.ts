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
// Requests closed on another node are not in this store and never call
// back from here.

import type { CallsConfig } from "@/daemon/config"
import { OWNER_BY, type RequestRecord, type RequestStore } from "@/requests/store"
import type { CallService } from "./service"
import type { CallbackRef, CallbackState } from "./store"

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
      const ref: CallbackRef = { id: r.id, state }
      void calls.callback({ agentId: r.askedAgent ?? r.agentId, ref, headline: headlineOf(r) })
        .then((o) => { if (o.placed !== "skipped") deps.log(`[calls] call-back for ${r.id} (${state}): ${o.placed}`) })
        .catch((e: any) => deps.log(`[calls] call-back for ${r.id} failed: ${e?.message ?? e}`))
    } catch (e: any) {
      deps.log(`[calls] call-back for ${r.id} failed: ${e?.message ?? e}`)
    }
  }
  const offDone = store.onDone((r) => fire(r, "done"))
  const offOwner = store.onNeedsOwner((r, state) => fire(r, state))
  return () => { offDone(); offOwner() }
}
