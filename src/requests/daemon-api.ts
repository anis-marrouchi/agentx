import { CLOSED_STATES, HOME_KINDS, HOME_LINK_MAX, OPEN_STATES, type HomeKind, type RequestHome, type RequestRecord, type RequestState, type RequestStore } from "./store"
import { DEFAULT_CHECKER_SETTINGS, describeCloseWhen, parseCloseWhen, type CheckerSettings, type CheckResult, type CloseWhen } from "./checkers"
import { parseDue, type LoopChecker } from "./loops"
import type { RequestTracker } from "./tracker"
import type { PlanStore } from "./plan-store"
import { DEFAULT_PLAN_SETTINGS, parseSteps, parseWork, planGateOn, planRequiredFor, plansOffFor, type PlanSettings } from "./plans"
import { reportStep, type StepStatus } from "./plan-sweep"
import { parseDescription } from "./headline"
import { DEFAULT_PROMISE_SETTINGS, describeProof, openPromise, parseProof, proofRefusal, type PromiseSettings } from "./promise"
import { parseNeedsQa, parseVerdict, QA_FILTERS, type QaFilter } from "./qa"
import { parseGoal } from "./goals"
import { describeFlow, FLOW_DAYS_MAX, measureFlow } from "./flow"

// --- The daemon's /requests endpoints (#356) ---
//
// Reachable by agents (the agentx_request tool posts here), gated like
// /approvals: loopback, or a mesh token.
//   GET  /requests        open requests, oldest first
//   GET  /requests/goals  every goal requests name, with progress and cost (#1168)
//   GET  /requests/flow   the daily flow rate, ?days=7&tz= (#1542)
//   GET  /requests/:id    one request and what is linked to it
//   POST /requests        an agent's own statement about its request:
//                         accept (with `steps`: a tracked plan, #788;
//                         code work or a long estimate needs one, #1048;
//                         with `goal`: the goal it serves, #1168),
//                         wait (on the owner), done, decline, or step (a
//                         report on one step of a plan), or promise (an
//                         open loop the agent owes someone, #1039), or
//                         describe (its headline and need, #1126; accept,
//                         wait and promise take them too), or qa (a QA
//                         verdict on any agent's request, open or closed,
//                         #1188; accept, wait, promise and describe take
//                         needsQa to ask for one). The
//                         call must prove it comes from a running turn of
//                         that agent (CallerProof).
// A done on a loop with a `closeWhen` runs its checker first (#1039):
// not met refuses it, unverifiable leaves it open and marks it unverified.
// The checker is async, so the daemon calls handleRequestsCall, which runs
// it between two passes of the synchronous handler.
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
  /** The URL's query string (GET /requests?since=). */
  query?: URLSearchParams
  /** Which checkers agents may use in closeWhen (#1039). */
  checkers?: CheckerSettings
  /** One Promise (#1138 D): whether a promise's done needs a proof. */
  promiseSettings?: PromiseSettings
  /** What the checker said about this request's closeWhen: the second
   *  pass of a done (handleRequestsCall). */
  verdict?: { requestId: string; result: CheckResult }
  /** The time zone of a day in GET /requests/flow (#1542). */
  flowTimeZone?: string
  now?: number
}

/** The optional `home` of accept, wait and done: {kind, link}. Undefined
 *  when absent, a string when it is malformed. */
export function parseHome(v: unknown): RequestHome | undefined | string {
  if (v === undefined || v === null || v === "") return undefined
  const kind = str((v as any)?.kind).toLowerCase()
  const link = str((v as any)?.link)
  if (!(HOME_KINDS as readonly string[]).includes(kind)) return `home.kind must be one of ${HOME_KINDS.join(", ")}`
  if (!link) return "home.link is required: the issue URL, idea file, approval id, ERP record or card id"
  if (link.length > HOME_LINK_MAX) return `home.link is longer than ${HOME_LINK_MAX} characters`
  return { kind: kind as HomeKind, link }
}

