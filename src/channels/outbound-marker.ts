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

/** Append the marker to an outbound HTML / Markdown body. Idempotent —
 *  if the marker is already present (e.g. agent quoted itself), do not
 *  append again. */
export function markBody(body: string, agentId: string): string {
  if (MARKER_RE.test(body)) return body
  return `${body}\n\n<!-- agentx:${agentId} -->`
}

/** Detect a marker in an inbound body. Returns the agentId that signed it
 *  (so logging can say "self-reply from coder-agent dropped") or null. */
export function detectAgentxMarker(body: string | undefined | null): string | null {
  if (!body) return null
  const m = body.match(MARKER_RE)
  return m ? m[1] : null
}

/** The signature markBody writes when the sender did not name an agent.
 *  It is still our own post, so it is always an echo. */
export const UNKNOWN_AGENT = "unknown"

/** The signing agent when a comment is `handler`'s own reply echoed back
 *  by the webhook, else null. Without a resolved handler every signed
 *  comment counts as an echo, as before, and so does an unattributed one. */
export function ownEchoOf(body: string, handler: string | undefined): string | null {
  const source = detectAgentxMarker(body)
  if (!source) return null
  return !handler || source === handler || source === UNKNOWN_AGENT ? source : null
}

// --- Agent comments posted under a person's account ---
//
// On a forge where agents have no account of their own, an agent's comment
// is posted with the owner's token and arrives as the owner's comment. The
// GitHub adapter's PAT mode opens every post with this header, and every
// adapter post carries the marker. Either one means an agent wrote it, and
// the inbound message must say so (sender `agent:<id>`): otherwise the #277
// human-vs-agent check reads an agent's review as the owner starting work,
// and anything keyed on the author treats it as the owner speaking (#282).

/** The attribution line the GitHub adapter puts on PAT-mode posts. */
export function agentHeader(agentId: string): string {
  return `> 🤖 **${agentId}** (via AgentX)\n\n`
}

const HEADER_RE = /^\s*(?:>\s*)?🤖\s*\*\*([A-Za-z0-9][\w.-]*)\*\*\s*\(via AgentX\)/

/** The agent that wrote `body`, from its marker or its header, or null
 *  for a person's comment. An unattributed marker names no agent. */
export function agentAuthorOf(body: string | undefined | null): string | null {
  if (!body) return null
  const marked = detectAgentxMarker(body)
  if (marked && marked !== UNKNOWN_AGENT) return marked
  const header = body.match(HEADER_RE)
  return header ? header[1] : null
}

/** The inbound sender for a forge comment: the posting account for a
 *  person, `agent:<id>` for an agent's own post. Channel code downstream
 *  (the initiator check, bot policy, memory and wiki capture) reads the
 *  `agent:` prefix, so this is the one place a forge post becomes an agent. */
export function forgeSender(
  body: string | undefined | null,
  person: { id: string; name: string; username?: string },
): { id: string; name: string; username?: string; isBot?: boolean } {
  const agent = agentAuthorOf(body)
  if (!agent) return person
  return { id: person.id, name: `agent:${agent}`, isBot: true }
}

/** How a comment's author is named in the text the agent reads. */
export function forgeAuthorLabel(body: string | undefined | null, account: string): string {
  const agent = agentAuthorOf(body)
  return agent ? `${agent} (an AgentX agent, posted with ${account}'s account)` : account
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
