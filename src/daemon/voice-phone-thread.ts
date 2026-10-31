// AgentX Voice's requests in the phone app's conversations (#1455).
//
// A request picked from the open-requests list continues its agent's
// conversation, and that conversation is the phone's: the one the phone
// used last with the agent (app-chat-store.ts). /ask runs the turn under
// the phone's session key (channel "app", chat id "app:<conversation>",
// as app-chat-relay.ts sends it), so the agent resumes the same session,
// and the question and its answer are saved in that conversation, so the
// phone shows them and its Chat strip lights up for an answer not heard.
//
// Only this node's agents: a mesh peer's conversation lives on the node
// that runs it. Without a phone that ever chatted, /ask keeps the voice
// session it always had.

import type { AppChatStore } from "@/daemon/app-chat-store"
import type { UiDirective } from "@/channels/ui-directive"
import type { VoiceRequestStore } from "@/daemon/voice-requests-api"

export interface PhoneThread {
  conversationId: string
  /** The phone's session key for the agent turn. */
  chatId: string
}

export interface ThreadAgent {
  id: string
  name?: string
  color?: string
}

/** The phone conversation request `requestId` runs in, with the question
 *  saved in it: the one it already has, else the newest with the agent on
 *  any phone, else a new one on the phone used last. Null for an unknown
 *  request or when no phone ever chatted. */
export function beginPhoneThread(
  requests: VoiceRequestStore,
  requestId: string,
  agent: ThreadAgent,
  message: string,
  nodeName: string,
  now = Date.now(),
): PhoneThread | null {
  const row = requests.get(requestId)
  if (!row) return null
  const chats = requests.chats
  let conv: { id: string; deviceId: string } | null = null
  if (row.conversationId) {
    const owner = chats.ownerOf(row.conversationId)
    if (owner) conv = { id: row.conversationId, deviceId: owner }
  }
  conv ??= chats.latestWith("local", agent.id)
  if (!conv) {
    const device = chats.latestDevice()
    if (!device) return null
    const made = chats.create(device, {
      node: "local", nodeName, agent: agent.id,
      ...(agent.name ? { agentName: agent.name } : {}), ...(agent.color ? { color: agent.color } : {}),
    }, message, now)
    conv = { id: made.id, deviceId: device }
  }
  requests.link(requestId, conv.id)
  chats.append(conv.deviceId, conv.id, { role: "user", content: message, at: now })
  return { conversationId: conv.id, chatId: `app:${conv.id}` }
}

/** The turn's answer, or why it failed, saved after the question. */
export function finishPhoneThread(
  chats: AppChatStore,
  thread: PhoneThread,
  answer: { content: string; error?: string; ui?: UiDirective },
  now = Date.now(),
): void {
  const owner = chats.ownerOf(thread.conversationId)
  if (!owner) return
  chats.append(owner, thread.conversationId, {
    role: "assistant", content: answer.content, status: answer.error ? "error" : "done", at: now,
    ...(answer.error ? { error: answer.error } : {}), ...(answer.ui ? { ui: answer.ui } : {}),
  })
}
