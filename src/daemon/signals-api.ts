import type { SignalSender } from "@/agents/signals/policy"
import type { SignalService } from "@/agents/signals/service"
import { summarizeStopped } from "@/agents/signals/store"

// --- HTTP surface for stop and resume signals (#857) ---
//
//   GET  /api/signals/stopped[?state=&agent=&limit=]  bounded summaries
//   GET  /api/signals/stopped/:id                     one record, whole plan
//   POST /api/signals/stop    { taskId } | { agentId, channel, chatId }, reason?, node?
//   POST /api/signals/resume  { id, reason?, node? }
//
// `node` names a mesh peer: the signal is forwarded there with this node's
// peer token, and the peer decides by its own signals.allowPeers. The
// caller is resolved by signalSender(): an agent proves itself with its
// running task (the X-AgentX-Task / -Channel / -Chat headers its MCP
// tools send); a peer's own token is that peer; a signal forwarded with the
// shared mesh token carries `via`; anyone else past the mesh gate is the
// owner (CLI, dashboard), as for /api/tasks/:id/cancel.
//
//   POST /api/signals/drop    { id, node? }   forget a stopped task

export interface SignalsReply {
  status: number
  body: Record<string, unknown>
}

export interface SenderInput {
  /** The caller sent agent proof headers. */
  proofGiven: boolean
  /** The agent and channel of the running turn the proof names, or null. */
  provenTurn: { agentId: string; channel: string } | null
  /** `via` from a body a peer forwarded. */
  via?: { node?: unknown; agentId?: unknown }
  /** The peer whose own token the request carried, when it names one. */
  tokenPeer: string | null
}

/** The channel a wind-down turn runs on. Such a turn may not send signals. */
export const WIND_DOWN_CHANNEL = "signals"

export function signalSender(input: SenderInput): SignalSender | { error: string } {
  // A peer's own token names the peer, with or without `via`: such a caller
  // is never taken for the owner or for one of this node's agents. Only the
  // shared mesh token (or no token) can stand for the owner.
  if (input.tokenPeer) {
    const via = input.via && typeof input.via === "object" ? input.via : undefined
    const agentId = typeof via?.agentId === "string" && via.agentId.trim() ? via.agentId.trim() : undefined
    return agentId ? { kind: "agent", agentId, peer: input.tokenPeer } : { kind: "peer", peer: input.tokenPeer }
  }
  if (input.proofGiven) {
    if (!input.provenTurn) return { error: "the running task named by the caller headers was not found" }
    if (input.provenTurn.channel === WIND_DOWN_CHANNEL) return { error: "a wind-down turn cannot send signals" }
    return { kind: "agent", agentId: input.provenTurn.agentId }
  }
  if (input.via && typeof input.via === "object") {
    // The shared mesh token does not name a peer, so the node the body
    // names stands.
    const peer = typeof input.via.node === "string" ? input.via.node.trim() : ""
    if (!peer) return { error: "a forwarded signal must name its node (via.node)" }
    const agentId = typeof input.via.agentId === "string" && input.via.agentId.trim() ? input.via.agentId.trim() : undefined
    return agentId ? { kind: "agent", agentId, peer } : { kind: "peer", peer }
  }
  return { kind: "owner" }
}

/** The peer whose own token (mesh.peers[].token) `authorization` carries;
 *  null for the shared mesh token, no token, or a token several peers share. */
export function peerOfToken(
  authorization: string | undefined,
  peers: ReadonlyArray<{ name: string; token?: string }>,
  meshToken?: string,
): string | null {
  const token = /^bearer /i.test(authorization ?? "") ? authorization!.slice(7).trim() : ""
  if (!token || (meshToken && token === meshToken)) return null
  const names = [...new Set(peers.filter((p) => p.token === token).map((p) => p.name))]
  return names.length === 1 ? names[0] : null
}

