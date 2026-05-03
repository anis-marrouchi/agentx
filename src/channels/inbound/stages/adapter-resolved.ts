import type { Stage, StageContext, StageDecision } from "../pipeline"
import type { InboundEnvelope } from "../envelope"

// Stage 3 — channels that resolve the agent inside the adapter.
//
//  - GitLab: `agentMappings` map GitLab usernames to agentIds; the adapter
//    sets `msg.resolvedAgent` before dispatch. We trust it.
//  - WhatsApp: route table (contact/group → agent) is consulted in the
//    adapter and `msg.resolvedAgent` is set when a route hits.
//
// GitLab additionally has a hard rule: if the adapter did NOT pre-resolve
// (no mapping matched the comment author), the message is dropped here.
// Letting it fall through to mention-matching would try to resolve via
// Telegram-style handles, which never match GitLab usernames.

export const adapterResolved: Stage = {
  name: "adapter-resolved",
  run(env: InboundEnvelope, _ctx: StageContext): StageDecision {
    if (env.channel === "gitlab") {
      const resolved = env.raw.resolvedAgent
      if (resolved) return { kind: "match", agentId: resolved }
      return { kind: "drop", reason: "gitlab username has no agent mapping" }
    }
    if (env.raw.resolvedAgent) {
      return { kind: "match", agentId: env.raw.resolvedAgent }
    }
    return { kind: "pass" }
  },
}
