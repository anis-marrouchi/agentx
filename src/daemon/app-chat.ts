import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { AppChatStore, AppConversation } from "./app-chat-store"
import { readJson, type NodeReply, type SnapshotNode } from "./app-fleet"
import { relayTurn, type DaemonTarget } from "./app-chat-relay"
import { ChatTurn, ORPHAN_LIMIT_MS } from "./app-chat-turns"

// --- Phone app: Chat (/api/app/agents, /api/app/chat, /api/app/conversations) ---
//
// Phase 2 of the mobile epic. Runs behind the device-token check in
// app-routes.ts, so every handler here may assume a paired phone.
//
// The picker comes from the dashboard's live snapshot (every node, presence,
// busy state) matched against the daemon's /mesh, because a turn for another
// node travels over the mesh. A conversation is pinned to one agent on one
// node when it starts, and the agent sees channel "app" with chat id
// "app:<conversationId>", so each follow-up resumes the same agent session.

export interface AppMeshPeer {
  peer: string
  peerUrl: string
  healthy: boolean
  skills?: Array<{ id: string; name?: string }>
}

export interface AppChatDeps {
  /** Null when this computer's database can't be opened. */
  store: () => AppChatStore | null
  /** The daemon this dashboard serves, with the token it accepts. */
  daemon: DaemonTarget & { name?: string }
  snapshot: () => Promise<{ nodes: SnapshotNode[] }>
  /** The daemon's GET /mesh: the peers it can forward a turn to. */
  meshPeers: () => Promise<AppMeshPeer[]>
  /** The dashboard's allowlisted, token-carrying POST (as in app-fleet.ts). */
  nodePost: (nodeUrl: string, path: string, body: unknown) => Promise<NodeReply>
  /** How long a turn may run with no phone attached (default 30 min). */
  orphanLimitMs?: number
}

export interface PickerNode {
  /** What POST /api/app/chat takes as `node`; null when chat can't reach it. */
  target: string | null
  name: string
  online: boolean
  agents: Array<{ id: string; name: string; busy: boolean; running: number; color?: string }>
}

const MAX_MESSAGE = 8_000
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/
/** conversation id → its running turn. One turn at a time per conversation. */
const inflight = new Map<string, ChatTurn>()

export async function handleAppChat(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: AppChatDeps,
): Promise<boolean> {
  if (path !== "/api/app/agents" && path !== "/api/app/chat" && path !== "/api/app/chat/stop" && path !== "/api/app/chat/attach" &&
    path !== "/api/app/conversations" && !path.startsWith("/api/app/conversations/")) return false

  if (method === "GET" && path === "/api/app/agents") {
    return json(res, 200, { nodes: await picker(deps) })
  }
  const store = deps.store()
  if (!store) return json(res, 503, { error: "The database on this computer is unavailable, so chats can't be saved." })

  if (method === "GET" && path === "/api/app/conversations") {
    return json(res, 200, { conversations: store.list(device.id) })
  }
  const one = method === "GET" ? /^\/api\/app\/conversations\/([^/]+)$/.exec(path) : null
  if (one) {
    const conv = store.get(device.id, decodeURIComponent(one[1]))
    if (!conv) return json(res, 404, { error: "no such conversation" })
    const turn = inflight.get(conv.id)
    // A running turn comes with what the agent has written so far.
    return json(res, 200, { ...conv, running: !!turn, ...(turn ? { partial: { text: turn.text, tools: turn.tools } } : {}) })
  }
  if (method === "GET" && path === "/api/app/chat/attach") {
    // A phone coming back to a turn still running: what was written so far,
    // then the live stream to the end.
    const conv = store.get(device.id, new URL(req.url || path, "http://x").searchParams.get("conversationId") || "")
    const turn = conv && inflight.get(conv.id)
    if (!conv || !turn) return json(res, 404, { error: "nothing is running in this conversation" })
    openSse(res)
    const { id, title, node, nodeName, agent, agentName } = conv
    res.write(sse("conversation", { id, title, node, nodeName, agent, agentName }))
    res.write(sse("resume", { text: turn.text, tools: turn.tools }))
    turn.attach(res)
    return true
  }
  if (method !== "POST" || (path !== "/api/app/chat" && path !== "/api/app/chat/stop")) return json(res, 404, { error: "not found" })

  let body: Record<string, unknown>
  try { body = await readJson(req, 64 * 1024) } catch (e: any) { return json(res, 400, { error: e.message }) }

  if (path === "/api/app/chat/stop") {
    const conv = store.get(device.id, String(body.conversationId ?? ""))
    if (!conv) return json(res, 404, { error: "no such conversation" })
    // Dropping the relay interrupts the run upstream. The task's own cancel
    // route runs as well: it covers a turn this dashboard no longer holds
    // (it restarted) and a peer on an older version.
    const running = inflight.get(conv.id)
    if (running) {
      running.ac.abort()
      void cancelRuns(conv, deps, device.name)
      return json(res, 200, { stopped: true })
    }
    if (await cancelRuns(conv, deps, device.name)) return json(res, 200, { stopped: true })
    return json(res, 404, { error: "nothing is running in this conversation" })
  }
  await startTurn(res, body, device, store, deps)
  return true
}

