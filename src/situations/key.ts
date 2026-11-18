import { normalizeChat } from "@/situations/normalize-chat"

// --- One key per conversation (#1892) ---
//
// The record store, the inbound gate and the send path all build the key
// with this one function, so an inbound "thanks" and the reply that left
// by another path land on the same record.
//
// - account: empty or missing → "default" (as the WhatsApp adapter sets it
//   on inbound, while channel.reply often passes none).
// - Telegram groups (chat ids start with "-"): no account. One group
//   message reaches every bot account in the group, and the reply leaves
//   from the replying agent's account, so a per-account key would split
//   one talk in two (S15). Telegram private chats keep the account: the
//   chat id is the person's own id, the same for every bot they write to,
//   and each bot is a separate talk.
// - chat: normalizeChat with the trigger source form ("whatsapp-message"),
//   the same call the dispatcher makes.

/** Chat channels the gate and the record cover in phase 1. a2a is not one
 *  of them (design B2d): its turns do not pass the router. */
export const SITUATION_CHANNELS: ReadonlySet<string> = new Set(["telegram", "whatsapp", "discord", "slack"])

/** The key of an inbound message's chat, or undefined for a channel the
 *  record does not cover. The chat is the group, else the sender, as the
 *  gate reads it. */
export function situationKeyOf(msg: { channel: string; accountId?: string; group?: { id: string }; sender: { id: string } }): string | undefined {
  return SITUATION_CHANNELS.has(msg.channel) ? situationKey(msg.channel, msg.accountId, msg.group?.id || msg.sender.id) : undefined
}

export function situationKey(channel: string, account: string | undefined, chat: string): string {
  const acct = channel === "telegram" && String(chat).startsWith("-") ? "*" : (account || "default")
  return `${channel}|${acct}|${normalizeChat(`${channel}-message`, chat)}`
}
