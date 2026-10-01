import type { RequestRecord, RequestStore } from "./store"
import type { RequestTracker } from "./tracker"

// --- The daemon's /requests endpoints (#356) ---
//
// Reachable by agents (the agentx_request tool posts here), gated like
// /approvals: loopback, or a mesh token.
//   GET  /requests        open requests, oldest first
//   GET  /requests/:id    one request and what is linked to it
//   POST /requests        an agent's own statement about its request:
//                         accept, wait (on the owner), done, decline
// Dropping a request is the owner's alone: `agentx requests drop`, or the
// dashboard.

export const LIST_LIMIT = 100

export const OWNER_ONLY = "Only the owner drops a request: `agentx requests drop <id>`, or the Approvals page in the dashboard."

export interface RequestsApiDeps {
  store: RequestStore
  tracker: RequestTracker
  enabled: boolean
  hasAgent: (agentId: string) => boolean
  now?: number
}

export interface ApiReply {
  status: number
  body: unknown
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function handleRequestsApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  deps: RequestsApiDeps,
): ApiReply {
  const m = method.toUpperCase()
  const { store } = deps

  if (path === "/requests" && m === "GET") {
    const items = store.listOpen()
    return { status: 200, body: { enabled: deps.enabled, count: items.length, items: items.slice(0, LIST_LIMIT), truncated: items.length > LIST_LIMIT } }
  }

  const one = path.match(/^\/requests\/([^/]+)$/)
  if (one && m === "GET") {
    const request = store.get(decodeURIComponent(one[1]))
    if (!request || request.state === "candidate") return { status: 404, body: { error: `no request "${decodeURIComponent(one[1])}"` } }
    return { status: 200, body: { request, links: store.links(request.id) } }
  }

  if (path === "/requests" && m === "POST") {
    const input = body ?? {}
    const action = str(input.action).toLowerCase()
    if (action === "drop") return { status: 403, body: { error: OWNER_ONLY } }
    if (!["accept", "wait", "done", "decline"].includes(action)) {
      return { status: 400, body: { error: `unknown action "${action}": use accept, wait, done or decline` } }
    }
    if (!deps.enabled) return { status: 409, body: { error: "Requests are turned off on this node (requests.enabled)." } }
    const agentId = str(input.agentId)
    if (!agentId || !deps.hasAgent(agentId)) return { status: 400, body: { error: "agentId must be an agent on this node" } }

    const id = str(input.id)
    const channel = str(input.channel)
    const chatId = str(input.chatId)
    let request: RequestRecord | null = null
    if (id) request = store.get(id)
    else if (channel && chatId) {
      const live = deps.tracker.liveRequestId(agentId, channel, chatId)
      request = (live ? store.get(live) : null) ?? store.latestInChat(agentId, channel, chatId)
    }
    if (!request) {
      return { status: 404, body: { error: id ? `no request "${id}"` : "No request is recorded for this chat. Only the owner's own messages are recorded." } }
    }
    if (request.agentId !== agentId) return { status: 403, body: { error: `request "${request.id}" belongs to another agent` } }
    if (["done", "declined", "dropped"].includes(request.state)) {
      return { status: 409, body: { error: `request "${request.id}" is already closed (${request.state})` } }
    }

    const now = deps.now ?? Date.now()
    try {
      if (action === "accept") store.progress(request.id, now)
      else if (action === "wait") {
        const question = str(input.question)
        if (!question) return { status: 400, body: { error: "wait needs `question`: what you are asking the owner" } }
        store.waitOnOwner(request.id, question, now)
      } else if (action === "done") store.close(request.id, "done", str(input.evidence), now)
      else store.close(request.id, "declined", str(input.reason), now)
    } catch (e: any) {
      return { status: 400, body: { error: e?.message ?? String(e) } }
    }
    return { status: 200, body: { request: store.get(request.id) } }
  }

  if (m !== "GET" && m !== "HEAD") return { status: 405, body: { error: "Method not allowed" } }
  return { status: 404, body: { error: "Not found" } }
}
