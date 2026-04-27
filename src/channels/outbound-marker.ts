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

/** Strip every marker from a body — used when surfacing the body to the
 *  agent so it doesn't see its own bookkeeping. */
export function stripAgentxMarkers(body: string): string {
  return body.replace(/\n*<!--\s*agentx:[^>]*?\s*-->/g, "")
}

/** Convenience for the Phase 2 self-reply-guard pipeline stage. */
export function isAgentxOutbound(body: string | undefined | null): boolean {
  return detectAgentxMarker(body) !== null
}