export interface SignalsHttpDeps {
  service: SignalService
  selfNode: string
  sender: SignalSender | { error: string }
  /** Send the request on to a mesh peer; null when no healthy peer has that name. */
  forward(node: string, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<SignalsReply | null>
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)

export function isSignalsPath(path: string): boolean {
  return path === "/api/signals/stop" || path === "/api/signals/resume" || path === "/api/signals/drop" || path === "/api/signals/stopped" ||
    /^\/api\/signals\/stopped\/[^/]+$/.test(path)
}

export async function handleSignalsHttp(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  deps: SignalsHttpDeps,
): Promise<SignalsReply> {
  const node = method === "GET" ? str(query.get("node")) : str(body.node)
  if (node && node.toLowerCase() !== deps.selfNode.toLowerCase()) {
    if ("error" in deps.sender) return { status: 403, body: { error: deps.sender.error } }
    // One hop only: a peer's signal is never sent on again.
    if (deps.sender.kind !== "owner" && deps.sender.kind !== "agent") return { status: 400, body: { error: "a forwarded signal cannot be forwarded again" } }
    if (deps.sender.kind === "agent" && deps.sender.peer) return { status: 400, body: { error: "a forwarded signal cannot be forwarded again" } }
    const via = { node: deps.selfNode, ...(deps.sender.kind === "agent" ? { agentId: deps.sender.agentId } : {}) }
    const qs = new URLSearchParams(query)
    qs.delete("node")
    const target = method === "GET" ? `${path}${qs.toString() ? `?${qs}` : ""}` : path
    const { node: _node, ...rest } = body
    const reply = await deps.forward(node, method === "GET" ? "GET" : "POST", target, method === "GET" ? undefined : { ...rest, via })
    return reply ?? { status: 404, body: { error: `no healthy mesh peer named "${node}"` } }
  }

  if (method === "GET" && path === "/api/signals/stopped") {
    const state = str(query.get("state"))
    const limit = Number(query.get("limit") ?? "") || undefined
    const tasks = deps.service.list({
      state: state === "stopped" || state === "resumed" || state === "winding-down" ? state : undefined,
      agentId: str(query.get("agent")),
      limit,
    })
    return { status: 200, body: { node: deps.selfNode, tasks: tasks.map(summarizeStopped) } }
  }
  const one = method === "GET" && path.match(/^\/api\/signals\/stopped\/([^/]+)$/)
  if (one) {
    const record = deps.service.get(decodeURIComponent(one[1]))
    return record ? { status: 200, body: { node: deps.selfNode, task: record } } : { status: 404, body: { error: "no such stopped task" } }
  }
  if (method !== "POST") return { status: 405, body: { error: "method not allowed" } }
  if ("error" in deps.sender) return { status: 403, body: { error: deps.sender.error } }

  if (path === "/api/signals/stop") {
    const taskId = str(body.taskId)
    const agentId = str(body.agentId)
    const channel = str(body.channel)
    const chatId = str(body.chatId)
    if (!taskId && !(agentId && channel && chatId)) {
      return { status: 400, body: { error: "send { taskId } or { agentId, channel, chatId }" } }
    }
    const r = await deps.service.stop(deps.sender, { taskId, agentId, channel, chatId }, str(body.reason))
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    return {
      status: 202,
      body: {
        ok: true, node: deps.selfNode, id: r.record.id, agentId: r.record.agentId, rootId: r.record.rootId, state: r.record.state,
        message: "Stopped. The agent is writing its resume plan; GET /api/signals/stopped/<id> shows it once saved.",
      },
    }
  }
  if (path === "/api/signals/drop") {
    const id = str(body.id)
    if (!id) return { status: 400, body: { error: "send { id } of a stopped task" } }
    const r = deps.service.drop(deps.sender, id)
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    return { status: 200, body: { ok: true, node: deps.selfNode, id } }
  }
  if (path === "/api/signals/resume") {
    const id = str(body.id)
    if (!id) return { status: 400, body: { error: "send { id } of a stopped task" } }
    const r = await deps.service.resume(deps.sender, id, str(body.reason))
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    return { status: 200, body: { ok: true, node: deps.selfNode, id: r.record.id, agentId: r.record.agentId, rootId: r.record.rootId, state: r.record.state, delivery: r.delivery } }
  }
  return { status: 404, body: { error: "not found" } }
}
