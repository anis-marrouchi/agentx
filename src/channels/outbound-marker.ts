// --- Outbound markers — single source of truth for self-reply detection ---
//
// Every message agentx sends out on a channel that re-delivers via webhook
// (GitLab notes, GitHub comments, Slack/Discord webhooks) MUST carry a
// marker that identifies it as ours. Without it, the same content can come
// straight back through the inbound pipeline as if a human posted it,
// causing reply loops.
//
// History:
//   - 2026-04-20 GitHub coder-agent loop incident — fixed per-channel with
//     an HTML comment marker. GitLab grew the same hack independently.
//     Both adapters now drop comments containing `<!-- agentx:` early in
//     their inbound paths.
//   - 2026-04-27 — consolidating into one helper. The marker format stays
//     the same (`<!-- agentx:<agentId> -->`); the change is that adapters
//     stop hand-rolling the regex.
//
// Chat platforms (Telegram, WhatsApp, Slack, Discord) handle self-detection
// differently: Telegram's `getUpdates` doesn't replay a bot's own messages,
// WhatsApp Baileys exposes `key.fromMe`, Slack/Discord events carry
// `bot_id`/`webhook_id`. Those signals are surfaced on the InboundEnvelope
// (Phase 2) under `sender.isAgent`. The HTML-marker helpers here are for
// channels whose only signal IS the message body.

const MARKER_RE = /<!--\s*agentx:([^\s-][^\s>]*?)\s*-->/

/**
 * The parts of a body that are the author's own words: fenced code blocks,
 * inline code and quoted (`>`) lines removed. A marker only counts there.
 * Someone quote-replying an agent's comment, or showing the marker in a
 * code sample, has not signed their comment as that agent (#282).
 */
export function ownText(body: string): string {
  return body
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((line) => !/^[ \t]*>/.test(line))
    .join("\n")
}

/** Append the marker to an outbound HTML / Markdown body. Idempotent —
 *  if the body already carries its own marker, do not append again. A
 *  marker that only appears quoted or in code does not count, so a reply
 *  that quotes another agent is still signed. */
export function markBody(body: string, agentId: string): string {
  if (detectAgentxMarker(body)) return body
  return `${body}\n\n<!-- agentx:${agentId} -->`
}

/** Detect a marker in an inbound body, outside code and quotes. Returns
 *  the agentId that signed it (so logging can say "self-reply from
 *  coder-agent dropped") or null. */
export function detectAgentxMarker(body: string | undefined | null): string | null {
  if (!body) return null
  const m = ownText(body).match(MARKER_RE)
  return m ? m[1] : null
}

/** The signature markBody writes when the sender did not name an agent. */
export const UNKNOWN_AGENT = "unknown"

/** The signing agent when a comment is `handler`'s own reply echoed back
 *  by the webhook, else null. Without a resolved handler every signed
 *  comment counts as an echo, as before. An unattributed ("unknown")
 *  signature is an echo only from an account AgentX posts with; the
 *  adapter checks that, see isUnattributedEcho. */
export function ownEchoOf(body: string, handler: string | undefined): string | null {
  const source = detectAgentxMarker(body)
  if (!source) return null
  return !handler || source === handler ? source : null
}

// --- Agent comments posted under a person's account ---
//
// On a forge where agents have no account of their own, an agent's comment
// is posted with the owner's token and arrives as the owner's comment. Every
// adapter post carries the hidden marker, so the inbound message can say it
// was the agent (sender `agent:<id>`): otherwise the #277 human-vs-agent
// check reads an agent's review as the owner starting work (#282).
//
// Anyone can type the marker, though. It is trusted only when the posting
// account is one AgentX itself posts with (the adapter knows those: the
// owners of its tokens, the App bot, the configured forge usernames), and
// only outside quotes and code. The visible "(via AgentX)" header is never
// enough on its own. Any other account stays the person it is.

/** The attribution line the GitHub adapter puts on PAT-mode posts. */
export function agentHeader(agentId: string): string {
  return `> 🤖 **${agentId}** (via AgentX)\n\n`
}

/** The agent that wrote `body`, or null for a person's comment. Only for a
 *  body posted by an account AgentX posts with (`trusted`); an
 *  unattributed marker names no agent. */
export function agentAuthorOf(body: string | undefined | null, trusted: boolean): string | null {
  if (!trusted || !body) return null
  const marked = detectAgentxMarker(body)
  return marked && marked !== UNKNOWN_AGENT ? marked : null
}

/** An unattributed post of our own: signed "unknown" by an account AgentX
 *  posts with. Dropped as an echo; from anyone else it is a person's. */
export function isUnattributedEcho(body: string | undefined | null, trusted: boolean): boolean {
  return trusted && detectAgentxMarker(body) === UNKNOWN_AGENT
}

/** The inbound sender for a forge comment: the posting account for a
 *  person, `agent:<id>` for an agent's own post. Channel code downstream
 *  (the initiator check, bot policy, memory and wiki capture) reads the
 *  `agent:` prefix, so this is the one place a forge post becomes an agent. */
export function forgeSender(
  body: string | undefined | null,
  person: { id: string; name: string; username?: string },
  trusted: boolean,
): { id: string; name: string; username?: string; isBot?: boolean } {
  const agent = agentAuthorOf(body, trusted)
  if (!agent) return person
  return { id: person.id, name: `agent:${agent}`, isBot: true }
}

/** How a comment's author is named in the text the agent reads. */
export function forgeAuthorLabel(body: string | undefined | null, account: string, trusted: boolean): string {
  const agent = agentAuthorOf(body, trusted)
  return agent ? `${agent} (an AgentX agent, posted with ${account}'s account)` : account
}

/** A forge body as the agent reads it. Another account's signature is
 *  removed: it names no agent, and left in place the pipeline's self-reply
 *  guard would drop the comment as an agent's echo (#287). */
export function forgeBody<T extends string | undefined | null>(body: T, trusted: boolean): T {
  return trusted || !body ? body : stripAgentxMarkers(body) as T
}

/** Every configured forge username of `agentId`, or of all agents. The
 *  loop guard's "own bot identity" and the adapters' trusted posting
 *  accounts both come from here. */
export function mappedForgeUsernames(
  mappings: ReadonlyArray<{ agentId: string; gitlabUsernames?: string[]; githubUsernames?: string[] }> | undefined,
  field: "gitlabUsernames" | "githubUsernames",
  agentId?: string,
): string[] {
  return (mappings ?? []).filter((m) => !agentId || m.agentId === agentId).flatMap((m) => m[field] ?? [])
}

/** Strip every marker from a body — used when surfacing the body to the
 *  agent so it doesn't see its own bookkeeping. */
export function stripAgentxMarkers(body: string): string {
  return body.replace(/\n*<!--\s*agentx:[^>]*?\s*-->/g, "")
}

/** Convenience for the Phase 2 self-reply-guard pipeline stage. */
export function isAgentxOutbound(body: string | undefined | null): boolean {
  return detectAgentxMarker(body) !== null
}
