import type { Stage, StageContext, StageDecision } from "../pipeline"
import type { InboundEnvelope } from "../envelope"

// Stage 2 — operator-initiated handover override.
//
// Survives daemon restart (handover-store persists to disk). Wins over
// every config-driven route below this stage. Used when an operator
// redirects "all messages on chat X" from agent A to agent B for a
// session, without editing agentx.json.

/** The agent an active handover sends this chat to, if any. */
export function handoverTarget(env: InboundEnvelope, ctx: StageContext): string | undefined {
  const chatId =
    env.conversation.type === "group" || env.conversation.type === "dm"
      ? env.conversation.chatId
      : env.sender.id
  return ctx.handoverStore.get(env.channel, chatId, env.accountId)?.toAgent
}

export const handover: Stage = {
  name: "handover",
  run(env: InboundEnvelope, ctx: StageContext): StageDecision {
    const target = handoverTarget(env, ctx)
    if (target) {
      return { kind: "match", agentId: target }
    }
    return { kind: "pass" }
  },
}
