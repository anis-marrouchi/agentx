import { createCard, isValidCardId, listCards, readCard, type CardSettings, type DecisionCard, type ReplyTarget } from "@/approvals/cards"
import type { SourceConsentOrigin } from "@/approvals/origin"
import type { ConsentCheck } from "./registry"
import { popupYesFor, type PopupYes } from "./popup-yes"
import type { PER_REQUEST_SOURCE_IDS } from "../context"

// --- The person's yes for a per-request source (#1892 phase 7, design 2.3) ---
//
// Anis, Q3 (2026-11-18): open apps and browser tabs are off by default,
// read only per request, and only after the person says yes, with an
// expiry.
//
// The yes is a decision card (approvals/cards.ts), the machinery the
// owner already answers in the popup, the Wall and the digest. There is
// no second consent store: the card is the record, and this file only
// reads it.
//
//   agent asks (agentx_sources ask)  → one card, origin "source-consent",
//                                      popup-only: a yes counts only in the
//                                      popup on this machine, where the
//                                      person whose apps and tabs these are
//                                      sits. An agent, a chat reply, a
//                                      mesh peer or the CLI can say no,
//                                      never yes.
//   person says yes in the popup     → the agent is told (approvals sweep),
//                                      and may read those sources with the
//                                      card id as the request, for
//                                      `minutes` from the yes.
//   no, no answer, expired, any doubt → nothing is read (fail closed).

export const SOURCE_LABELS: Record<(typeof PER_REQUEST_SOURCE_IDS)[number], string> = {
  "open-apps": "your open apps (names only)",
  "browser-tabs": "your browser tabs (titles and sites)",
  news: "headlines from your news feeds",
}

export function sourceLabel(id: string): string {
  return (SOURCE_LABELS as Record<string, string>)[id] ?? `the "${id}" signal`
}

export interface ConsentSettings {
  askMinutes: number
  defaultMinutes: number
  maxMinutes: number
  /** Reads one yes allows. */
  maxReads?: number
  /** After a no or no answer, the agent may not ask again for this long. 0: no wait. */
  reaskMinutes?: number
}

/** Hard ceiling, whatever the settings say: a yes never outlives a day. */
const MAX_MINUTES = 24 * 60
const WHY_MAX = 120

/** The agent's words, as the person reads them on the card: one line, no
 *  quote marks of its own, no question mark (one card asks one thing),
 *  cut to fit `max`. */
