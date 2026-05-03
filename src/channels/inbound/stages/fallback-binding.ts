import type { Stage, StageContext, StageDecision } from "../pipeline"
import type { InboundEnvelope } from "../envelope"

// Stage 7 — fallback to channel binding.
//
// Reached only when nothing earlier matched. For chat platforms in groups,
// fall back to the bound agent: Telegram routes to the account's
// `agentBinding`, WhatsApp routes to `defaultAgent`. This is the historic
// behavior — without it, group messages without an explicit @-mention
// would silently drop on policy=`mention-any` channels.

export const fallbackBinding: Stage = {
  name: "fallback-binding",
  run(env: InboundEnvelope, ctx: StageContext): StageDecision {
    if (env.channel === "telegram") {
      const account = ctx.config.channels.telegram.accounts[env.accountId]
      if (account?.agentBinding) {
        return { kind: "match", agentId: account.agentBinding }
      }
      return { kind: "drop", reason: `no telegram agentBinding for account "${env.accountId}"` }
    }
    if (env.channel === "whatsapp") {
      const a = ctx.config.channels.whatsapp.defaultAgent
      if (a) return { kind: "match", agentId: a }
      return { kind: "drop", reason: "no whatsapp defaultAgent" }
    }
    return { kind: "pass" }
  },
}
