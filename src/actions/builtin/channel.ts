import { z } from "zod"
import { getMessageRouter } from "@/channels/router-instance"
import type { BuiltinAction } from "./types"

// --- channel.reply / channel.label / channel.assign ---
//
// Canonical channel-output surface for agents. Replaces the raw-curl
// playbook in agent skills with a typed action that:
//
//   - posts through the live MessageRouter -> adapter chain (so the
//     adapter's marker + identity resolution + ledger recording all
//     fire automatically — no per-agent token in workspace files)
//   - dedupes within a 60s window keyed on (channel, chatId, body)
//     via router.sendOutbound's idempotency layer — so the same
//     dedupe protects every caller (HTTP /send, channel.reply,
//     cron notifications, cross-channel routing)
//   - returns the posted message id, or null when dedupe suppressed
//     the post (the messageId from the prior post)
//
// Architecturally this is the cleanest decoupling we can offer right
// now: agent reasoning produces structured actions; the actions touch
// the world through agentx; agentx owns cross-cutting concerns
// (dedupe, marker, audit, rate limiting, identity) at the router
// layer where every send-out converges.
//
// `auto_reply_legacy` (separate flag, on the channel config) preserves
// today's "router auto-posts response.content" until every agent skill
// has migrated to channel.reply. Once migration is complete the flag
// gets removed and the agent's response.content stops being auto-
// relayed entirely.

// --- channel.reply ---

const channelReplyInput = z.object({
  /** Channel name (gitlab | github | telegram | whatsapp | discord | slack). */
  channel: z.string().min(1),
  /** Stable chat id — for gitlab: `org/repo:issue:123` or `org/repo:merge_request:123`.
   *  For telegram/whatsapp: the chat or sender id. The format is the same one
   *  the agent received in its task context as `chatId`. */
  chatId: z.string().min(1),
  /** Message body. Markdown for gitlab/github/discord; plain for sms/whatsapp. */
  text: z.string().min(1),
  /** Posting identity. When omitted, the channel adapter resolves identity
   *  from agentMappings — for gitlab that's the per-agent gitlab token.
   *  For telegram/discord it picks an account that's in the chat. */
  agentId: z.string().optional(),
  /** Multi-account adapters (telegram) need this when the chat is reachable
   *  from more than one bot. Falls back to the adapter's chatAccountMap. */
  accountId: z.string().optional(),
  /** Optional reply-to message id for threaded channels. */
  replyTo: z.string().optional(),
  /** Custom dedupe key. When provided, replaces the default body-hash
   *  scheme — useful for "I want to overwrite my last status update"
   *  patterns where the body changes but the intent is the same post. */
  idempotencyKey: z.string().optional(),
})
type ChannelReplyInput = z.infer<typeof channelReplyInput>

const channelReplyOutput = z.object({
  /** Adapter-returned id, or null when the adapter couldn't surface one
   *  (or the call was suppressed by the router's 60s dedupe window — in
   *  which case this returns the prior post's id when known). */
  messageId: z.string().nullable(),
})
type ChannelReplyOutput = z.infer<typeof channelReplyOutput>

export const channelReply: BuiltinAction<ChannelReplyInput, ChannelReplyOutput> = {
  name: "channel.reply",
  description: "Post a reply to a channel (gitlab/github comment, telegram/whatsapp message, …) through the canonical adapter — auto-marker, auto-dedupe within 60s, identity resolved from agentMappings.",
  inputSchema: channelReplyInput,
  outputSchema: channelReplyOutput,
  timeoutMs: 30_000,
  handler: async (input) => {
    const router = getMessageRouter()
    if (!router) {
      throw new Error("message router not wired (daemon not started or running in a non-daemon process)")
    }
    // Empty-string idempotencyKey tells the router to use a body-hash
    // dedupe key. Caller can override with their own key for "overwrite
    // last status" patterns where the body changes but intent matches.
    const idempotencyKey = input.idempotencyKey ?? ""
    const messageId = await router.sendOutbound(
      {
        channel: input.channel,
        chatId: input.chatId,
        text: input.text,
        agentId: input.agentId,
        accountId: input.accountId,
        replyTo: input.replyTo,
      },
      { idempotencyKey, dedupeWindowMs: 60_000 },
    )
    return { messageId: typeof messageId === "string" ? messageId : null }
  },
}

// --- channel.label ---
//
// Add and/or remove labels on the inbound entity. GitLab + GitHub both
// expose this; other channels error politely. Like channel.reply this
// goes through the live adapter chain (per-agent token, marker, ledger).

const channelLabelInput = z.object({
  /** Currently supports "gitlab"; "github" wired when the github adapter
   *  surfaces a typed label call (today the adapter-level setLabels is
   *  gitlab-only). Pass the channel that owns the entity. */
  channel: z.literal("gitlab"),
  /** GitLab project path — `org/repo`. */
  project: z.string().min(1),
  /** "issue" or "merge_request". */
  kind: z.enum(["issue", "merge_request"]),
  /** Numeric iid as a string. */
  iid: z.string().min(1),
  add: z.array(z.string()).default([]),
  remove: z.array(z.string()).default([]),
  /** Posting identity — defaults to channel-adapter resolution. */
  agentId: z.string().optional(),
})
type ChannelLabelInput = z.infer<typeof channelLabelInput>

const channelLabelOutput = z.object({
  labels: z.array(z.string()),
})
type ChannelLabelOutput = z.infer<typeof channelLabelOutput>

export const channelLabel: BuiltinAction<ChannelLabelInput, ChannelLabelOutput> = {
  name: "channel.label",
  description: "Add and/or remove labels on a GitLab issue/MR through the adapter (per-agent token, ledger, no raw curl).",
  inputSchema: channelLabelInput,
  outputSchema: channelLabelOutput,
  timeoutMs: 30_000,
  handler: async (input) => {
    const router = getMessageRouter()
    if (!router) throw new Error("message router not wired")
    const adapter = (router as any).getChannel?.(input.channel) as
      | { setLabels?: (args: { project: string; kind?: "issue" | "merge_request"; iid: string; add?: string[]; remove?: string[]; agentId?: string }) => Promise<string[] | null> }
      | undefined
    if (!adapter?.setLabels) {
      throw new Error(`channel "${input.channel}" does not expose setLabels`)
    }
    const labels = await adapter.setLabels({
      project: input.project,
      kind: input.kind,
      iid: input.iid,
      add: input.add,
      remove: input.remove,
      agentId: input.agentId,
    })
    return { labels: Array.isArray(labels) ? labels : [] }
  },
}
