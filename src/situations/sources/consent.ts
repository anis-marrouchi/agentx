import { createCard, isValidCardId, readCard, type CardSettings, type DecisionCard, type ReplyTarget } from "@/approvals/cards"
import type { SourceConsentOrigin } from "@/approvals/origin"
import type { ConsentCheck } from "./registry"

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

export const SOURCE_LABELS: Record<string, string> = {
  "open-apps": "your open apps and the front window's title",
  "browser-tabs": "your browser tabs (titles and addresses)",
  news: "headlines from your news feeds",
}

export function sourceLabel(id: string): string {
  return SOURCE_LABELS[id] ?? `the "${id}" signal`
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
 *  cut to fit. */
export function quotedWhy(why: unknown): string {
  const line = typeof why === "string" ? why.replace(/\s+/g, " ").replace(/["“”«»?]/g, "").trim() : ""
  return line.length > WHY_MAX ? `${line.slice(0, WHY_MAX - 1)}…` : line
}

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
  input: { agentId: string; sources: string[]; why: unknown; minutes?: unknown; reply?: ReplyTarget },
  opts: { settings: ConsentSettings; cardSettings?: CardSettings; now?: number },
): { ok: true; card: DecisionCard; minutes: number } | { ok: false; error: string } {
  const now = opts.now ?? Date.now()
  const sources = [...new Set(input.sources)].sort()
  if (!sources.length) return { ok: false, error: "name at least one source" }
  const why = quotedWhy(input.why)
  if (!why) return { ok: false, error: "why is required: say in a few words what you need it for" }
  const minutes = consentMinutes(input.minutes, opts.settings)
  const origin: SourceConsentOrigin = { kind: "source-consent", agentId: input.agentId, sources, minutes }
  const what = listOf(sources)
  const r = createCard(root, {
    title: `${input.agentId} asks to read ${what}`.slice(0, 120),
    ask: `Let ${input.agentId} read ${what} for one request, for ${minutes} minutes from your yes? What it reads goes to its model. Its reason: "${why}".`,
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

/** What a card says for this agent and source now. Every doubt is a no. */
export function consentState(card: DecisionCard | null, sourceId: string, agentId: string | undefined, now: number): ConsentState {
  if (!card) return { granted: false, why: "no such request" }
  const o = card.origin
  if (o?.kind !== "source-consent") return { granted: false, why: "not a request to read a source" }
  if (card.node) return { granted: false, why: "answered on another machine" }
  if (!card.popup_only) return { granted: false, why: "not a popup-only card" }
  if (!agentId || o.agentId !== agentId || card.raised_by !== agentId) return { granted: false, why: "asked by another agent" }
  if (!Array.isArray(o.sources) || !o.sources.includes(sourceId)) return { granted: false, why: "this source was not asked for" }
  if (card.status === "pending") return { granted: false, why: "waiting for the person's answer" }
  if (card.status !== "decided" || card.verdict !== "yes") return { granted: false, why: "the person did not say yes" }
  if (card.decided_from !== "popup") return { granted: false, why: "the yes did not come from the popup" }
  const at = Date.parse(card.decided_at ?? "")
  const minutes = typeof o.minutes === "number" && Number.isFinite(o.minutes) ? Math.min(MAX_MINUTES, o.minutes) : 0
  if (!Number.isFinite(at) || minutes <= 0) return { granted: false, why: "the yes has no time" }
  const until = at + minutes * 60_000
  if (now >= until) return { granted: false, why: `the yes ended at ${new Date(until).toISOString()}` }
  return { granted: true, until }
}

/** The registry's consent callback: reads the card the request names. */
export function cardConsent(root: string): ConsentCheck {
  return (sourceId, scope, now) => {
    const id = scope.requestId ?? ""
    if (!isValidCardId(id)) return false
    return consentState(readCard(root, id), sourceId, scope.agentId, now).granted
  }
}
