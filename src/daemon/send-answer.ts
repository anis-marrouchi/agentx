// --- The answer POST /send gives its caller (#984) ---
//
// A channel that did not deliver must never read as success. Adapters throw
// when a write fails; one that returns no message ID has not confirmed
// anything either, so that is answered as a failure too, not `ok: true`.

export type PostingIdentity = "agent" | "peer" | "global"

export interface SendAnswer {
  status: number
  body: Record<string, unknown>
}

export function sendAnswer(
  messageId: string | void | null | undefined,
  opts: { channel: string; agentId?: string; identity?: PostingIdentity },
): SendAnswer {
  if (!messageId) {
    return {
      status: 502,
      body: { ok: false, messageId: null, error: `The ${opts.channel} channel returned no message ID, so the message was not confirmed as sent.` },
    }
  }
  const body: Record<string, unknown> = { ok: true, messageId }
  // Delivered, but under the shared bot user rather than the agent's own:
  // say so, so a missing per-agent token does not go unnoticed.
  if (opts.identity === "global" && opts.agentId) {
    body.identity = "global"
    body.warning = `Posted with the shared global ${opts.channel} token: agent "${opts.agentId}" has no token of its own, so the post shows the shared bot as its author.`
  }
  return { status: 200, body }
}

/** The line agentx_send shows the agent for a /send answer. */
export function sendResultText(
  ok: boolean,
  data: { messageId?: unknown; error?: unknown; warning?: unknown; accepted?: unknown; taskId?: unknown; agent?: unknown; status?: unknown; note?: unknown },
  statusText = "",
  /** The a2a chat the agent sent on, to say when it went as a new hand-off. */
  chatId?: string,
): string {
  // An a2a send is handed to the other agent (202 + a dlg- task id), never
  // posted with a message ID. That is a receipt, not an error (#2050).
  if (ok && data.accepted === true && data.status === "notice") {
    return `Kept as a notice for ${typeof data.agent === "string" && data.agent ? data.agent : "the agent"}'s next run. Do not send it again.`
  }
  if (ok && data.accepted === true && typeof data.taskId === "string" && data.taskId) {
    return a2aReceiptText({ taskId: data.taskId, agent: str(data.agent), note: str(data.note), delivered: data.status === "delivered" }, chatId)
  }
  if (!ok || !data.messageId) return `Error: ${data.error || statusText || "the message was not confirmed as sent"}`
  return `Message sent. ID: ${data.messageId}${data.warning ? `\nWarning: ${data.warning}` : ""}`
}

/** The dlg- id at the end of an a2a hand-off chat id, if any. */
function handOffIdOf(chatId: string | undefined): string | undefined {
  const m = chatId ? /^a2a:[^:]+:[^:]+:(dlg-[^:]+)$/.exec(chatId) : null
  return m?.[1]
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/** The line agentx_send shows for an a2a send the daemon accepted (#2050):
 *  the daemon's own note, and, when the agent sent on a hand-off chat and
 *  the message went as another hand-off, that it is not on that chat. */
export function a2aReceiptText(r: { taskId: string; agent: string; note: string; delivered: boolean }, chatId?: string): string {
  const to = r.agent || "the other agent"
  const lines = [`Message accepted for ${to} (task ${r.taskId}).${r.note ? ` ${r.note}` : " Do not send it again."}`]
  const old = handOffIdOf(chatId)
  if (old && old !== r.taskId && !r.delivered) {
    lines.push(`Note: it is not posted on chat ${chatId}: hand-off ${old} is no longer open, so the message went as hand-off ${r.taskId}.`)
  }
  return lines.join("\n")
}
