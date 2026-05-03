import type { Stage, StageContext, StageDecision } from "../pipeline"
import type { InboundEnvelope } from "../envelope"

// Stage 6 — mention matching.
//
// Single canonical entry point for "did the user @mention an agent?".
// Calls `registry.findByMention(text, { atMentionsOnly })`. The
// `atMentionsOnly` flag is set by the bot-policy stage upstream and
// changes the matching semantics:
//   - false: bare-word matches like "nadia" count
//   - true:  only explicit `@`-prefixed handles count (bot-origin)
//
// Telegram has an extra rule: groups under `policy.group=mention-required`
// must have an `@`-mention even from human senders. We honor it here so
// the rule lives in one place rather than being scattered.

export const mention: Stage = {
  name: "mention",
  run(env: InboundEnvelope, ctx: StageContext): StageDecision {
    const requireAtMentionInGroup =
      env.channel === "telegram" &&
      env.conversation.type === "group" &&
      ctx.config.channels.telegram.policy.group === "mention-required"

    const flag = ctx.atMentionsOnly || requireAtMentionInGroup
    const agentId = ctx.registry.findByMention(env.content.text, {
      atMentionsOnly: flag,
    })
    if (agentId) return { kind: "match", agentId }
    if (requireAtMentionInGroup) {
      return { kind: "drop", reason: "telegram group mention-required: no @mention found" }
    }
    if (ctx.atMentionsOnly) {
      return { kind: "drop", reason: "bot-origin: no @mention of a local agent" }
    }
    return { kind: "pass" }
  },
}