export interface ApiReply {
  status: number
  body: unknown
  /** Set on the first pass of a done on a loop with a checker: run it,
   *  then call again with the verdict. */
  verify?: { requestId: string; spec: CloseWhen }
}

/** Open promises one agent may hold: a runaway loop must not fill the list. */
export const MAX_OPEN_PROMISES = 200
const OWED_TO_RE = /^[\w.@:+-]{1,200}$/
const POST_ACTIONS = ["accept", "wait", "done", "decline", "step", "promise", "describe", "qa"]

/** The optional `due` and `closeWhen` of promise, accept and wait. */
function parseLoop(input: Record<string, unknown>, deps: RequestsApiDeps, now: number): { dueAt?: number; closeWhen?: CloseWhen } | string {
  const due = parseDue(input.due)
  if (typeof due === "string") return due
  let closeWhen: CloseWhen | undefined
  if (input.closeWhen !== undefined && input.closeWhen !== null) {
    const spec = parseCloseWhen(input.closeWhen, deps.checkers ?? DEFAULT_CHECKER_SETTINGS, now)
    if (typeof spec === "string") return spec
    closeWhen = spec
  }
  return { ...(due !== undefined ? { dueAt: due } : {}), ...(closeWhen ? { closeWhen } : {}) }
}

/** The handler with its checker: a done on a loop with a closeWhen runs
 *  the check, then the handler decides on its verdict. */
export async function handleRequestsCall(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  deps: RequestsApiDeps & { check?: LoopChecker },
  caller: CallerProof = {},
): Promise<ApiReply> {
  const first = handleRequestsApi(method, path, body, deps, caller)
  if (!first.verify) return first
  const request = deps.store.get(first.verify.requestId)!
  const result: CheckResult = deps.check
    ? await deps.check(first.verify.spec, request).catch((e: any) => ({ verdict: "unverifiable" as const, detail: String(e?.message ?? e) }))
    : { verdict: "unverifiable", detail: "this node runs no checkers" }
  const second = handleRequestsApi(method, path, body, { ...deps, verdict: { requestId: request.id, result } }, caller)
  return { status: second.status, body: second.body }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export const LIST_MAX = 500

/** GET /requests filters (#394), all optional:
 *    state=a,b      request states, or "open", "closed", "all" (default
 *                   open; with since or qa, all)
 *    closed=1       open and closed alike (state=all)
 *    since=<ms>     made since then;  closedSince=<ms>  closed since then
 *    qa=<filter>    awaiting (marked as needing QA, no verdict since),
 *                   or block, risk, pass (the latest verdict, #1188);
 *                   open and closed alike unless state says otherwise
 *    links=1        each item with its links (always on with since)
 *    limit=<n>      1 to 500, default 100
 *    offset=<n>     page from the oldest; the reply gives nextOffset.
 *  Without offset, a since list past its limit keeps the newest (#1036),
 *  any other list the oldest. */
function parseListQuery(p: URLSearchParams): Parameters<RequestStore["query"]>[0] & { links: boolean } | string {
  const ms = (name: string): number | undefined | string => {
    const v = p.get(name)
    if (v == null) return undefined
    const n = Number(v)
    return v.trim() && Number.isFinite(n) && n >= 0 ? n : `${name} must be epoch milliseconds`
  }
  const since = ms("since")
  if (typeof since === "string") return since
  const closedSince = ms("closedSince")
  if (typeof closedSince === "string") return closedSince
  // QA often comes after the done: a qa list is open and closed alike.
  const wanted = p.get("state") ?? (p.get("closed") === "1" || since !== undefined || closedSince !== undefined || p.get("qa") != null ? "all" : "open")
  const groups: Record<string, readonly RequestState[]> = {
    open: OPEN_STATES, closed: CLOSED_STATES, all: [...OPEN_STATES, ...CLOSED_STATES],
    ...Object.fromEntries([...OPEN_STATES, ...CLOSED_STATES].map((s) => [s, [s]])),
  }
  const states = new Set<RequestState>()
  for (const s of wanted.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!Object.hasOwn(groups, s)) return `unknown state "${s}": use open, closed, all or one of ${groups.all.join(", ")}`
    groups[s].forEach((x) => states.add(x))
  }
  if (!states.size) return "state is empty"
  const qa = p.get("qa") ?? undefined
  if (qa !== undefined && !(QA_FILTERS as readonly string[]).includes(qa)) return `qa must be one of ${QA_FILTERS.join(", ")}`
  const whole = (name: string, min: number, max: number): number | undefined | string => {
    const v = p.get(name)
    if (v == null) return undefined
    const n = Number(v)
    return v.trim() && Number.isInteger(n) && n >= min && n <= max ? n : `${name} must be a whole number from ${min} to ${max}`
  }
  const limit = whole("limit", 1, LIST_MAX)
  if (typeof limit === "string") return limit
  const offset = whole("offset", 0, Number.MAX_SAFE_INTEGER)
  if (typeof offset === "string") return offset
  return {
    states: [...states], since, closedSince, qa: qa as QaFilter | undefined, limit: limit ?? LIST_LIMIT, offset,
    newest: offset === undefined && since !== undefined, links: since !== undefined || p.get("links") === "1",
  }
}

