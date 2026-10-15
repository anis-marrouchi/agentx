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
export function sendResultText(ok: boolean, data: { messageId?: unknown; error?: unknown; warning?: unknown }, statusText = ""): string {
  if (!ok || !data.messageId) return `Error: ${data.error || statusText || "the message was not confirmed as sent"}`
  return `Message sent. ID: ${data.messageId}${data.warning ? `\nWarning: ${data.warning}` : ""}`
}
