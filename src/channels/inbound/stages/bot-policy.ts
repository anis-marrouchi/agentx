import type { Stage, StageContext, StageDecision } from "../pipeline"
import type { InboundEnvelope } from "../envelope"

// Stage 5 — bot-to-bot policy.
//
// When a bot's reply lands in a group another bot is also in, the second
// bot's polling sees the first bot's prose. Without a guard, mention
// matchers will fire on bare-word handles ("nadia", "devops-mtgl") in
// the prose and trigger spurious cross-bot cascades.
//
// The contract: bot-origin messages match ONLY explicit `@`-prefixed
// handles of a local agent. Bare-word matches are silently ignored.
//
// Today the policy is hardcoded to `strict-mention` for bot-origin
// traffic and the implementation is shared across channels via the
// `atMentionsOnly` flag on the StageContext. (Future Phase: surface as
// `channels.<channel>.botPolicy` in config so individual channels can
// opt to "ignore" bot traffic entirely or "allow" with no narrowing.)

export const botPolicy: Stage = {
  name: "bot-policy",
  run(env: InboundEnvelope, ctx: StageContext): StageDecision {
    if (env.sender.isBot) {
      ctx.atMentionsOnly = true
    }
    return { kind: "pass" }
  },
}
