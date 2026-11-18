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
  /** The send answers a message just written in this chat (the router's
   *  reply path). Unset: false. Read only by the told record (#1936). */
  reply?: boolean
}

/** What the told record hears about each send that went out (#1936). */
export interface SentToChat {
  channel: string
  chatId: string
  agentId?: string
  text: string
  reply: boolean
}

let recorder: ((sent: SentToChat) => void) | null = null

/** Attach the told record's hook (daemon start). Null detaches it. It
 *  only writes rows: it cannot stop or change a send. */
export function setSendToChatRecorder(fn: ((sent: SentToChat) => void) | null): void {
  recorder = fn
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
export function noteCountedSend(msg: Pick<OutgoingMessage, "channel" | "chatId" | "agentId"> & { accountId?: string; text?: string }): void {
  if (!store || !SITUATION_CHANNELS.has(msg.channel)) return
  // A question near the end of the reply ("Goodbye! Shall I send the
  // contract?") keeps the talk open.
  const asked = /[?؟]/.test(String(msg.text ?? "").slice(-200))
  try { store.noteSent(situationKey(msg.channel, msg.accountId, msg.chatId), msg.agentId, { asked }) } catch { /* the send went out; the mark is best-effort */ }
}

/** The account the record key uses for this send. A Telegram private chat
 *  is keyed per bot (the person's id is the same for every bot), so a
 *  send with no accountId (channel.reply, a workflow send) takes the bot
 *  the adapter itself will send from: the one it last saw the chat on. */
function keyAccount(adapter: { accountForChat?: (chatId: string) => string | undefined }, msg: { channel: string; chatId: string; accountId?: string }): string | undefined {
  if (msg.accountId || msg.channel !== "telegram" || String(msg.chatId).startsWith("-")) return msg.accountId
  try { return adapter.accountForChat?.(msg.chatId) } catch { return undefined }
}

export async function sendToChat(
  adapter: Pick<ChannelAdapter, "name" | "send"> & { accountForChat?: (chatId: string) => string | undefined },
  msg: OutgoingMessage & { accountId?: string },
  opts: SendToChatOpts,
): Promise<string | void> {
  const keyed = { ...msg, accountId: keyAccount(adapter, msg) }
  // Checked right before the adapter call: the only place that can stop
  // a send already past a cancel (S7).
  const stale = staleSituationSend(keyed, opts.situation)
  if (stale) throw new Error(stale)
  // The Telegram adapter reads `accountId` off the message to pick the bot.
  const id = await adapter.send(msg)
  if (opts.countsAsReply) noteCountedSend(keyed)
  if (recorder) {
    try {
      recorder({ channel: msg.channel, chatId: msg.chatId, agentId: msg.agentId, text: String(msg.text ?? ""), reply: opts.reply === true })
    } catch { /* the send went out; the record is best-effort */ }
  }
  return id
}
