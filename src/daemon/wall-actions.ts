import { randomUUID } from "crypto"
import { redactSecrets } from "@/agents/memory-trust"
import type { InboxContext } from "@/approvals/inbox"
import { requestStoreFor } from "@/approvals/inbox"
import { summarize } from "@/requests/card-view"
import { readRequestSettings } from "@/requests/settings"
import { COMMENT_MAX, OPEN_STATES, TEXT_MAX } from "@/requests/store"
import { agentsOf, handleRequestsPanel, REQUESTS_PANEL_PREFIX } from "./requests-panel"

// --- What the owner does from a Wall post (#1316) ---
//
// The Wall reads; these are its only writes, each one the owner's, each
// behind the owner-only guard (isWallWrite below, #1454) and the dashboard
// token gate (board-dashboard.ts mounts them below both):
//
//   POST /api/admin/wall/comment      {id, text}  a comment on a post. It goes
//        to the agent that has the task now exactly as a reply from the
//        Approvals page or the Desk does (requests-panel.ts "reply"): the
//        request is handed back to it with the words, and the daemon's
//        requests check starts its turn within a minute. The comment is
//        also kept on the request, so it shows in the post's thread. On a
//        closed post (#1355) the comment opens it again, in progress, and
//        the agent picks it up the same way.
//   POST /api/admin/wall/post         {agent, text}  a new post (#1355): the
//        owner gives an agent of this node a task from the Wall's composer.
//        It opens as a request owed to the owner, and the requests check
//        gives it to the agent as a new turn within a minute.
//   POST /api/admin/wall/call         {id}  the agent that has the task now
//        calls the owner on AgentX Voice about it (the daemon's
//        POST /calls/owner, with the operator key). Or {agent} (#1355): that
//        agent of this node calls, from its agent page.
//   GET  /api/admin/wall/space        the talk running on this computer,
//        its transcript redacted
//   POST /api/admin/wall/space        {id, agent, with, topic, context?}
//        a Space: two agents talk about the post out loud on this
//        computer's speakers (the daemon's talk mode, POST /talk)
//   POST /api/admin/wall/space/say    {text}  the owner's words into it
//   POST /api/admin/wall/space/stop   end it
//
// A comment and a call go to the node that keeps the post (the client
// sends the post's peer, and the dashboard proxy forwards). A Space always
// runs on this computer: its agents may live on mesh peers, and their
// voices play here, where the owner listens.

export const WALL_ACTIONS_PREFIX = "/api/admin/wall"
export const WALL_COMMENT_PATH = `${WALL_ACTIONS_PREFIX}/comment`
export const WALL_CALL_PATH = `${WALL_ACTIONS_PREFIX}/call`
export const WALL_POST_PATH = `${WALL_ACTIONS_PREFIX}/post`
export const WALL_SPACE_PATH = `${WALL_ACTIONS_PREFIX}/space`

const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const TOPIC_MAX = 200
const CONTEXT_MAX = 1500
/** The longest reason a call carries (calls/service REASON_MAX). */
const REASON_MAX = 200

export type Reply = { status: number; body: unknown }

export interface WallActionDeps {
  /** Where the requests live: this node's folder. */
  inbox: InboxContext
  /** A call to this node's daemon, with the dashboard's token and the
   *  operator key. */
  daemon: (method: "GET" | "POST", path: string, body?: unknown) => Promise<Reply>
  now?: () => number
}

/** A write on the Wall (#1454): any method but a read under its prefix.
 *  Every one is the owner's, so board-dashboard.ts refuses it without the
 *  owner's token (wallOwnerOk) before any route or the peer proxy sees it.
 *  A new Wall write goes under this prefix and is guarded by that alone;
 *  test/wall-owner-guard.test.ts fails for one that does not. */
export function isWallWrite(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false
  return path === WALL_ACTIONS_PREFIX || path.startsWith(`${WALL_ACTIONS_PREFIX}/`)
}

