import type { Stage } from "../pipeline"
import { selfReplyGuard } from "./self-reply-guard"
import { handover } from "./handover"
import { adapterResolved } from "./adapter-resolved"
import { dmBinding } from "./dm-binding"
import { botPolicy } from "./bot-policy"
import { mention } from "./mention"
import { fallbackBinding } from "./fallback-binding"

// Default ordered pipeline. Order is the contract.
//
//   1. self-reply-guard — drop our own outbound coming back via webhook.
//   2. handover         — operator runtime override.
//   3. adapter-resolved — GitLab agentMappings, WhatsApp routes.
//   4. dm-binding       — non-group: bound account agent / defaultAgent.
//   5. bot-policy       — set atMentionsOnly when sender is a bot.
//   6. mention          — registry.findByMention with the flag.
//   7. fallback-binding — chat platforms in groups: bound agent.
//
// Phase 3 will insert a `workflow-trigger` stage between adapter-resolved
// and dm-binding for webhook-shaped channels.
export const defaultPipeline: Stage[] = [
  selfReplyGuard,
  handover,
  adapterResolved,
  dmBinding,
  botPolicy,
  mention,
  fallbackBinding,
]

export {
  selfReplyGuard,
  handover,
  adapterResolved,
  dmBinding,
  botPolicy,
  mention,
  fallbackBinding,
}
