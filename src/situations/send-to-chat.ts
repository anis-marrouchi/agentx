import type { ChannelAdapter, OutgoingMessage } from "@/channels/types"
import type { SituationStore } from "@/situations/store"
import { SITUATION_CHANNELS, situationKey } from "./key"

// --- One send function for messages to a chat (#1892) ---
//
// Every message an agent or a workflow sends into a conversation leaves
// through `sendToChat`: the router's replies and notices (adapterSend),
// sendOutbound (channel.reply, /send, /channel/send from a peer), workflow
// action.send and person.message (deliver). After a send that worked, and
// only when the caller says the text is a reply in the conversation itself
// (`countsAsReply: true`), the chat's situation record is told: in the
// `ending` phase that send is the one goodbye, and the talk is ended.
//
// The rule for the flag: true only when the text is an agent's or a
// workflow's message in the conversation. Notices, errors, reminders,
// digests and alerts are false, even when they go to the same chat. The
// agent id decides nothing. The full list of call sites and their value
// is checked by test/situation-send-list.test.ts.

export interface SituationTag { id: string; endGeneration: number }

export interface SendToChatOpts {
  countsAsReply: boolean
  /** A send that belongs to one end of a talk (a close step): refused
   *  when the talk was reopened since (S7). */
  situation?: SituationTag
}

/** A situation tag read from a JSON body (a peer's /channel/send), or
 *  undefined when the body carries none or a malformed one. */
export function situationTagOf(v: unknown): SituationTag | undefined {
  const t = v as { id?: unknown; endGeneration?: unknown } | null | undefined
  return t && typeof t.id === "string" && typeof t.endGeneration === "number" ? { id: t.id, endGeneration: t.endGeneration } : undefined
}

let store: SituationStore | null = null

/** Attach the situation record (daemon start). Null detaches it. */
export function setSendToChatStore(s: SituationStore | null): void {
  store = s
}

/** Why a tagged send must not go out, or null when it may. */
export function staleSituationSend(msg: Pick<OutgoingMessage, "channel" | "chatId"> & { accountId?: string }, tag: SituationTag | undefined): string | null {
  if (!tag || !store) return null
  const row = store.get(situationKey(msg.channel, msg.accountId, msg.chatId))
  if (!row || row.id !== tag.id) return `situation ${tag.id} is not this chat's current situation; not sent`
  if (row.endGeneration !== tag.endGeneration) return `situation ${tag.id} was reopened (end generation ${row.endGeneration}, send was for ${tag.endGeneration}); not sent`
  return null
}

/** Tell the record a counted reply left for this chat. Never throws. */
export function noteCountedSend(msg: Pick<OutgoingMessage, "channel" | "chatId" | "agentId"> & { accountId?: string }): void {
  if (!store || !SITUATION_CHANNELS.has(msg.channel)) return
  try { store.noteSent(situationKey(msg.channel, msg.accountId, msg.chatId), msg.agentId) } catch { /* the send went out; the mark is best-effort */ }
}

export async function sendToChat(
  adapter: Pick<ChannelAdapter, "name" | "send">,
  msg: OutgoingMessage & { accountId?: string },
  opts: SendToChatOpts,
): Promise<string | void> {
  // Checked right before the adapter call: the only place that can stop
  // a send already past a cancel (S7).
  const stale = staleSituationSend(msg, opts.situation)
  if (stale) throw new Error(stale)
  // The Telegram adapter reads `accountId` off the message to pick the bot.
  const id = await adapter.send(msg)
  if (opts.countsAsReply) noteCountedSend(msg)
  return id
}