/** One row per node, in snapshot order, then the mesh peers the snapshot
 *  could not reach. A peer counts as online when the daemon's mesh sees it
 *  healthy, because that is the path a turn takes. */
export function buildPicker(nodes: SnapshotNode[], daemon: AppChatDeps["daemon"], peers: AppMeshPeer[]): PickerNode[] {
  const primary = norm(daemon.url)
  const seen = new Set<string>()
  const out: PickerNode[] = []
  for (const n of nodes) {
    const url = norm(n.url)
    const peer = peers.find((p) => norm(p.peerUrl) === url)
    if (peer) seen.add(peer.peer)
    const local = url === primary
    const agents: Array<{ id: string; name?: string; active?: number; runningTasks?: unknown[]; color?: string }> = n.agents.length ? n.agents : (peer?.skills ?? [])
    out.push({
      target: local ? "local" : peer ? peer.peer : null,
      // An unreachable node's snapshot name is its URL; prefer a real name.
      name: n.reachable ? n.name : (local ? daemon.name : peer?.peer) || n.name,
      online: local ? n.reachable : peer ? peer.healthy : false,
      agents: agents.map((a) => {
        const running = Array.isArray(a.runningTasks) ? a.runningTasks.length : 0
        return { id: a.id, name: a.name || a.id, busy: running > 0 || (a.active ?? 0) > 0, running, ...(a.color ? { color: a.color } : {}) }
      }),
    })
  }
  for (const p of peers) {
    if (seen.has(p.peer)) continue
    out.push({
      target: p.peer, name: p.peer, online: p.healthy,
      agents: (p.skills ?? []).map((a) => ({ id: a.id, name: a.name || a.id, busy: false, running: 0 })),
    })
  }
  return out
}

async function picker(deps: AppChatDeps): Promise<PickerNode[]> {
  const [snap, peers] = await Promise.all([
    deps.snapshot().catch(() => ({ nodes: [] as SnapshotNode[] })),
    deps.meshPeers().catch(() => [] as AppMeshPeer[]),
  ])
  return buildPicker(snap.nodes, deps.daemon, peers)
}

