import type { Stage, StageContext, StageDecision } from "../pipeline"
import type { InboundEnvelope } from "../envelope"
import { detectAgentxMarker } from "../../outbound-marker"

// Stage 1 — self-reply guard.
//
// An agent's outbound message must never re-enter the routing pipeline.
// For HTML-bodied channels (GitLab, GitHub), every outbound carries a
// `<!-- agentx:<agentId> -->` marker; we drop here when we see it on
// inbound.
//
// Chat platforms (Telegram, WhatsApp, Slack, Discord) have native signals
// that surface as `sender.isAgent` on the envelope. For Telegram, that's
// matched against the `from.is_bot` field plus a known-handles roster
// the adapter populates when sending. WhatsApp Baileys sets `key.fromMe`
// on the raw message which the adapter lifts.

export const selfReplyGuard: Stage = {
  name: "self-reply-guard",
  run(env: InboundEnvelope, _ctx: StageContext): StageDecision {
    if (env.sender.isAgent) {
      return { kind: "drop", reason: `self-reply (agent=${env.sender.agentId ?? "?"})` }
    }
    // GitLab / GitHub style HTML marker
    const marker = detectAgentxMarker(env.content.text)
    if (marker) {
      return { kind: "drop", reason: `agentx-marker (agent=${marker})` }
    }
    return { kind: "pass" }
  },
}

