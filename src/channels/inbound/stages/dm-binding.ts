import type { Stage, StageContext, StageDecision } from "../pipeline"
import type { InboundEnvelope } from "../envelope"

// Stage 4 — DM binding.
//
// In a non-group conversation, the agent is determined by the bot account
// the message arrived on (Telegram), or by the channel's default agent
// (WhatsApp). No mention parsing in DMs — every message is implicitly
// addressed to the bound agent.

export const dmBinding: Stage = {
  name: "dm-binding",
  run(env: InboundEnvelope, ctx: StageContext): StageDecision {
    if (env.conversation.type !== "dm") return { kind: "pass" }
    if (env.channel === "telegram") {
      const account = ctx.config.channels.telegram.accounts[env.accountId]
      if (account?.agentBinding) {
        return { kind: "match", agentId: account.agentBinding }
      }
      return { kind: "drop", reason: `telegram dm: no agentBinding for account "${env.accountId}"` }
    }
    if (env.channel === "whatsapp") {
      const a = ctx.config.channels.whatsapp.defaultAgent
      if (a) return { kind: "match", agentId: a }
      return { kind: "drop", reason: "whatsapp dm: no defaultAgent configured" }
    }
    return { kind: "pass" }
  },
}
