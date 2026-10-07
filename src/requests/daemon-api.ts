import type { RequestRecord, RequestStore } from "./store"
import type { RequestTracker } from "./tracker"
import type { PlanStore } from "./plan-store"
import { DEFAULT_PLAN_SETTINGS, parseSteps, plansOffFor, type PlanSettings } from "./plans"
import { reportStep, type StepStatus } from "./plan-sweep"

// --- The daemon's /requests endpoints (#356) ---
//
// Reachable by agents (the agentx_request tool posts here), gated like
// /approvals: loopback, or a mesh token.
//   GET  /requests        open requests, oldest first
//   GET  /requests/:id    one request and what is linked to it
//   POST /requests        an agent's own statement about its request:
//                         accept (with `steps`: a tracked plan, #788),
//                         wait (on the owner), done, decline, or step (a
//                         report on one step of a plan). The call must
//                         prove it comes from a running turn of that agent
//                         (CallerProof).
// Dropping a request is the owner's alone: `agentx requests drop`, or the
// dashboard.

export const LIST_LIMIT = 100

export const OWNER_ONLY = "Only the owner drops a request: `agentx requests drop <id>`, or the Approvals page in the dashboard."

/** Names the caller's running turn: its task id, or its channel and chat
 *  (the X-AgentX-Task / X-AgentX-Channel / X-AgentX-Chat headers).
 *
 *  Decision (#393, point 4): channel and chat stay accepted. A warm
 *  process serves many turns and has no per-turn id (claude-process-factory
 *  drops AGENTX_TASK_ID), so it has nothing else to show. What the pair
 *  buys a local caller is bounded: the daemon still requires one running
 *  turn of that agent on exactly that chat, and the actions are the
 *  agent's own statements about its own request (accept, wait, done,
 *  decline), never a drop. A per-process secret would close it; it is
 *  not worth a new handshake while loopback callers are this node's own. */
export interface CallerProof {
  taskId?: string
  channel?: string
  chatId?: string
}

export interface RequestsApiDeps {
  store: RequestStore
  tracker: RequestTracker
  enabled: boolean
  hasAgent: (agentId: string) => boolean
  /** The channel and chat of the running turn of `agentId` that `proof`
   *  names, or null when it names none. A write is refused without one:
   *  the agent id in the body alone proves nothing. */
  runningTurn: (agentId: string, proof: CallerProof) => { channel: string; chatId: string } | null
  /** Tracked plans (#788). Unset: a node without them; steps are refused. */
  plans?: PlanStore
  planSettings?: PlanSettings
  /** A plan was made or a step moved: run the plan check soon. */
  onPlanChange?: () => void
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
  proof: CallerProof = {},
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
    const plan = deps.plans?.get(request.id)
    return {
      status: 200,
      body: { request, links: store.links(request.id), ...(plan ? { plan, steps: deps.plans!.steps(request.id), events: deps.plans!.events(request.id) } : {}) },
    }
  }

  if (path === "/requests" && m === "POST") {
    const input = body ?? {}
    const action = str(input.action).toLowerCase()
    if (action === "drop") return { status: 403, body: { error: OWNER_ONLY } }
    if (!["accept", "wait", "done", "decline", "step"].includes(action)) {
      return { status: 400, body: { error: `unknown action "${action}": use accept, wait, done, decline or step` } }
    }
    if (!deps.enabled) return { status: 409, body: { error: "Requests are turned off on this node (requests.enabled)." } }
    const agentId = str(input.agentId)
    if (!agentId || !deps.hasAgent(agentId)) return { status: 400, body: { error: "agentId must be an agent on this node" } }

    // The body says who is speaking; the proof must show a running turn
    // of that agent. Without it, any local caller could close any request.
    const turn = deps.runningTurn(agentId, proof)
    if (!turn) return { status: 403, body: { error: `no running turn of "${agentId}" matches this call: use the agentx_request tool from inside your run` } }

    // Without an id it is the request of the turn that is speaking, never
    // an older one in the same chat that someone else's turn could reach.
    const id = str(input.id)
    let request: RequestRecord | null = null
    if (id) request = store.get(id)
    else {
      const live = deps.tracker.liveRequestId(agentId, turn.channel, turn.chatId)
      request = live ? store.get(live) : null
    }
    if (!request) {
      return { status: 404, body: { error: id ? `no request "${id}"` : "This turn has no recorded request. Pass the id of the request you mean (list shows them); only the owner's own messages are recorded." } }
    }
    if (["done", "declined", "dropped"].includes(request.state)) {
      return { status: 409, body: { error: `request "${request.id}" is already closed (${request.state})` } }
    }
    const now = deps.now ?? Date.now()

    // A step report comes from the agent that owns the step, which is
    // often not the agent the request was asked of.
    if (action === "step") {
      if (!deps.plans) return { status: 409, body: { error: "This node has no plans." } }
      const status = str(input.status).toLowerCase() as StepStatus
      if (!["progress", "done", "blocked"].includes(status)) return { status: 400, body: { error: "step needs status: progress, done or blocked" } }
      const n = Number(input.step)
      if (!Number.isInteger(n) || n < 1) return { status: 400, body: { error: "step needs step: the step's number in the plan (1 is the first)" } }
      const err = reportStep(store, deps.plans, {
        requestId: request.id, step: n, status, agentId, evidence: str(input.evidence), note: str(input.note) || str(input.reason),
      }, now)
      if (err) return { status: /belongs to/.test(err) ? 403 : /no plan|no step/.test(err) ? 404 : 409, body: { error: err } }
      deps.onPlanChange?.()
      return { status: 200, body: { request: store.get(request.id), plan: deps.plans.get(request.id), steps: deps.plans.steps(request.id) } }
    }

    if (request.agentId !== agentId) return { status: 403, body: { error: `request "${request.id}" belongs to another agent` } }

    if (action === "accept" && input.steps !== undefined) {
      const settings = deps.planSettings ?? DEFAULT_PLAN_SETTINGS
      if (!deps.plans) return { status: 409, body: { error: "This node has no plans: accept without steps." } }
      const off = plansOffFor(settings, agentId)
      if (off) return { status: 409, body: { error: `${off} Accept without steps.` } }
      if (deps.plans.get(request.id)) return { status: 409, body: { error: `request "${request.id}" already has a plan: report on its steps with action step` } }
      const parsed = parseSteps(input.steps, { createdBy: agentId, hasAgent: deps.hasAgent, settings })
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
      store.progress(request.id, now)
      deps.plans.create(request.id, agentId, parsed.steps, now)
      deps.onPlanChange?.()
      return { status: 200, body: { request: store.get(request.id), plan: deps.plans.get(request.id), steps: deps.plans.steps(request.id) } }
    }

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
