// --- Where a run came from, and how to re-enter it after a restart ---
//
// Stored as JSON on the run's journal row (task_traces.resume_origin). The
// code that started a run knows how to deliver its answer, so it records
// its own kind and registers a resumer for it (coordinator.ts):
//
//   router  — a chat message (Telegram, WhatsApp, GitLab, GitHub…). Resumed
//             through the router, so the answer lands in the original chat.
//   mesh    — a chat message another node received and forwarded here
//             (e.g. a GitLab webhook on the server, run on the Mac). Re-run
//             here; the answer goes back through that node's adapter.
//   direct  — anything else (voice, agent-to-agent, webhooks, API). Re-run
//             with the same message and context; nothing delivers its answer,
//             so it is only resumed for channels the operator opts in.

export interface RouterOrigin {
  kind: "router"
  /** Channel adapter name. */
  adapter: string
  /** The incoming message, as the router's inflight log stores it. */
  message: Record<string, unknown>
}

export interface DirectOrigin {
  kind: "direct"
  context?: Record<string, unknown>
  model?: string
  autonomy?: string
}

export interface MeshOrigin {
  kind: "mesh"
  /** Node that received the message and forwarded it; absent from older
   *  senders, in which case any healthy peer hosting the channel is used. */
  node?: string
  channel: string
  chatId: string
  /** Posts as this agent on the forwarding node, like a live reply. */
  agentId?: string
  /** The incoming message id, so the answer threads like a live reply. */
  replyTo?: string
  accountId?: string
  context?: Record<string, unknown>
}

export type RunOrigin = RouterOrigin | MeshOrigin | DirectOrigin

/** Marks a turn the resume step itself starts on a calling agent (a notice
 *  or a re-run's answer). Such a turn is never "delivered" again. */
export const RESUME_DELIVERY_FLAG = "resumeDelivery"

/** The agent that asked for a direct agent-to-agent run, when the run's
 *  context names one (`sender: "agent:<id>"`), or null. The answer of such
 *  a run can be delivered: as a new turn on that agent. */
export function callerAgentOf(origin: RunOrigin | null): string | null {
  if (!origin || origin.kind !== "direct" || !origin.context) return null
  if (origin.context[RESUME_DELIVERY_FLAG]) return null
  const channel = String(origin.context.channel ?? "").toLowerCase().split("@")[0]
  if (channel !== "a2a") return null
  const sender = String(origin.context.sender ?? "")
  const m = sender.match(/^agent:([^\s]+)$/)
  return m ? m[1] : null
}

/** Bigger than this is not stored: the run is reported instead of resumed. */
export const MAX_ORIGIN_BYTES = 32_000

export function serializeOrigin(origin: RunOrigin | undefined): string | null {
  if (!origin) return null
  try {
    const json = JSON.stringify(origin)
    return json.length <= MAX_ORIGIN_BYTES ? json : null
  } catch {
    return null
  }
}

export function parseOrigin(json: string | null | undefined): RunOrigin | null {
  if (!json) return null
  try {
    const o = JSON.parse(json)
    if (o?.kind === "router" && typeof o.adapter === "string" && o.message && typeof o.message === "object") return o
    if (o?.kind === "mesh" && typeof o.channel === "string" && typeof o.chatId === "string") return o
    if (o?.kind === "direct") return o
  } catch { /* corrupt → not resumable */ }
  return null
}