export function handleRequestsApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  deps: RequestsApiDeps,
  caller: CallerProof = {},
): ApiReply {
  const m = method.toUpperCase()
  const { store } = deps

  if (path === "/requests" && m === "GET") {
    const q = parseListQuery(deps.query ?? new URLSearchParams())
    if (typeof q === "string") return { status: 400, body: { error: q } }
    const { items, total } = store.query(q)
    const shown = q.links ? items.map((r) => ({ ...r, links: store.links(r.id) })) : items
    const from = q.offset ?? 0
    return {
      status: 200,
      body: {
        enabled: deps.enabled, ...(q.since !== undefined ? { since: q.since } : {}), count: shown.length, total, items: shown,
        truncated: total > items.length, ...(q.offset !== undefined && from + items.length < total ? { nextOffset: from + items.length } : {}),
      },
    }
  }

  if (path === "/requests/goals" && m === "GET") {
    const goals = store.goals()
    return { status: 200, body: { enabled: deps.enabled, count: goals.length, goals } }
  }

  if (path === "/requests/flow" && m === "GET") {
    const q = deps.query ?? new URLSearchParams()
    const days = q.has("days") ? Number(q.get("days")) : 7
    if (!Number.isInteger(days) || days < 1 || days > FLOW_DAYS_MAX) return { status: 400, body: { error: `days must be a whole number from 1 to ${FLOW_DAYS_MAX}` } }
    try {
      const flow = measureFlow(store, { days, timeZone: q.get("tz") || deps.flowTimeZone, now: deps.now })
      return { status: 200, body: { enabled: deps.enabled, ...flow, text: describeFlow(flow) } }
    } catch (e: any) {
      return { status: 400, body: { error: `unknown time zone: ${e?.message ?? e}` } }
    }
  }

  const one = path.match(/^\/requests\/([^/]+)$/)
  if (one && m === "GET") {
    const request = store.get(decodeURIComponent(one[1]))
    if (!request || request.state === "candidate") return { status: 404, body: { error: `no request "${decodeURIComponent(one[1])}"` } }
    const plan = deps.plans?.get(request.id)
    return {
      status: 200,
      body: { request, links: store.links(request.id), verdicts: store.verdicts(request.id), ...(plan ? { plan, steps: deps.plans!.steps(request.id), events: deps.plans!.events(request.id) } : {}) },
    }
  }

  if (path === "/requests" && m === "POST") {
    const input = body ?? {}
    const action = str(input.action).toLowerCase()
    if (action === "drop") return { status: 403, body: { error: OWNER_ONLY } }
    if (!POST_ACTIONS.includes(action)) {
      return { status: 400, body: { error: `unknown action "${action}": use accept, wait, done, decline, step, promise, describe or qa` } }
    }
    // Ask for QA sign-off (#1188): a flag beside what the action does.
    const needsQa = ["accept", "wait", "promise", "describe"].includes(action) ? parseNeedsQa(input.needsQa) : undefined
    if (typeof needsQa === "string") return { status: 400, body: { error: needsQa } }
    // What it is, for the owner's eyes (#1126): describe sets only these;
    // accept, wait and promise take them alongside.
    const described = ["accept", "wait", "promise", "describe"].includes(action) ? parseDescription(input) : {}
    if (typeof described === "string") return { status: 400, body: { error: described } }
    if (action === "describe" && !described.headline && !described.need && needsQa === undefined) {
      return { status: 400, body: { error: "describe needs headline (what it is, in a few plain words) or need (what you need from the owner), or both" } }
    }
    if (!deps.enabled) return { status: 409, body: { error: "Requests are turned off on this node (requests.enabled)." } }
    const agentId = str(input.agentId)
    if (!agentId || !deps.hasAgent(agentId)) return { status: 400, body: { error: "agentId must be an agent on this node" } }

    // The body says who is speaking; the proof must show a running turn
    // of that agent. Without it, any local caller could close any request.
    const turn = deps.runningTurn(agentId, caller)
    if (!turn) return { status: 403, body: { error: `no running turn of "${agentId}" matches this call: use the agentx_request tool from inside your run` } }

    // A promise is a new loop of the agent's own, not a statement about
    // an existing request (#1039).
    if (action === "promise") {
      const now = deps.now ?? Date.now()
      const owedTo = str(input.owedTo)
      if (!OWED_TO_RE.test(owedTo)) return { status: 400, body: { error: 'promise needs owedTo: who you owe it to ("owner", an agent id, or a person id)' } }
      if (owedTo === agentId) return { status: 400, body: { error: "owedTo is you: a promise is owed to someone else" } }
      const text = str(input.text)
      if (!text) return { status: 400, body: { error: "promise needs text: what you promised, in a sentence" } }
      const home = parseHome(input.home)
      if (typeof home === "string") return { status: 400, body: { error: home } }
      const loop = parseLoop(input, deps, now)
      if (typeof loop === "string") return { status: 400, body: { error: loop } }
      if (store.openPromises(agentId) >= MAX_OPEN_PROMISES) {
        return { status: 409, body: { error: `${agentId} already has ${MAX_OPEN_PROMISES} open promises: close some with done or decline first` } }
      }
      const { id } = openPromise(store, { channel: turn.channel, chatId: turn.chatId, agentId, text, owedTo, ...loop, home: home ?? null, now })
      store.setHeadline(id, described, "agent")
      if (needsQa !== undefined) store.setNeedsQa(id, needsQa, now)
      return { status: 200, body: { request: store.get(id) } }
    }

    // Without an id it is the request of the turn that is speaking, never
    // an older one in the same chat that someone else's turn could reach.
    const id = str(input.id)
    if (action === "qa" && !id) return { status: 400, body: { error: "qa needs id: the request you checked (list shows them)" } }
    let request: RequestRecord | null = null
    if (id) request = store.get(id)
    else {
      const live = deps.tracker.liveRequestId(agentId, turn.channel, turn.chatId)
      request = live ? store.get(live) : null
    }
    if (!request) {
      return { status: 404, body: { error: id ? `no request "${id}"` : "This turn has no recorded request. Pass the id of the request you mean (list shows them); only the owner's own messages are recorded." } }
    }
    const now = deps.now ?? Date.now()

    // A QA verdict (#1188) is about the work, whoever did it, and often
    // comes after the done: any agent of this node may give one, on an
    // open or a closed request. It needs the id: a QA agent's own turn is
    // not the request's.
    if (action === "qa") {
      if (request.state === "candidate") return { status: 404, body: { error: `no request "${id}"` } }
      const v = parseVerdict(input.verdict, input.note ?? input.reason)
      if (typeof v === "string") return { status: 400, body: { error: v } }
      store.recordVerdict(request.id, { ...v, by: agentId }, now)
      return { status: 200, body: { request: store.get(request.id) } }
    }

    if (["done", "declined", "dropped"].includes(request.state)) {
      return { status: 409, body: { error: `request "${request.id}" is already closed (${request.state})` } }
    }

    // A step report comes from the agent that owns the step, which is
    // often not the agent the request was asked of.
    if (action === "step") {
      if (input.home !== undefined && input.home !== null && input.home !== "") {
        return { status: 400, body: { error: "a step report takes no home: give it with accept, wait or done" } }
      }
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

    // The headline is written before the action runs, so an accept the
    // plan gate refuses still leaves the request described. The need only
    // once the action went through: it says what the new state needs.
    // Neither is a touch.
    if (action === "describe") {
      store.setHeadline(request.id, described, "agent")
      if (needsQa !== undefined) store.setNeedsQa(request.id, needsQa, now)
      return { status: 200, body: { request: store.get(request.id) } }
    }
    if (described.headline) store.setHeadline(request.id, { headline: described.headline }, "agent")

    const home = parseHome(input.home)
    if (typeof home === "string") return { status: 400, body: { error: home } }
    if (home && action === "decline") return { status: 400, body: { error: "a declined request has no home: give it with accept, wait or done" } }
    // The goal it serves (#1168). Set with the work declaration below, so
    // an accept the plan gate refuses still has it when it comes back.
    if (action !== "accept" && input.goal != null && input.goal !== "") return { status: 400, body: { error: "only accept takes a goal" } }
    const goal = action === "accept" ? parseGoal(input.goal) : undefined
    if (typeof goal === "string") return { status: 400, body: { error: goal } }
    const loop = action === "accept" || action === "wait" ? parseLoop(input, deps, now) : {}
    if (typeof loop === "string") return { status: 400, body: { error: loop } }
    // A done's typed proof (#1138 D): a link, a passing test run, an
    // output, or a check that ran. Without `proof`, a link given as the
    // evidence is one. A promise closed with a proof leaves a wiki fact.
    // A promise closes only with one (unless a closeWhen check runs: the
    // check that ran is its proof).
    let proof = action === "done" ? parseProof(input.proof, now) : null
    if (typeof proof === "string") return { status: 400, body: { error: `proof: ${proof}` } }
    if (action === "done" && !proof && input.proof == null) {
      const fromEvidence = parseProof(str(input.evidence), now)
      proof = typeof fromEvidence === "string" ? null : fromEvidence
    }
    const unproven = action === "done" && !request.closeWhen ? proofRefusal(request, proof, deps.promiseSettings ?? DEFAULT_PROMISE_SETTINGS) : null
    if (unproven) return { status: 409, body: { error: unproven, proofRequired: true } }

    // A loop with a checker closes on evidence, not on the agent's word.
    if (action === "done" && request.closeWhen) {
      const v = deps.verdict?.requestId === request.id ? deps.verdict.result : null
      if (!v) return { status: 202, body: { checking: describeCloseWhen(request.closeWhen) }, verify: { requestId: request.id, spec: request.closeWhen } }
      if (v.verdict === "met") {
        const said = str(input.evidence)
        store.closeVerified(request.id, said && said !== v.detail ? `${v.detail} (agent: ${said})` : v.detail, now)
        if (home) store.setHome(request.id, home, now)
        return { status: 200, body: { request: store.get(request.id), verified: true } }
      }
      if (v.verdict === "not_met") {
        store.markChecked(request.id, "failed", v.detail, now)
        return {
          status: 409,
          body: { error: `Not closed: its check says it is not finished (${v.detail}). It closes by itself once ${describeCloseWhen(request.closeWhen)}.` },
        }
      }
      // Not a touch: an agent that keeps saying done must not reset the
      // quiet timer of a loop nobody can show is finished.
      store.markChecked(request.id, "unverified", v.detail, now)
      if (home) store.setHome(request.id, home, now, { touch: false })
      return { status: 202, body: { request: store.get(request.id), verify: "unverified", detail: v.detail } }
    }

    // The plan gate (#1048): work the owner wants planned does not start
    // on a bare accept. While the gate is set, an accept without steps
    // must say what the work is. The declaration is kept on the request,
    // even when refused, so a later bare accept is gated on it too.
    const declared = action === "accept" ? parseWork(input) : {}
    if (typeof declared === "string") return { status: 400, body: { error: declared } }
    if (action === "accept") {
      store.setWork(request.id, declared)
      if (goal) store.setGoal(request.id, goal)
      const settings = deps.planSettings ?? DEFAULT_PLAN_SETTINGS
      if (input.steps == null && deps.plans && !deps.plans.get(request.id) && planGateOn(settings, agentId)) {
        const kept = store.get(request.id)
        const work = { work: kept?.work ?? undefined, estimateMinutes: kept?.estimateMinutes ?? undefined }
        const why = planRequiredFor(settings, agentId, work)
        if (why) {
          return {
            status: 409,
            body: {
              error: `Not started: ${why}. Accept again with steps: two or more, each with a name and done (what proves it is finished), in the order they run.`,
              planRequired: true,
            },
          }
        }
        if (!work.work) {
          return {
            status: 400,
            body: {
              error: "accept needs `work`: one short word for the kind of work (code, research, writing…), and estimateMinutes when you can say how long. " +
                "Some work needs a plan before it starts.",
              workRequired: true,
            },
          }
        }
      }
    }

    if (action === "accept" && input.steps != null) {
      const settings = deps.planSettings ?? DEFAULT_PLAN_SETTINGS
      if (!deps.plans) return { status: 409, body: { error: "This node has no plans: accept without steps." } }
      const off = plansOffFor(settings, agentId)
      if (off) return { status: 409, body: { error: `${off} Accept without steps.` } }
      if (deps.plans.get(request.id)) return { status: 409, body: { error: `request "${request.id}" already has a plan: report on its steps with action step` } }
      const parsed = parseSteps(input.steps, { createdBy: agentId, hasAgent: deps.hasAgent, settings })
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
      store.progress(request.id, now)
      if (described.need) store.setHeadline(request.id, { need: described.need }, "agent")
      if (home) store.setHome(request.id, home, now)
      store.setLoop(request.id, loop, now)
      deps.plans.create(request.id, agentId, parsed.steps, now)
      if (needsQa !== undefined) store.setNeedsQa(request.id, needsQa, now)
      deps.onPlanChange?.()
      return { status: 200, body: { request: store.get(request.id), plan: deps.plans.get(request.id), steps: deps.plans.steps(request.id) } }
    }

    try {
      if (action === "accept") {
        store.progress(request.id, now)
        if (described.need) store.setHeadline(request.id, { need: described.need }, "agent")
      } else if (action === "wait") {
        const question = str(input.question)
        if (!question) return { status: 400, body: { error: "wait needs `question`: what you are asking the owner" } }
        store.waitOnOwner(request.id, question, now, described.need ?? null)
      } else if (action === "done") store.close(request.id, "done", str(input.evidence) || (proof ? describeProof(proof) : ""), now, proof)
      else store.close(request.id, "declined", str(input.reason), now)
      if (home) store.setHome(request.id, home, now)
      store.setLoop(request.id, loop, now)
      if (needsQa !== undefined) store.setNeedsQa(request.id, needsQa, now)
    } catch (e: any) {
      return { status: 400, body: { error: e?.message ?? String(e) } }
    }
    return { status: 200, body: { request: store.get(request.id) } }
  }

  if (m !== "GET" && m !== "HEAD") return { status: 405, body: { error: "Method not allowed" } }
  return { status: 404, body: { error: "Not found" } }
}