export function quotedWhy(why: unknown, max = WHY_MAX): string {
  const line = typeof why === "string" ? why.replace(/\s+/g, " ").replace(/["“”«»?]/g, "").trim() : ""
  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line
}

/** The card's question holds at most this many characters (screen gate). */
const ASK_MAX = 300

function listOf(ids: string[]): string {
  const labels = ids.map(sourceLabel)
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/** How long the yes lasts: what the agent asked, else the default, never
 *  over the owner's maximum. */
export function consentMinutes(asked: unknown, s: ConsentSettings): number {
  const max = Math.max(1, Math.min(MAX_MINUTES, s.maxMinutes))
  const n = typeof asked === "number" && Number.isFinite(asked) ? Math.floor(asked) : s.defaultMinutes
  return Math.max(1, Math.min(max, n))
}

/** Why this agent may not ask now (click fatigue), or null. One card
 *  waiting at a time; after a no or no answer, a pause. */
function askBlocked(root: string, agentId: string, s: ConsentSettings, now: number): string | null {
  const mine = listCards(root).filter((c) => c.origin?.kind === "source-consent" && c.raised_by === agentId && !c.node)
  const waiting = mine.find((c) => c.status === "pending")
  if (waiting) return `a card of yours is still waiting for the person's answer (${waiting.id}): wait for it`
  const pause = Math.max(0, s.reaskMinutes ?? 0) * 60_000
  if (!pause) return null
  const refused = mine.find((c) => (c.status === "expired" || (c.status === "decided" && c.verdict !== "yes")) && now - Date.parse(c.decided_at ?? "") < pause)
  return refused ? `the person said no, or did not answer, less than ${s.reaskMinutes} minutes ago: do not ask again before that, and only if they ask you to` : null
}

/** Raise the consent card. Never reads a source. */
export function askSourceConsent(
  root: string,
  input: { agentId: string; sources: string[]; why: unknown; minutes?: unknown; reply?: ReplyTarget; chat?: string; taskId?: string },
  opts: { settings: ConsentSettings; cardSettings?: CardSettings; now?: number },
): { ok: true; card: DecisionCard; minutes: number } | { ok: false; error: string; status?: number } {
  const now = opts.now ?? Date.now()
  const sources = [...new Set(input.sources)].sort()
  if (!sources.length) return { ok: false, error: "name at least one source" }
  if (!quotedWhy(input.why)) return { ok: false, error: "why is required: say in a few words what you need it for" }
  const blocked = askBlocked(root, input.agentId, opts.settings, now)
  if (blocked) return { ok: false, error: blocked, status: 409 }
  const minutes = consentMinutes(input.minutes, opts.settings)
  const origin: SourceConsentOrigin = {
    kind: "source-consent", agentId: input.agentId, sources, minutes,
    ...(input.chat ? { chat: input.chat } : {}), ...(input.taskId ? { taskId: input.taskId } : {}),
  }
  const what = listOf(sources)
  // Where it was asked, in the daemon's words, and where the answer goes.
  let where = ""
  if (input.chat) {
    const at = input.chat.indexOf(":")
    const channel = (at > 0 ? input.chat.slice(0, at) : input.chat).replace(/[^a-z0-9-]/gi, "").slice(0, 20) || "a"
    const chat = (at > 0 ? input.chat.slice(at + 1) : "").replace(/\s+/g, " ").replace(/["?]/g, "").slice(0, 60)
    where = ` Asked in ${channel} chat${chat ? ` ${chat}` : ""}; the answer may be posted there.`
  }
  const head = `Let ${input.agentId} read ${what} for one request, for ${minutes} minutes from your yes? What it reads goes to its model.${where} Its reason: "`
  const room = ASK_MAX - head.length - 2
  if (room < 12) return { ok: false, error: "too many sources for one card: ask for fewer" }
  const why = quotedWhy(input.why, Math.min(WHY_MAX, room))
  const r = createCard(root, {
    title: `${input.agentId} asks to read ${what}`.slice(0, 120),
    ask: `${head}${why}".`,
    recommend: "Yes only if you want this read now. A yes counts only in this popup and ends by itself. No, or no answer, and nothing is read.",
    if_silent: "discard",
    expires: new Date(now + Math.max(1, opts.settings.askMinutes) * 60_000).toISOString(),
    raised_by: input.agentId,
    ...(input.reply ? { reply: input.reply } : {}),
  }, { now, ...(opts.cardSettings ? { settings: opts.cardSettings } : {}), origin, popupOnly: true })
  if (!r.ok) return r
  return { ok: true, card: r.card, minutes }
}

export type ConsentState =
  | { granted: true; until: number }
  | { granted: false; why: string }

export const NO_POPUP_YES = "no yes was clicked in the popup for this request since the daemon started"

/** What a card says for this agent and source now, for the turn that
 *  reads (its task and chat). Every doubt is a no.
 *
 *  The card file is checked, but it never grants on its own: the yes the
 *  daemon's popup runner kept in memory (popup-yes.ts) must exist, and its
 *  values (agent, sources, minutes, task, when) are the ones used. */
export function consentState(
  card: DecisionCard | null, sourceId: string, agentId: string | undefined, now: number,
  turn: { chat?: string; taskId?: string } = {},
  extra: { yes?: PopupYes | null; reads?: number; maxReads?: number } = {},
): ConsentState {
  if (!card) return { granted: false, why: "no such request" }
  const o = card.origin
  if (o?.kind !== "source-consent") return { granted: false, why: "not a request to read a source" }
  if (card.node) return { granted: false, why: "answered on another machine" }
  if (!card.popup_only) return { granted: false, why: "not a popup-only card" }
  const yes = extra.yes !== undefined ? extra.yes : popupYesFor(card.id)
  const asker = yes?.agentId ?? o.agentId
  if (!agentId || asker !== agentId || o.agentId !== agentId || card.raised_by !== agentId) return { granted: false, why: "asked by another agent" }
  const sources = yes?.sources ?? o.sources
  if (!Array.isArray(sources) || !sources.includes(sourceId)) return { granted: false, why: "this source was not asked for" }
  // Per request: only the turn that asked, and the turn that tells the
  // agent the answer (chat "approvals:<card>"). Not other turns in its chat.
  const askingTask = yes ? yes.taskId : o.taskId
  const sameTask = !!askingTask && turn.taskId === askingTask
  const answerTurn = turn.chat === `approvals:${card.id}`
  if (!sameTask && !answerTurn) return { granted: false, why: "asked from another turn" }
  if (card.status === "pending") return { granted: false, why: "waiting for the person's answer" }
  if (card.status !== "decided" || card.verdict !== "yes") return { granted: false, why: "the person did not say yes" }
  if (card.decided_from !== "popup") return { granted: false, why: "the yes did not come from the popup" }
  if (!yes) return { granted: false, why: NO_POPUP_YES }
  const minutes = Number.isFinite(yes.minutes) ? Math.min(MAX_MINUTES, yes.minutes) : 0
  if (minutes <= 0) return { granted: false, why: "the yes has no time" }
  // A click that came after the ask had run out does not count.
  if (!Number.isFinite(yes.expires) || yes.clickedAt > yes.expires) return { granted: false, why: "the yes came after the ask had run out" }
  const until = yes.clickedAt + minutes * 60_000
  if (now >= until) return { granted: false, why: `the yes ended at ${new Date(until).toISOString()}` }
  const max = extra.maxReads
  if (max !== undefined && (extra.reads ?? 0) >= max) return { granted: false, why: `the yes was used for ${max} reads already` }
  return { granted: true, until }
}

/** The registry's consent callback: reads the card the request names and
 *  the popup's yes for it, and counts the reads already made. */
export function cardConsent(root: string, opts: { maxReads?: () => number; readsSoFar?: (requestId: string) => number } = {}): ConsentCheck {
  return (sourceId, scope, now) => {
    const id = scope.requestId ?? ""
    if (!isValidCardId(id)) return { why: "no such request" }
    const state = consentState(readCard(root, id), sourceId, scope.agentId, now, { chat: scope.chat, taskId: scope.taskId }, readCap(id, opts))
    return state.granted ? true : { why: state.why }
  }
}

/** The read count and its cap, for consentState. */
export function readCap(id: string, opts: { maxReads?: () => number; readsSoFar?: (requestId: string) => number }): { reads?: number; maxReads?: number } {
  if (!opts.maxReads) return {}
  return { maxReads: opts.maxReads(), reads: opts.readsSoFar?.(id) ?? 0 }
}