/** Is this one of the Wall's write routes, or the Space read? */
export function isWallActionPath(path: string): boolean {
  return path === WALL_COMMENT_PATH || path === WALL_POST_PATH || path === WALL_CALL_PATH || path === WALL_SPACE_PATH || path.startsWith(`${WALL_SPACE_PATH}/`)
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

/** The talk view with what agents said passed through redactSecrets. */
export function redactTalk(view: unknown): unknown {
  if (!view || typeof view !== "object") return view
  const v = view as Record<string, unknown>
  const out: Record<string, unknown> = { ...v }
  if (Array.isArray(v.transcript)) {
    out.transcript = v.transcript.map((t: any) => ({ name: String(t?.name ?? ""), text: redactSecrets(String(t?.text ?? "")) }))
  }
  if (typeof v.saying === "string") out.saying = redactSecrets(v.saying)
  if (typeof v.goal === "string") out.goal = redactSecrets(v.goal)
  return out
}

export async function handleWallAction(method: string, path: string, body: Record<string, unknown>, deps: WallActionDeps): Promise<Reply | null> {
  if (!isWallActionPath(path)) return null
  const now = deps.now?.() ?? Date.now()

  if (path === WALL_COMMENT_PATH) {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    const id = str(body.id)
    const text = str(body.text)
    if (!id || !text) return { status: 400, body: { error: "send { id, text }" } }
    if (text.length > COMMENT_MAX) return { status: 400, body: { error: `the comment is longer than ${COMMENT_MAX} characters` } }
    const store = requestStoreFor(deps.inbox)
    const r = store?.get(id)
    if (!store || !r || r.state === "candidate") return { status: 404, body: { error: `no post "${id}" on this computer` } }
    // A comment on a closed post opens it again for its agent (#1355).
    if (!(OPEN_STATES as readonly string[]).includes(r.state)) {
      if (!readRequestSettings(deps.inbox.configPath).enabled) {
        return { status: 409, body: { error: "Requests are off on this computer, so nothing would give the agent the comment." } }
      }
      if (!store.reopen(id, text, now)) return { status: 409, body: { error: `${id} changed while sending; try again` } }
      store.comment(id, `wc-${now}-${randomUUID().slice(0, 8)}`, text, now)
      return { status: 200, body: { ok: true, agentId: r.agentId, reopened: true, message: `Sent to ${r.agentId}: the post was ${r.state}, so it opens again, and its answer shows in the thread.` } }
    }
    // The same reply the Approvals page and the Desk send.
    const sent = await handleRequestsPanel("POST", `${REQUESTS_PANEL_PREFIX}/reply`, { id, text }, { ...deps.inbox, now })
    if (sent.status !== 200) return sent
    store.comment(id, `wc-${now}-${randomUUID().slice(0, 8)}`, text, now)
    return { status: 200, body: { ok: true, agentId: r.agentId, message: `Sent to ${r.agentId}: it goes on with this post within a minute, and its answer shows in the thread.` } }
  }

  if (path === WALL_POST_PATH) {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    const agentId = str(body.agent)
    const text = str(body.text)
    if (!AGENT_RE.test(agentId) || !text) return { status: 400, body: { error: "send { agent, text }" } }
    if (text.length > TEXT_MAX) return { status: 400, body: { error: `the post is longer than ${TEXT_MAX} characters` } }
    const agent = agentsOf(deps.inbox.configPath).find((a) => a.id === agentId)
    if (!agent) return { status: 404, body: { error: `"${agentId}" is not an agent on this computer` } }
    // The agent is told by the requests check, which is off with the feature.
    if (!readRequestSettings(deps.inbox.configPath).enabled) {
      return { status: 409, body: { error: "Requests are off on this computer, so nothing would give the agent the post." } }
    }
    const store = requestStoreFor(deps.inbox)
    if (!store) return { status: 503, body: { error: "the requests store is not available" } }
    const id = `wp-${now}-${randomUUID().slice(0, 8)}`
    store.addWallPost({ id, agentId, text, now })
    return { status: 200, body: { ok: true, id, agentId, message: `Posted: ${agent.name} gets it within a minute, and its answer shows on the post.` } }
  }

  if (path === WALL_CALL_PATH) {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    const id = str(body.id)
    const agentId = str(body.agent)
    if (!id && agentId) {
      const agent = AGENT_RE.test(agentId) ? agentsOf(deps.inbox.configPath).find((a) => a.id === agentId) : null
      if (!agent) return { status: 404, body: { error: `"${agentId}" is not an agent on this computer` } }
      return deps.daemon("POST", "/calls/owner", { agentId, reason: "The owner called from the Wall" })
    }
    if (!id) return { status: 400, body: { error: "send { id } or { agent }" } }
    const store = requestStoreFor(deps.inbox)
    const r = store?.get(id)
    if (!store || !r || r.state === "candidate") return { status: 404, body: { error: `no post "${id}" on this computer` } }
    const about = (r.headline ?? summarize(r.text, 140)).replace(/\s+/g, " ").trim()
    const reason = `Wall post ${id}: ${about}`.slice(0, REASON_MAX)
    return deps.daemon("POST", "/calls/owner", { agentId: r.agentId, reason })
  }

  // The Space: talk mode, on this computer.
  if (path === WALL_SPACE_PATH && method === "GET") {
    const r = await deps.daemon("GET", "/talk")
    return { status: r.status, body: redactTalk(r.body) }
  }
  if (path === WALL_SPACE_PATH && method === "POST") {
    const agent = str(body.agent)
    const other = str(body.with)
    const topic = str(body.topic).replace(/\s+/g, " ").slice(0, TOPIC_MAX)
    if (!AGENT_RE.test(agent) || !AGENT_RE.test(other)) return { status: 400, body: { error: "send { agent, with }: two agent ids" } }
    if (agent === other) return { status: 400, body: { error: "pick another agent to talk with" } }
    if (!topic) return { status: 400, body: { error: "send { topic }: what the post is about" } }
    const id = str(body.id)
    const context = redactSecrets([
      id ? `This talk is about Wall post ${id}.` : "",
      str(body.context).slice(0, CONTEXT_MAX),
    ].filter(Boolean).join("\n"))
    const r = await deps.daemon("POST", "/talk", { agents: [agent, other], topic, context, maxTurns: 10 })
    return { status: r.status, body: redactTalk(r.body) }
  }
  if (path === `${WALL_SPACE_PATH}/say`) {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    const text = str(body.text).slice(0, 1000)
    if (!text) return { status: 400, body: { error: "send { text }" } }
    return deps.daemon("POST", "/voice/door", { text })
  }
  if (path === `${WALL_SPACE_PATH}/stop`) {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    return deps.daemon("POST", "/talk/stop", {})
  }
  return { status: 404, body: { error: "not found" } }
}
