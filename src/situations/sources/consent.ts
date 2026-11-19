import { createCard, isValidCardId, readCard, type CardSettings, type DecisionCard, type ReplyTarget } from "@/approvals/cards"
import type { SourceConsentOrigin } from "@/approvals/origin"
import type { ConsentCheck } from "./registry"
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
  "open-apps": "your open apps and the front window's title",
  "browser-tabs": "your browser tabs (titles and addresses)",
  news: "headlines from your news feeds",
}

export function sourceLabel(id: string): string {
  return (SOURCE_LABELS as Record<string, string>)[id] ?? `the "${id}" signal`
}

export interface ConsentSettings {
  askMinutes: number
  defaultMinutes: number
  maxMinutes: number
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

/** Raise the consent card. Never reads a source. */
export function askSourceConsent(
  root: string,
  input: { agentId: string; sources: string[]; why: unknown; minutes?: unknown; reply?: ReplyTarget; chat?: string; taskId?: string },
  opts: { settings: ConsentSettings; cardSettings?: CardSettings; now?: number },
): { ok: true; card: DecisionCard; minutes: number } | { ok: false; error: string } {
  const now = opts.now ?? Date.now()
  const sources = [...new Set(input.sources)].sort()
  if (!sources.length) return { ok: false, error: "name at least one source" }
  if (!quotedWhy(input.why)) return { ok: false, error: "why is required: say in a few words what you need it for" }
  const minutes = consentMinutes(input.minutes, opts.settings)
  const origin: SourceConsentOrigin = {
    kind: "source-consent", agentId: input.agentId, sources, minutes,
    ...(input.chat ? { chat: input.chat } : {}), ...(input.taskId ? { taskId: input.taskId } : {}),
  }
  const what = listOf(sources)
  // Where it was asked, in the daemon's words: the channel only.
  const where = input.chat ? ` Asked in a ${input.chat.split(":")[0].replace(/[^a-z0-9-]/gi, "").slice(0, 20) || "chat"} chat.` : ""
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

/** What a card says for this agent and source now, for the turn that
 *  reads (its chat and task). Every doubt is a no. */
export function consentState(card: DecisionCard | null, sourceId: string, agentId: string | undefined, now: number, turn: { chat?: string; taskId?: string } = {}): ConsentState {
  if (!card) return { granted: false, why: "no such request" }
  const o = card.origin
  if (o?.kind !== "source-consent") return { granted: false, why: "not a request to read a source" }
  if (card.node) return { granted: false, why: "answered on another machine" }
  if (!card.popup_only) return { granted: false, why: "not a popup-only card" }
  if (!agentId || o.agentId !== agentId || card.raised_by !== agentId) return { granted: false, why: "asked by another agent" }
  if (!Array.isArray(o.sources) || !o.sources.includes(sourceId)) return { granted: false, why: "this source was not asked for" }
  // Per request: the yes holds in the turn or chat it was asked from, and
  // in the turn that tells the agent the answer (chat "approvals:<card>").
  const sameTask = !!o.taskId && turn.taskId === o.taskId
  const sameChat = !!o.chat && turn.chat === o.chat
  const answerTurn = turn.chat === `approvals:${card.id}`
  if (!sameTask && !sameChat && !answerTurn) return { granted: false, why: "asked from another chat or turn" }
  if (card.status === "pending") return { granted: false, why: "waiting for the person's answer" }
  if (card.status !== "decided" || card.verdict !== "yes") return { granted: false, why: "the person did not say yes" }
  if (card.decided_from !== "popup") return { granted: false, why: "the yes did not come from the popup" }
  const at = Date.parse(card.decided_at ?? "")
  const minutes = typeof o.minutes === "number" && Number.isFinite(o.minutes) ? Math.min(MAX_MINUTES, o.minutes) : 0
  if (!Number.isFinite(at) || minutes <= 0) return { granted: false, why: "the yes has no time" }
  // A click that came after the ask had run out does not count.
  const asked = Date.parse(card.expires)
  if (!Number.isFinite(asked) || at > asked) return { granted: false, why: "the yes came after the ask had run out" }
  const until = at + minutes * 60_000
  if (now >= until) return { granted: false, why: `the yes ended at ${new Date(until).toISOString()}` }
  return { granted: true, until }
}

/** The registry's consent callback: reads the card the request names. */
export function cardConsent(root: string): ConsentCheck {
  return (sourceId, scope, now) => {
    const id = scope.requestId ?? ""
    if (!isValidCardId(id)) return false
    return consentState(readCard(root, id), sourceId, scope.agentId, now, { chat: scope.chat, taskId: scope.taskId }).granted
  }
}
