import type { OrderPeer } from "@/agents/signals/orders"
import type { SignalSender } from "@/agents/signals/policy"
import type { SignalService } from "@/agents/signals/service"
import { summarizeStopped } from "@/agents/signals/store"

// --- HTTP surface for stop and resume signals (#857) ---
//
//   GET  /api/signals/stopped[?state=&agent=&limit=]  bounded summaries
//   GET  /api/signals/stopped/:id                     one record, whole plan
//   POST /api/signals/stop    { taskId } | { agentId, channel, chatId }, reason?, node?
//   POST /api/signals/resume  { id, reason?, node? }
//   POST /api/signals/drop    { id, node? }            forget a stopped task (#871)
//   POST /api/signals/stop-all { reason?, mesh?, wait? } stop every task (#1271)
//   POST /api/signals/stop-all/report { orderId, outcomes } a peer's part of
//        a mesh stop-all, after its restart (#1328)
//
// stop-all is the owner's order (or a peer's that signals.allowPeers
// names), never an agent's. With `mesh`, the owner's order also goes to
// every healthy mesh peer, one hop, each deciding by its own allowPeers.
// With `wait`, the answer comes once every plan is saved, here and on the
// peers, and says whether it is safe to restart. A mesh order carries
// this node's order id and name, so after the restart every peer reports
// here and the owner gets one report for every node (orders.ts).
//
// `node` names a mesh peer: the signal is forwarded there with this node's
// peer token, and the peer decides by its own signals.allowPeers. The
// caller is resolved by signalSender(): an agent proves itself with its
// running task (the X-AgentX-Task / -Channel / -Chat headers its MCP
// tools send); a forwarded signal carries `via`; a peer's own token names
// that peer, with or without `via` (#871); anyone else past the mesh gate
// (the shared mesh token, loopback) is the owner (CLI, dashboard), as for
// /api/tasks/:id/cancel.

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
  if (input.proofGiven) {
    if (!input.provenTurn) return { error: "the running task named by the caller headers was not found" }
    if (input.provenTurn.channel === WIND_DOWN_CHANNEL) return { error: "a wind-down turn cannot send signals" }
    return { kind: "agent", agentId: input.provenTurn.agentId }
  }
  if (input.via && typeof input.via === "object") {
    const claimed = typeof input.via.node === "string" ? input.via.node.trim() : ""
    // A peer token names the peer; the shared mesh token does not, so the
    // node the body names stands.
    const peer = input.tokenPeer ?? claimed
    if (!peer) return { error: "a forwarded signal must name its node (via.node)" }
    const agentId = typeof input.via.agentId === "string" && input.via.agentId.trim() ? input.via.agentId.trim() : undefined
    return agentId ? { kind: "agent", agentId, peer } : { kind: "peer", peer }
  }
  // A peer's own token is that peer even when it sends no `via`, so
  // signals.allowPeers holds for it (#871).
  if (input.tokenPeer) return { kind: "peer", peer: input.tokenPeer }
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
  forward(node: string, method: "GET" | "POST", path: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<SignalsReply | null>
  /** Names of the healthy mesh peers, for a stop-all with `mesh`. */
  peers?(): string[]
  /** One report for a mesh stop-all (#1328). Absent: each node reports
   *  on its own. */
  reporter?: {
    begin(orderId: string, peers: OrderPeer[]): void
    join(orderId: string, coordinator: string): void
    receive(peer: string, body: Record<string, unknown>): Promise<{ status: number; error?: string }>
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)

export function isSignalsPath(path: string): boolean {
  return path === "/api/signals/stop" || path === "/api/signals/stop-all" || path === "/api/signals/stop-all/report" || path === "/api/signals/resume" || path === "/api/signals/drop" || path === "/api/signals/stopped" ||
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
    // A waiting stop-all answers once the peer's plans are saved.
    const timeoutMs = path === "/api/signals/stop-all" && body.wait === true ? deps.service.windDownMs() + STOP_ALL_PEER_SLACK_MS : undefined
    const reply = await deps.forward(node, method === "GET" ? "GET" : "POST", target, method === "GET" ? undefined : { ...rest, via }, timeoutMs)
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
  if (path === "/api/signals/stop-all") return stopAllHttp(body, deps)
  if (path === "/api/signals/stop-all/report") {
    // Only a peer that took this node's order reports to it.
    if (deps.sender.kind !== "peer") return { status: 403, body: { error: "only a mesh peer reports its part of a stop-all" } }
    if (!deps.reporter) return { status: 404, body: { error: "no mesh stop-all on this node" } }
    const r = await deps.reporter.receive(deps.sender.peer, body)
    return r.error ? { status: r.status, body: { error: r.error } } : { status: 200, body: { ok: true, node: deps.selfNode } }
  }
  if (path === "/api/signals/resume") {
    const id = str(body.id)
    if (!id) return { status: 400, body: { error: "send { id } of a stopped task" } }
    const r = await deps.service.resume(deps.sender, id, str(body.reason))
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    return { status: 200, body: { ok: true, node: deps.selfNode, id: r.record.id, agentId: r.record.agentId, rootId: r.record.rootId, state: r.record.state, delivery: r.delivery } }
  }
  if (path === "/api/signals/drop") {
    const id = str(body.id)
    if (!id) return { status: 400, body: { error: "send { id } of a stopped task" } }
    const r = deps.service.drop(deps.sender, id)
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    return { status: 200, body: { ok: true, node: deps.selfNode, id: r.record.id, agentId: r.record.agentId, rootId: r.record.rootId, dropped: true } }
  }
  return { status: 404, body: { error: "not found" } }
}

/** Extra time a waiting stop-all gives the peers past this node's own
 *  wind-down time: the run's slot release and the forward itself. */
const STOP_ALL_PEER_SLACK_MS = 90_000

async function stopAllHttp(body: Record<string, unknown>, deps: SignalsHttpDeps): Promise<SignalsReply> {
  const sender = deps.sender as SignalSender
  const wait = body.wait === true
  const reason = str(body.reason)
  // A peer's order names the node to report to after the restart.
  const reportTo = sender.kind === "peer" ? sender.peer : undefined
  const r = await deps.service.stopAll(sender, reason, { orderId: str(body.orderId) })
  if (!r.ok) return { status: r.status, body: { error: r.error } }
  if (reportTo && deps.reporter && body.reportTo === true) deps.reporter.join(r.orderId, reportTo)
  // Only the owner's own order fans out; a peer's never goes on.
  const fanOut = body.mesh === true && sender.kind === "owner"
  const timeoutMs = deps.service.windDownMs() + STOP_ALL_PEER_SLACK_MS
  const peerReplies = fanOut
    ? Promise.all((deps.peers?.() ?? []).map(async (peer) => {
      try {
        const reply = await deps.forward(peer, "POST", "/api/signals/stop-all", {
          reason, wait, via: { node: deps.selfNode },
          ...(deps.reporter ? { orderId: r.orderId, reportTo: true } : {}),
        }, wait ? timeoutMs : undefined)
        if (!reply) return { node: peer, ok: false, error: "not reachable" }
        if (reply.status >= 400) return { node: peer, ok: false, error: String(reply.body.error ?? `HTTP ${reply.status}`) }
        // `peer`: the name this node knows it by; `node`: its own name, as
        // it answered. Its report after the restart may use either.
        return { node: peer, ok: true, ...reply.body, peer }
      } catch (e: any) {
        // No answer in time: the order reached it and it is still winding
        // down, so it reports here after its restart like the others.
        if (/abort|timeout/i.test(String(e?.name ?? e))) return { node: peer, ok: false, late: true, error: "no answer in time; its plans may still be saving", peer }
        return { node: peer, ok: false, error: String(e?.message ?? e) }
      }
    }))
    : Promise.resolve(undefined)
  const tasks = wait ? await r.done : r.tasks
  const peers = await peerReplies
  // The peers that took the order report here after the restart: every one
  // that answered, or did not answer in time. Not one that was not
  // reachable or refused it.
  const took = (peers ?? []).filter((p: any) => p.ok || p.late).map((p: any): OrderPeer => ({
    name: p.peer, ...(typeof p.node === "string" && p.node !== p.peer ? { node: p.node } : {}),
  }))
  if (deps.reporter && took.length) deps.reporter.begin(r.orderId, took)
  // A refused task is still running: a restart would cut it off.
  const allSaved = tasks.every((t) => t.state !== "winding-down" && t.state !== "refused")
  const refused = tasks.filter((t) => t.state === "refused").map((t) => t.id)
  const peersSafe = !peers || peers.every((p: any) => p.ok && p.safeToRestart === true)
  return {
    status: wait ? 200 : 202,
    body: {
      ok: true, node: deps.selfNode, orderId: r.orderId, tasks,
      ...(peers ? { peers } : {}),
      ...(wait ? { safeToRestart: allSaved && peersSafe } : {}),
      message: wait
        ? (allSaved && peersSafe ? "Every task stopped and its plan is saved. Safe to restart; each task resumes from its plan on start."
          : refused.length ? `Not safe to restart: ${refused.join(", ")} could not be stopped and is still running; see tasks and peers.`
          : "Not every plan is confirmed saved; see tasks and peers.")
        : "Stopping. Each agent is writing its resume plan; GET /api/signals/stopped shows them once saved.",
    },
  }
}
