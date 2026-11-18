import { normalizeChat } from "@/situations/normalize-chat"

// --- One key per conversation (#1892) ---
//
// The record store, the inbound gate and the send path all build the key
// with this one function, so an inbound "thanks" and the reply that left
// by another path land on the same record.
//
// - account: empty or missing → "default" (as the WhatsApp adapter sets it
//   on inbound, while channel.reply often passes none).
// - Telegram: no account at all. One group message reaches every bot
//   account in the group, and the reply leaves from the replying agent's
//   account, so a per-account key would split one talk in two (S15).
// - chat: normalizeChat with the trigger source form ("whatsapp-message"),
//   the same call the dispatcher makes.

/** Chat channels the gate and the record cover in phase 1. a2a is not one
 *  of them (design B2d): its turns do not pass the router. */
export const SITUATION_CHANNELS: ReadonlySet<string> = new Set(["telegram", "whatsapp", "discord", "slack"])

export function situationKey(channel: string, account: string | undefined, chat: string): string {
  const acct = channel === "telegram" ? "*" : (account || "default")
  return `${channel}|${acct}|${normalizeChat(`${channel}-message`, chat)}`
}