async function startTurn(res: ServerResponse, body: Record<string, unknown>, device: TokenRecord, store: AppChatStore, deps: AppChatDeps): Promise<void> {
  const message = typeof body.message === "string" ? body.message.trim() : ""
  if (!message || message.length > MAX_MESSAGE) { json(res, 400, { error: `message must be 1–${MAX_MESSAGE} characters` }); return }

  let conv: AppConversation | null
  if (body.conversationId != null) {
    // A follow-up always goes where the conversation started, whatever the
    // body says, so it can't be pointed at another agent's session.
    conv = store.get(device.id, String(body.conversationId))
    if (!conv) { json(res, 404, { error: "no such conversation" }); return }
  } else {
    const node = typeof body.node === "string" ? body.node : ""
    const agent = typeof body.agent === "string" ? body.agent : ""
    if (!AGENT_RE.test(agent)) { json(res, 400, { error: "pick an agent" }); return }
    const target = (await picker(deps)).find((n) => n.target === node)
    if (!target) { json(res, 400, { error: `unknown node "${node}"` }); return }
    if (!target.online) { json(res, 409, { error: `${target.name} is offline` }); return }
    const a = target.agents.find((x) => x.id === agent)
    if (!a) { json(res, 400, { error: `no agent "${agent}" on ${target.name}` }); return }
    conv = store.create(device.id, { node, nodeName: target.name, agent, agentName: a.name }, message)
  }
  if (inflight.has(conv.id)) { json(res, 409, { error: "The agent is still answering in this conversation." }); return }

  const turn = new ChatTurn(deps.orphanLimitMs ?? ORPHAN_LIMIT_MS)
  inflight.set(conv.id, turn)
  store.append(device.id, conv.id, { role: "user", content: message, at: Date.now() })
  const { id, title, node, nodeName, agent, agentName } = conv
  openSse(res)
  res.write(sse("conversation", { id, title, node, nodeName, agent, agentName }))
  // The phone leaving (locked screen, lost signal) does NOT stop the turn:
  // the relay reads on and saves the answer. Only Stop, or the orphan limit,
  // aborts it (app-chat-turns.ts).
  turn.attach(res)
  try {
    const out = await relayTurn(deps.daemon, { node, agent, message, chatId: `app:${id}` }, turn.ac.signal, (e, d) => turn.broadcast(e, d))
    if (turn.orphaned) {
      out.error = `Stopped: the phone was away for more than ${Math.round((deps.orphanLimitMs ?? ORPHAN_LIMIT_MS) / 60_000)} minutes.`
      void cancelRuns(conv, deps, device.name)
    }
    store.append(device.id, id, {
      role: "assistant", content: out.text, status: out.status, at: Date.now(),
      ...(out.error ? { error: out.error } : {}), ...(out.ui ? { ui: out.ui } : {}), ...(out.tools.length ? { tools: out.tools } : {}),
    })
    // The reply as saved: text without its agentx:ui block, plus the block parsed.
    turn.broadcast("final", { status: out.status, content: out.text, ...(out.error ? { error: out.error } : {}), ...(out.ui ? { ui: out.ui } : {}) })
  } finally {
    inflight.delete(id)
    turn.finish()
  }
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",
  })
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Cancels this conversation's runs through /api/tasks/:id/cancel on the
 *  node that hosts the agent, found in the live snapshot. Returns how many. */
async function cancelRuns(conv: AppConversation, deps: AppChatDeps, device: string): Promise<number> {
  try {
    let nodeUrl = norm(deps.daemon.url)
    if (conv.node !== "local") {
      const peer = (await deps.meshPeers()).find((p) => p.peer === conv.node)
      if (!peer) return 0
      nodeUrl = norm(peer.peerUrl)
    }
    const snap = await deps.snapshot()
    const node = snap.nodes.find((n) => norm(n.url) === nodeUrl)
    const tasks = node?.agents.find((a) => a.id === conv.agent)?.runningTasks?.filter((t) => t.chatId === `app:${conv.id}`) ?? []
    let n = 0
    for (const t of tasks) {
      const r = await deps.nodePost(nodeUrl, `/api/tasks/${encodeURIComponent(t.id)}/cancel`, { reason: `cancelled by operator (phone: ${device})` })
      if (r.status < 300) n++
    }
    return n
  } catch {
    return 0
  }
}

function norm(u: string): string {
  return u.replace(/\/+$/, "")
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
