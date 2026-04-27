import type { IncomingMessage } from "../types"

// --- Inbound envelope ---
//
// Canonical shape every routing stage operates on. We keep IncomingMessage
// as the adapter contract for now (every channel adapter still emits it) —
// `fromIncoming()` lifts it to an envelope the pipeline can reason about
// without per-channel branching.
//
// The shape intentionally has slots for things that need to be observable
// at routing time: who the sender is (and whether they're a bot or another
// agent), what conversation scope this is, and which canonical reasoning
// the pipeline used to land at a decision.

export type ConversationScope =
  | { type: "dm"; chatId: string }
  | { type: "group"; chatId: string; name?: string }
  | { type: "project"; project: string; entityType?: string; entityIid?: string }
  | { type: "repo"; repo: string; issueOrPr?: number }

export interface InboundEnvelope {
  /** Stable id for dedup + observability. Per-adapter format. */
  id: string
  channel: string
  accountId: string
  sender: {
    id: string
    name?: string
    username?: string
    /** True when the sender is a bot account (Telegram from.is_bot, etc.). */
    isBot: boolean
    /** True when the sender is one of OUR agentx-managed bots — set by the
     *  Telegram adapter from a known-handles roster, populated by the
     *  router on dispatch. Phase 2 stage `self-reply-guard` short-circuits
     *  on this. */
    isAgent?: boolean
    /** Canonical agentId of the sender when isAgent. */
    agentId?: string
  }
  conversation: ConversationScope
  content: {
    text: string
    /** Reply-to text, if the platform supports threaded replies. */
    replyTo?: string
  }
  /** Event-type extracted from inbound headers / body for webhook-shaped
   *  channels. Examples: `"issues.opened"`, `"pull_request.synchronize"`,
   *  `"note.MergeRequest"`. Null for chat platforms. */
  eventType?: string
  /** The original IncomingMessage — adapters still hold platform-specific
   *  state (mediaPath, replyToMessageId, …) that downstream code consumes.
   *  We don't try to relift everything into the envelope right now. */
  raw: IncomingMessage
}

/** Lift an `IncomingMessage` to an `InboundEnvelope`. Pure mapping; no
 *  policy decisions belong here. */
export function fromIncoming(msg: IncomingMessage): InboundEnvelope {
  const conversation: ConversationScope = msg.group
    ? { type: "group", chatId: msg.group.id, name: msg.group.name }
    : msg.channel === "gitlab" || msg.channel === "github"
      ? msg.channel === "gitlab"
        ? { type: "project", project: msg.sender.id }
        : { type: "repo", repo: msg.sender.id }
      : { type: "dm", chatId: msg.sender.id }
  return {
    id: msg.id,
    channel: msg.channel,
    accountId: msg.accountId,
    sender: {
      id: msg.sender.id,
      name: msg.sender.name,
      username: msg.sender.username,
      isBot: msg.sender.isBot === true,
    },
    conversation,
    content: {
      text: msg.text,
      replyTo: msg.replyToText,
    },
    raw: msg,
  }
}
