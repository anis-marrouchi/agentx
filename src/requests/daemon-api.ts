import { WORK_KINDS_HINT } from "./work-hint.js"
import { CLOSED_STATES, CLOSE_KINDS, HOME_KINDS, HOME_LINK_MAX, OPEN_STATES, OWNER_ASKED, type CloseKind, type HomeKind, type RequestHome, type RequestRecord, type RequestState, type RequestStore } from "./store"
import { DEFAULT_CHECKER_SETTINGS, describeCloseWhen, parseCloseWhen, type CheckerSettings, type CheckResult, type CloseWhen } from "./checkers"
import { parseDue, type LoopChecker } from "./loops"
import { checkCloseRefused, checkEvidence, closeByCheckNow, deliverablesOf, oneLine, isRefusedLink, missingProofs, missingText, PROOF_OFF, type CloseProofCtx } from "./close-proof"
import type { RequestTracker } from "./tracker"
import type { PlanStore } from "./plan-store"
import { DEFAULT_PLAN_SETTINGS, parseSteps, parseWork, planGateOn, planRequiredFor, plansOffFor, type PlanSettings } from "./plans"
import { reportStep, type StepStatus } from "./plan-sweep"
import { parseDescription } from "./headline"
import type { ProofChecker, ProofCheckOutcome } from "./proof-check"
import type { ProofClaim } from "./proof-link"
import { armPromiseWake, DEFAULT_PROMISE_SETTINGS, describeProof, issueCloseWhen, openPromise, parseProof, proofRefusal, setDueTime, type PromiseSettings } from "./promise"
import { parseNeedsQa, parseVerdict, QA_FILTERS, type QaFilter } from "./qa"
import { parseGoal } from "./goals"
import { DONE_WHEN_MAX, GOAL_EVIDENCE_MAX, parseGoalCheck, type GoalStore } from "./goal-store"
import { DEFAULT_FLOW, FLOW_DAYS_MAX, flowReport, type FlowSettings } from "./flow"
import { ESTIMATE_TOO_LONG, planDue, readDueFields, type DueGiven, type DuePlan, type DueTimesCtx } from "./due-times"
import { MAX_ESTIMATE_MINUTES } from "./slots"
import { parseStanding, standingRefusal, type StandingNumbers } from "./standing"
import { blockedBody, closingRecord, judgeBudget, warnNote, type BeforeCloseCtx, type OwnerWordsNote } from "./before-close"
import { CHECK_BY, type OwnerVerdict } from "./owner-check"

// --- The daemon's /requests endpoints (#356) ---
//
// Reachable by agents (the agentx_request tool posts here), gated like
// /approvals: loopback, or a mesh token.
//   GET  /requests        open requests, oldest first
//   GET  /requests/goals  every goal requests name, with progress and cost (#1168),
//                         and the goal records (#1568)
//   GET  /requests/goals/:id  one goal: its record and its summary
//   POST /requests/goals  create (or change) a goal record, or close or
//                         drop it: its owner agent only (#1568)
//   GET  /requests/flow   the daily flow rate, ?days=N (#1542)
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

/** The refusal when an accept or done leaves a request without its kind of
 *  work (Anis 2026-11-25: every request has one). */
export function workRequired(action: string): string {
  return `${action} needs \`work\`: one short word for the kind of work this request was, such as ` +
    `${WORK_KINDS_HINT} (a short answer is a reply). Send the same call again with work added.`
}

export const LIST_LIMIT = 100

export const OWNER_ONLY = "Only the owner drops a request: `agentx requests drop <id>`, or its post on the dashboard's Hub."

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
  /** Ids of the people with the owner role (#2079 review B1). */
  ownerPeople?: () => string[]
  /** The channel and chat of the running turn of `agentId` that `proof`
   *  names, or null when it names none. A write is refused without one:
   *  the agent id in the body alone proves nothing. */
  runningTurn: (agentId: string, proof: CallerProof) => { channel: string; chatId: string } | null
  /** Tracked plans (#788). Unset: a node without them; steps are refused. */
  plans?: PlanStore
  /** Goal records (#1568). Unset: goals stay labels on requests. */
  goals?: GoalStore
  planSettings?: PlanSettings
  /** A plan was made or a step moved: run the plan check soon. */
  onPlanChange?: () => void
  /** The URL's query string (GET /requests?since=). */
  query?: URLSearchParams
  /** Which checkers agents may use in closeWhen (#1039). */
  checkers?: CheckerSettings
  /** One Promise (#1138 D): whether a promise's done needs a proof. */
  promiseSettings?: PromiseSettings
  /** The forge a short "group/project#12" in a promise's words means
   *  outside a forge chat (noqta#876 step 5). Null or absent: none. */
  defaultForge?: "github" | "gitlab" | null
  /** Whose day the flow rate counts by, and how many days (#1542). */
  flow?: FlowSettings
  /** What the checker said about this request's closeWhen: the second
   *  pass of a done (handleRequestsCall). */
  verdict?: { requestId: string; result: CheckResult }
  /** Opens a done's proof links (proof-check.ts, #2122). Unset: off. */
  proofCheck?: ProofChecker
  /** What the proof links showed: the second pass of a done. */
  proofLinks?: { requestId: string; outcome: ProofCheckOutcome | null }
  /** Proof per deliverable and reopen once (close-proof.ts, #692).
   *  Unset: as before. */
  closeProof?: CloseProofCtx
  /** Due times from the queue (due-times.ts, #1909). Unset or mode off:
   *  as before. */
  dueTimes?: DueTimesCtx
  /** The tracked numbers (src/numbers), for a standing order's number
   *  (noqta#807). Unset: the rhythm must be given and is not checked. */
  numbers?: StandingNumbers
  /** The owner-words check before the close (before-close.ts, #2047).
   *  Unset or mode off: as before. */
  ownerBeforeClose?: BeforeCloseCtx
  /** The judge's answer on this request's close: the last pass of a done
   *  (handleRequestsCall). Null verdict: no answer, close as before. */
  ownerVerdict?: { requestId: string; verdict: OwnerVerdict | null }
  now?: number
}

const PROOFS_MAX = 50
const DELIVERABLE_NAME_MAX = 80

/** `proofs` of step and done (#692): one link per deliverable, as
 *  [{deliverable: number or name, link}]. A string when malformed. */
export function parseProofs(v: unknown, r: RequestRecord, hasPlan: boolean): Array<{ deliverable: string; link: string }> | string {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return "proofs must be a list of {deliverable, link}"
  if (!v.length) return []
  if (hasPlan) return "this request has a tracked plan: its steps are its deliverables. Report each step done with its link as the evidence"
  if (v.length > PROOFS_MAX) return `proofs takes at most ${PROOFS_MAX} entries`
  const list = Array.isArray(r.deliverables) ? r.deliverables : null
  const out: Array<{ deliverable: string; link: string }> = []
  for (const [i, e] of v.entries()) {
    const at = `proofs[${i}]`
    const raw = (e as any)?.deliverable
    const link = str((e as any)?.link)
    let deliverable: string
    if (typeof raw === "number") {
      if (!Number.isInteger(raw) || raw < 1) return `${at}.deliverable must be the item's number (1 is the first) or its name`
      if (list && raw > list.length) return `${at}.deliverable: there are ${list.length} deliverables: ${list.map((n, j) => `${j + 1}. ${n}`).join("; ")}`
      deliverable = String(raw)
    } else {
      deliverable = oneLine(str(raw))
      if (!deliverable || deliverable.length > DELIVERABLE_NAME_MAX) return `${at}.deliverable must be the item's number (1 is the first) or its name`
      if (list && !list.some((n, j) => n.toLowerCase() === deliverable.toLowerCase() || String(j + 1) === deliverable)) {
        return `${at}.deliverable "${deliverable}" is not one of: ${list.map((n, j) => `${j + 1}. ${n}`).join("; ")}`
      }
    }
    if (!/^https?:\/\/\S+$/i.test(link) || link.length > HOME_LINK_MAX) return `${at}.link must be an http(s) address of at most ${HOME_LINK_MAX} characters`
    if (isRefusedLink(r, link)) return `${at}.link is the request's own issue or check, which proves nothing asked. Give the note or comment that shows this item done`
    out.push({ deliverable, link })
  }
  return out
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
  /** Set on a done that passed every other gate while the owner-words
   *  check runs before the close (#2047): judge `record`, then call again
   *  with the verdict. Nothing is closed yet. */
  judgeOwner?: { requestId: string; record: RequestRecord }
  /** Set on a done that passed the proof gates while its proof links are
   *  opened (#2122): check them, then call again with the outcome. */
  checkLinks?: { requestId: string; links: string[]; claim: ProofClaim }
}

/** Open promises one agent may hold: a runaway loop must not fill the list. */
export const MAX_OPEN_PROMISES = 200
const OWED_TO_RE = /^[\w.@:+-]{1,200}$/
const POST_ACTIONS = ["accept", "wait", "done", "decline", "step", "promise", "describe", "qa", "standing"]

/** The furthest a step's owner may put off its nudges (#1764). */
export const MAX_STEP_WAIT_MS = 7 * 24 * 60 * 60 * 1000

/** The optional `waitUntil` of a progress report: a time ahead, at most a
 *  week out. Returns the time, null when not given, or an error. */
function parseWaitUntil(v: unknown, status: string, now: number): number | null | string {
  const at = parseDue(v, now)
  if (at === undefined) return null
  if (typeof at === "string") return at.replace(/^due/, "waitUntil")
  if (status !== "progress") return "waitUntil goes with status progress only"
  if (at <= now) return "waitUntil must be a time ahead"
  if (at - now > MAX_STEP_WAIT_MS) return "waitUntil can be at most 7 days ahead; report again then"
  return at
}

/** The optional `due` and `closeWhen` of promise, accept and wait. */
function parseLoop(input: Record<string, unknown>, deps: RequestsApiDeps, now: number): { dueAt?: number; closeWhen?: CloseWhen } | string {
  const due = parseDue(input.due, now)
  if (typeof due === "string") return due
  let closeWhen: CloseWhen | undefined
  if (input.closeWhen !== undefined && input.closeWhen !== null) {
    const spec = parseCloseWhen(input.closeWhen, deps.checkers ?? DEFAULT_CHECKER_SETTINGS, now)
    if (typeof spec === "string") return spec
    closeWhen = spec
  }
  return { ...(due !== undefined ? { dueAt: due } : {}), ...(closeWhen ? { closeWhen } : {}) }
}

/** The slot of a promise or an accept (#1909): what the daemon decides
 *  about its due time, and the work declaration it read. Off: a plan that
 *  changes nothing. */
function dueSlot(
  deps: RequestsApiDeps,
  input: Record<string, unknown>,
  ask: {
    agentId: string; requestId: string | null; due: number | null; requester: string | null; words: string; createdAt?: number
    kept?: { work: string | null; estimateMinutes: number | null }
    /** May be critical (#1919): see ownerSourced. */
    ownerSourced: boolean
  },
  now: number,
): { refuse: ApiReply } | { plan: DuePlan; work: { work?: string; estimateMinutes?: number } | null } {
  const pass = { plan: { kind: "pass", finish: () => {} } as DuePlan, work: null }
  const ctx = deps.dueTimes
  if (!ctx || ctx.settings.mode === "off") return pass
  // Shadow never changes a reply and writes nothing but its slot row: a
  // field the agent got wrong is noted on the row, never refused, and a
  // slot that fails to compute leaves the call as it was.
  const shadow = ctx.settings.mode === "shadow"
  try {
    const { fields, problems } = readDueFields(input)
    if (!shadow && problems.length) return { refuse: { status: 400, body: { error: problems[0] } } }
    let work = parseWork(input)
    if (typeof work === "string") {
      if (!shadow) return { refuse: { status: 400, body: { error: work } } }
      problems.push(work)
      work = {}
    }
    if (work.estimateMinutes !== undefined && work.estimateMinutes > MAX_ESTIMATE_MINUTES) {
      if (!shadow) return { refuse: { status: 400, body: { error: ESTIMATE_TOO_LONG } } }
      problems.push(ESTIMATE_TOO_LONG)
      work = { ...work, estimateMinutes: undefined }
    }
    const plan = planDue(ctx, {
      ...ask, fields, problems: shadow ? problems : undefined,
      estimateMinutes: work.estimateMinutes ?? ask.kept?.estimateMinutes ?? null,
      work: work.work ?? ask.kept?.work ?? null,
    }, now)
    if (plan.kind === "refuse") return shadow ? pass : { refuse: { status: plan.status, body: plan.body } }
    // Only "on" writes the work declaration on a promise.
    return { plan, work: !shadow && (work.work !== undefined || work.estimateMinutes !== undefined) ? work : null }
  } catch (e: any) {
    deps.dueTimes?.log?.(`[due-times] slot not computed: ${e?.message ?? e}`)
    return pass
  }
}

/** The request came from the owner, in their own words (#1919): the only
 *  work that may be critical. A request that is not a promise is recorded
 *  only from an owner's turn (RequestTracker.taskStarted: isOwnerTurn, or a
 *  person listed with the owner role), so the record itself says so; the
 *  agent's call cannot. A promise is the agent's own words (or a card it
 *  raised), never the owner's. */
export const ownerSourced = (r: Pick<RequestRecord, "promise">): boolean => !r.promise

/** Due times are on (#1909): the daemon refuses what it cannot place. */
const dueTimesOn = (deps: RequestsApiDeps) => deps.dueTimes?.settings.mode === "on"

/** Keeps the slot once the request has its id. Never fails the call. */
function finishSlot(plan: DuePlan, requestId: string, now: number): DueGiven | null {
  try {
    if (plan.kind === "set") return plan.finish(requestId, now)
    if (plan.kind === "pass") plan.finish(requestId, now)
  } catch { /* the call went through; its slot row is not worth failing it */ }
  return null
}

/** The open request or promise of this agent that the calling turn
 *  follows (#2079): the turn's chat is its id (a wake of the promise, the
 *  [Due time] ask on it), or the tracker says the turn is its run. */
function followedLoop(deps: RequestsApiDeps, agentId: string, turn: { channel: string; chatId: string }): RequestRecord | null {
  const open = (id: string | null) => {
    const r = id ? deps.store.get(id) : null
    return r && r.agentId === agentId && (OPEN_STATES as readonly string[]).includes(r.state) ? r : null
  }
  return open(turn.chatId) ?? open(deps.tracker.liveRequestId(agentId, turn.channel, turn.chatId))
}

/** The owner asked request `r` (#2079 review B1): not a promise, and owed
 *  to the owner, not to a contact whose turn was also recorded. */
function askedByOwner(deps: RequestsApiDeps, r: RequestRecord): boolean {
  if (r.promise || !r.owedTo) return false
  return !!deps.ownerPeople?.().includes(r.owedTo) || deps.tracker.isOwnerSender(r.channel, r.owedTo)
}

/** A promise to `owedTo` is the next step of loop `own` (#2079): owed to the
 *  same party. "owner" is the same party only for a request the owner asked. */
function samePartyLoop(deps: RequestsApiDeps, own: RequestRecord, owedTo: string): boolean {
  if (own.owedTo === owedTo) return true
  return !own.promise && owedTo === "owner" && askedByOwner(deps, own)
}

/** A promise call from a run that follows open loop `r` (#2079): the loop
 *  takes the new due time, closeWhen, words and headline, under the same
 *  due-time rules as a new promise, and keeps its id. The owner's words of
 *  a request they asked stay as they were: the promise's words become its
 *  headline when none is given. */
function updateLoop(
  deps: RequestsApiDeps,
  r: RequestRecord,
  p: {
    input: Record<string, unknown>; text: string; loop: { dueAt?: number; closeWhen?: CloseWhen }; home: RequestHome | null
    described: { headline?: string; need?: string }; needsQa: boolean | undefined
  },
  now: number,
): ApiReply {
  const { store } = deps
  const { loop } = p
  const fromOwner = ownerSourced(r)
  const slot = dueSlot(deps, p.input, {
    agentId: r.agentId, requestId: r.id, due: loop.dueAt ?? null, requester: r.owedTo ?? r.sender ?? "owner",
    words: p.described.headline ?? p.text,
    kept: { work: r.work, estimateMinutes: r.estimateMinutes }, ownerSourced: fromOwner,
  }, now)
  if ("refuse" in slot) return slot.refuse
  if (slot.plan.kind === "set") loop.dueAt = slot.plan.dueAt
  if (r.promise) store.setText(r.id, p.text, now)
  // A headline is set only on a loop that has none yet: a follow-up never
  // overwrites it (review C1). The need still moves.
  const headline = r.headline ? undefined : p.described.headline ?? (fromOwner ? p.text : undefined)
  store.setHeadline(r.id, { need: p.described.need, headline }, "agent")
  if (loop.closeWhen) store.setLoop(r.id, { closeWhen: loop.closeWhen }, now)
  else if (!r.closeWhen) {
    const cw = issueCloseWhen(p.text, r.id, now, { channel: r.channel, chatId: r.chatId, forge: deps.defaultForge ?? null })
    if (cw) store.setLoop(r.id, { closeWhen: cw }, now)
  }
  // The new due time moves the wake behind it, or stands one up.
  if (typeof loop.dueAt === "number" && loop.dueAt > now) setDueTime(store, r.id, loop.dueAt, now)
  else if (loop.dueAt !== undefined) store.setLoop(r.id, { dueAt: loop.dueAt }, now)
  if (p.home) store.setHome(r.id, p.home, now)
  if (slot.work) store.setWork(r.id, slot.work)
  if (p.needsQa !== undefined) store.setNeedsQa(r.id, p.needsQa, now)
  const due = finishSlot(slot.plan, r.id, now)
  return { status: 200, body: { request: store.get(r.id), reused: true, ...(due ? { due } : {}) } }
}

/** An agent's done on a request with no checker, read against what the
 *  owner asked (noqta#876 cause 2). Null: it may close. Off: always null.
 *  Unread words are read first: block answers 202 and the agent says
 *  done again; warn closes and signals. One deliverable closes as before. */
export function agentDoneGate(store: RequestStore, id: string, now: number, ctx: CloseProofCtx): ApiReply | null {
  if (ctx.mode === "off") return null
  const r = store.get(id)
  if (!r) return null
  const d = deliverablesOf(r, ctx.plan?.(r.id) ?? null)
  if (!d) {
    if (!ctx.read) return null
    void ctx.read(r).catch((e: any) => ctx.log?.(`[requests] ${r.id}: reading its deliverables failed: ${e?.message ?? e}`))
    if (ctx.mode !== "block") return null
    return { status: 202, body: { request: r, verify: "reading", detail: "Not closed yet: reading what the owner's words ask for. Say done again in a minute, with one proof link per item." } }
  }
  const missing = missingProofs(r, d)
  if (!missing.length) return null
  const text = missingText(missing)
  if (ctx.mode === "warn") {
    if (store.signalProofMissing(r.id, text, now)) ctx.log?.(`[requests] ${r.id} closed by its agent with ${text}`)
    return null
  }
  store.markChecked(r.id, "proof_missing", text, now)
  return {
    status: 409,
    body: {
      error: `Not closed: the owner asked for ${d.names.length} things and there is ${text}. Give one link per item with proofs: [{deliverable, link}] on step or done.`,
      proofRequired: true,
      missing,
    },
  }
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
  // The judge's time is counted from here: the agent's call has 45 s in
  // all, and a closeWhen check may run first (#2047 review).
  const startedAt = (deps.ownerBeforeClose?.clock ?? Date.now)()
  let passDeps: RequestsApiDeps = deps
  const reply = await checkPass(method, path, body, deps, caller)
  if (reply.verdictGiven) passDeps = { ...deps, verdict: reply.verdictGiven }
  if (reply.linksGiven) passDeps = { ...passDeps, proofLinks: reply.linksGiven }
  if (!reply.judgeOwner) return { status: reply.status, body: reply.body }
  const ctx = deps.ownerBeforeClose!
  const { requestId, record } = reply.judgeOwner
  const budget = judgeBudget(ctx, startedAt)
  let verdict: OwnerVerdict | null = null
  if (!budget) ctx.log?.(`[requests] ${requestId}: owner-words before close skipped, too little time left in the call; the sweep judges it`)
  else {
    verdict = await (ctx.judge?.(record, budget) ?? Promise.resolve(null)).catch((e: any) => {
      ctx.log?.(`[requests] ${requestId}: owner-words before close failed: ${e?.message ?? e}`)
      return null
    })
    if (!verdict) ctx.log?.(`[requests] ${requestId}: owner-words before close gave no answer; closing, the sweep judges it`)
  }
  const last = handleRequestsApi(method, path, body, { ...passDeps, ownerVerdict: { requestId, verdict } }, caller)
  return { status: last.status, body: last.body }
}

/** The first passes of a call: the handler, then its closeWhen check
 *  when a done asks for one. */
async function checkPass(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  deps: RequestsApiDeps & { check?: LoopChecker },
  caller: CallerProof,
): Promise<ApiReply & { verdictGiven?: { requestId: string; result: CheckResult }; linksGiven?: RequestsApiDeps["proofLinks"] }> {
  const first = handleRequestsApi(method, path, body, deps, caller)
  if (first.checkLinks && deps.proofCheck) {
    const { requestId, links, claim } = first.checkLinks
    const outcome = await deps.proofCheck(links, claim).catch((e: any) => {
      deps.closeProof?.log?.(`[requests] ${requestId}: proof link check failed: ${e?.message ?? e}`)
      return null
    })
    const linksGiven = { requestId, outcome }
    const second = handleRequestsApi(method, path, body, { ...deps, proofLinks: linksGiven }, caller)
    return { ...second, linksGiven }
  }
  if (!first.verify) return first
  const request = deps.store.get(first.verify.requestId)!
  const result: CheckResult = deps.check
    ? await deps.check(first.verify.spec, request).catch((e: any) => ({ verdict: "unverifiable" as const, detail: String(e?.message ?? e) }))
    : { verdict: "unverifiable", detail: "this node runs no checkers" }
  // An unread list is read before the gate (#692 B5).
  const proof = deps.closeProof
  if (result.verdict === "met" && proof?.read && proof.mode !== "off" && request.deliverables == null && !proof.plan?.(request.id)) {
    await proof.read(request).catch((e: any) => proof.log?.(`[requests] ${request.id}: reading its deliverables failed: ${e?.message ?? e}`))
  }
  const verdictGiven = { requestId: request.id, result }
  const second = handleRequestsApi(method, path, body, { ...deps, verdict: verdictGiven }, caller)
  return { ...second, verdictGiven }
}

/** The owner-words check before an agent's done closes (#2047): ask for
 *  the judge, refuse a mismatch in block mode, or let it close (with the
 *  verdict to keep). Runs after every other gate, right before the write. */
function ownerGate(
  deps: RequestsApiDeps, id: string, by: string, evidence: string, now: number,
): { reply: ApiReply } | { verdict: OwnerVerdict | null } {
  const ctx = deps.ownerBeforeClose
  if (!ctx || ctx.mode === "off" || !evidence) return { verdict: null }
  const given = deps.ownerVerdict?.requestId === id ? deps.ownerVerdict : null
  if (!given) {
    const record = closingRecord(deps.store, id, by, evidence, now)
    if (!record) return { verdict: null }
    return { reply: { status: 202, body: { checking: "owner-words" }, judgeOwner: { requestId: id, record } } }
  }
  const v = given.verdict
  if (v?.verdict === "mismatch" && ctx.mode === "block") {
    ctx.log?.(`[requests] ${id}: owner-words before close (block) refused ${by}'s done: ${v.why}`)
    return { reply: { status: 409, body: blockedBody(v) } }
  }
  return { verdict: v }
}

/** After the close went through: keep the verdict, log a warn, and say
 *  what the caller is told. */
function keepOwnerVerdict(deps: RequestsApiDeps, id: string, v: OwnerVerdict | null, now: number): { ownerWords?: OwnerWordsNote } {
  const ctx = deps.ownerBeforeClose
  if (!ctx || !v) return {}
  ctx.keep?.(id, v, now)
  const note = warnNote(v, ctx.mode, ctx.willReopen?.(id) ?? true)
  if (!note) return {}
  ctx.log?.(`[requests] ${id}: owner-words before close (warn): ${note.why}${note.uncovered.length ? ` (not shown: ${note.uncovered.join("; ")})` : ""}`)
  return { ownerWords: note }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** A decline's reason kind and its link (#2082): superseded, with a link
 *  (http or https) to the newer work or the owner's later instruction.
 *  Null: a plain reason. A string: why it is refused. */
export function parseCloseKind(input: Record<string, any>, action: string): { kind: CloseKind; link: string } | null | string {
  const kind = str(input.reasonKind).toLowerCase()
  const link = str(input.link)
  if (!kind && !link) return null
  if (action !== "decline") return "reasonKind and link go with decline only"
  if (!kind) return 'link goes with reasonKind "superseded": the link to what replaced the request'
  if (!(CLOSE_KINDS as readonly string[]).includes(kind)) return `reasonKind must be one of ${CLOSE_KINDS.join(", ")}`
  if (!/^https?:\/\/\S+$/i.test(link)) return "a decline as superseded needs link: the http or https address of the newer work or the owner's later instruction"
  return { kind: kind as CloseKind, link: link.slice(0, 500) }
}

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

/** POST /requests/goals (#1568): an agent makes or changes a goal (create),
 *  or its owner closes it (close: done, drop: dropped). Like every write
 *  here, it must come from a running turn of the agent it names. */
function goalWrite(input: Record<string, unknown>, deps: RequestsApiDeps, caller: CallerProof): ApiReply {
  const goals = deps.goals
  if (!goals) return { status: 409, body: { error: "This node keeps no goal records." } }
  if (!deps.enabled) return { status: 409, body: { error: "Requests are turned off on this node (requests.enabled)." } }
  const action = str(input.action).toLowerCase()
  if (!["create", "close", "drop"].includes(action)) return { status: 400, body: { error: `unknown goal action "${action}": use create, close or drop` } }
  const agentId = str(input.agentId)
  if (!agentId || !deps.hasAgent(agentId)) return { status: 400, body: { error: "agentId must be an agent on this node" } }
  if (!deps.runningTurn(agentId, caller)) return { status: 403, body: { error: `no running turn of "${agentId}" matches this call: use the agentx_request tool from inside your run` } }
  const now = deps.now ?? Date.now()

  if (action === "create") {
    const goal = parseGoal(input.goal ?? (input.title ? { id: input.id, title: input.title } : undefined))
    if (goal === undefined) return { status: 400, body: { error: "create needs goal {id, title}: a short id and a few plain words" } }
    if (typeof goal === "string") return { status: 400, body: { error: goal } }
    const doneWhen = str(input.doneWhen)
    if (doneWhen.length > DONE_WHEN_MAX) return { status: 400, body: { error: `doneWhen is longer than ${DONE_WHEN_MAX} characters` } }
    const raw = input.check ?? input.closeWhen
    const check = raw == null || raw === "" ? undefined : parseGoalCheck(raw, deps.checkers ?? DEFAULT_CHECKER_SETTINGS, now)
    if (typeof check === "string") return { status: 400, body: { error: check } }
    const had = goals.get(goal.id)
    if (had && had.state !== "active") return { status: 409, body: { error: `goal "${goal.id}" is already ${had.state}: a new goal needs a new id` } }
    if (had?.ownerAgent && had.ownerAgent !== agentId) return { status: 403, body: { error: `goal "${goal.id}" belongs to ${had.ownerAgent}` } }
    const record = goals.upsert({
      ...goal, ownerAgent: agentId, ...(doneWhen ? { doneWhen } : {}), ...(check ? { check } : {}),
    }, now)
    return { status: had ? 200 : 201, body: { goal: record } }
  }

  const id = str(input.id) || (typeof input.goal === "object" && input.goal ? str((input.goal as any).id) : "")
  if (!id) return { status: 400, body: { error: `${action} needs id: the goal's id (goals lists them)` } }
  const had = goals.get(id)
  if (!had) return { status: 404, body: { error: `no goal record "${id}"` } }
  if (had.state !== "active") return { status: 409, body: { error: `goal "${id}" is already ${had.state}` } }
  if (had.ownerAgent && had.ownerAgent !== agentId) return { status: 403, body: { error: `goal "${id}" belongs to ${had.ownerAgent}: only its owner closes it` } }
  const evidence = str(input.evidence) || str(input.reason)
  if (!evidence) return { status: 400, body: { error: action === "close" ? "close needs evidence: what shows the goal is reached" : "drop needs reason: why the goal is given up" } }
  goals.close(id, action === "close" ? "done" : "dropped", evidence.slice(0, GOAL_EVIDENCE_MAX), now)
  return { status: 200, body: { goal: goals.get(id) } }
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
    // The records (#1568): a goal's state, owner and check, including
    // goals no request names yet.
    const records = deps.goals?.list() ?? []
    return { status: 200, body: { enabled: deps.enabled, count: goals.length, goals, records } }
  }

  const oneGoal = path.match(/^\/requests\/goals\/([^/]+)$/)
  if (oneGoal && m === "GET") {
    const id = decodeURIComponent(oneGoal[1])
    const goal = deps.goals?.get(id) ?? null
    const summary = store.goals().find((g) => g.id === id) ?? null
    if (!goal && !summary) return { status: 404, body: { error: `no goal "${id}"` } }
    return { status: 200, body: { goal, summary } }
  }

  if (path === "/requests/goals" && m === "POST") return goalWrite(body ?? {}, deps, caller)

  if (path === "/requests/flow" && m === "GET") {
    const flow = deps.flow ?? DEFAULT_FLOW
    const raw = deps.query?.get("days")
    const days = raw == null ? flow.days : Number(raw)
    if (!Number.isInteger(days) || days < 1 || days > FLOW_DAYS_MAX) return { status: 400, body: { error: `days must be a whole number from 1 to ${FLOW_DAYS_MAX}` } }
    return { status: 200, body: { enabled: deps.enabled, ...flowReport(store, { days, zone: flow.timeZone, now: deps.now }) } }
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
      return { status: 400, body: { error: `unknown action "${action}": use accept, wait, done, decline, step, promise, describe, qa or standing` } }
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
      // A run that follows an open loop of this agent (a wake of its
      // promise, the [Due time] ask, the turn of its request) moves that
      // loop on instead of opening a second one (#2079). Only when it is
      // owed to the same party: a promise to someone else made in that run
      // is new work, not this loop's next check.
      const own = followedLoop(deps, agentId, turn)
      if (own && samePartyLoop(deps, own, owedTo)) return updateLoop(deps, own, { input, text, loop, home: home ?? null, described, needsQa }, now)
      // The same promise again (#2078, #2079): a retry of a call that timed
      // out on the agent's side, or the same words while the first is still
      // open. Give that one back, unchanged.
      const again = store.findOpenPromise(agentId, owedTo, text)
      if (again) return { status: 200, body: { request: store.get(again), repeated: true } }
      if (store.openPromises(agentId) >= MAX_OPEN_PROMISES) {
        return { status: 409, body: { error: `${agentId} already has ${MAX_OPEN_PROMISES} open promises: close some with done or decline first` } }
      }
      // The daemon gives the due time (#1909): off by default.
      const slot = dueSlot(deps, input, { agentId, requestId: null, due: loop.dueAt ?? null, requester: owedTo, words: described.headline ?? text, ownerSourced: false }, now)
      if ("refuse" in slot) return slot.refuse
      if (slot.plan.kind === "set") loop.dueAt = slot.plan.dueAt
      const { id } = openPromise(store, { channel: turn.channel, chatId: turn.chatId, agentId, text, owedTo, ...loop, home: home ?? null, now })
      // Its words name an issue or merge request and it gave no check of
      // its own (noqta#876 step 5): it gets the same note checker as a
      // caught promise. Before, only caught promises had one.
      if (!loop.closeWhen) {
        const cw = issueCloseWhen(text, id, now, { channel: turn.channel, chatId: turn.chatId, forge: deps.defaultForge ?? null })
        if (cw) store.setLoop(id, { closeWhen: cw }, now)
      }
      store.setHeadline(id, described, "agent")
      if (slot.work) store.setWork(id, slot.work)
      if (needsQa !== undefined) store.setNeedsQa(id, needsQa, now)
      const due = finishSlot(slot.plan, id, now)
      return { status: 200, body: { request: store.get(id), ...(due ? { due } : {}) } }
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

    // Every request carries the kind of work it was (Anis 2026-11-25): an
    // accept says it, and a done on a request that never said it does too.
    // Checked before anything is written, so a refused call changes nothing.
    if (action === "accept" || action === "done") {
      const said = parseWork(input)
      if (typeof said === "string") return { status: 400, body: { error: said } }
      if (!said.work && !request.work) return { status: 400, body: { error: workRequired(action), workRequired: true } }
    }

    // Proof links per deliverable (close-proof.ts, #692), in every mode.
    const proofs = action === "step" || action === "done" ? parseProofs(input.proofs, request, deps.plans?.get(request.id)?.state === "active") : []
    if (typeof proofs === "string") return { status: 400, body: { error: proofs } }
    if (action === "step" && (input.step === undefined || input.step === null) && proofs.length) {
      if (request.agentId !== agentId) return { status: 403, body: { error: `request "${request.id}" belongs to another agent` } }
      const added = store.addProofs(request.id, proofs, now)
      return { status: 200, body: { request: store.get(request.id), proofsAdded: added } }
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
      const waitUntil = parseWaitUntil(input.waitUntil, status, now)
      if (typeof waitUntil === "string") return { status: 400, body: { error: waitUntil } }
      const err = reportStep(store, deps.plans, {
        requestId: request.id, step: n, status, agentId, evidence: str(input.evidence), note: str(input.note) || str(input.reason), waitUntil,
      }, now)
      if (err) return { status: /belongs to/.test(err) ? 403 : /no plan|no step/.test(err) ? 404 : 409, body: { error: err } }
      deps.onPlanChange?.()
      return { status: 200, body: { request: store.get(request.id), plan: deps.plans.get(request.id), steps: deps.plans.steps(request.id) } }
    }

    if (request.agentId !== agentId) return { status: 403, body: { error: `request "${request.id}" belongs to another agent` } }

    // A standing order (noqta#807): marked once by its agent, ended only
    // by the owner. An agent's done or decline is refused with what to do
    // instead, before any proof is kept or check is run.
    if (action === "standing") {
      if (request.standing) return { status: 409, body: { error: `request "${request.id}" is already a standing order (number "${request.standing.numberId}")` } }
      const order = parseStanding(input, deps.numbers ?? null, now)
      if (typeof order === "string") return { status: 400, body: { error: order } }
      if (!store.setStanding(request.id, order)) return { status: 409, body: { error: `request "${request.id}" cannot be made standing in state ${request.state}` } }
      return { status: 200, body: { request: store.get(request.id) } }
    }
    if ((action === "done" || action === "decline") && request.standing) {
      return { status: 409, body: { error: standingRefusal(request.standing), standing: true } }
    }
    // The owner is asked whether a close as superseded stands (#2082):
    // their answer moves it, not the agent.
    if (request.state === "waiting_owner" && request.ownerCheck === OWNER_ASKED && ["accept", "wait", "done", "decline"].includes(action)) {
      return {
        status: 409,
        body: {
          error: `Not changed: the owner is asked about your close as superseded ("${request.question ?? "Agree?"}"). ` +
            "Their close is the yes; their reply sends it back to you with their words. If they answered you in chat, ask them to close it or reply on the request.",
          ownerAsked: true,
        },
      }
    }
    const closeKind = parseCloseKind(input, action)
    if (typeof closeKind === "string") return { status: 400, body: { error: closeKind } }

    // Kept before the check runs: the gate reads them. The same link
    // twice is not added again, so the second pass adds nothing.
    if (action === "done" && proofs.length) store.addProofs(request.id, proofs, now)
    if (action === "done" && !request.work) {
      const said = parseWork(input)
      if (typeof said !== "string" && said.work) store.setWork(request.id, { work: said.work })
    }

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

    // Proof per deliverable on the agent's own done (noqta#876 cause 2):
    // the same gate a close by check passes. One link no longer closes a
    // request that asked for several things.
    if (action === "done" && !request.closeWhen) {
      const gate = agentDoneGate(store, request.id, now, deps.closeProof ?? PROOF_OFF)
      if (gate) return gate
    }

    // Its proof links are opened (#2122): the link proof and every
    // per-deliverable link. Block mode refuses only on a firm failure.
    let linkCheck: ProofCheckOutcome | null = null
    if (action === "done" && !request.closeWhen && deps.proofCheck) {
      const given = deps.proofLinks?.requestId === request.id ? deps.proofLinks : null
      if (!given) {
        const links = [
          ...(proof?.kind === "link" ? [proof.value] : []),
          ...(store.get(request.id)?.deliverableProofs ?? []).map((p) => p.link),
        ]
        if (links.length) return { status: 202, body: { checking: "proof links" }, checkLinks: { requestId: request.id, links, claim: { said: str(input.evidence), about: request.headline ?? request.text } } }
      } else linkCheck = given.outcome
      if (linkCheck?.refuse) {
        store.markChecked(request.id, "failed", `Not closed: ${linkCheck.refuse}`, now)
        return { status: 409, body: { error: `Not closed: the proof link shows otherwise (${linkCheck.refuse}). Give the right link, or say what is still left.`, proofFailed: true } }
      }
    }

    // A loop with a checker closes on evidence, not on the agent's word.
    if (action === "done" && request.closeWhen) {
      const v = deps.verdict?.requestId === request.id ? deps.verdict.result : null
      if (!v) return { status: 202, body: { checking: describeCloseWhen(request.closeWhen) }, verify: { requestId: request.id, spec: request.closeWhen } }
      if (v.verdict === "met") {
        // The agent's evidence and its typed proof are kept beside the
        // check's words (#1943): the check proves only what it checks, and
        // the reviewer judges the rest on these and the proofs[] links.
        // All of it on one line, and an agent's own "check" proof is not
        // written as "check:": only the daemon's check ran here.
        const ev = oneLine(str(input.evidence))
        const extra = proof && input.proof != null && !ev.includes(oneLine(proof.value))
          ? oneLine(proof.kind === "check" ? `the assistant says it checked: ${proof.value}` : describeProof(proof))
          : ""
        const said = [ev, extra].filter(Boolean).join("; ")
        const closing = checkEvidence(v.detail, said)
        // The held, blocked and reading gates first: a refused close is
        // not judged (#2047 review N1).
        const refused = checkCloseRefused(store, request.id, v.detail, deps.closeProof ?? PROOF_OFF)
        const owner = refused ? { verdict: null } : ownerGate(deps, request.id, CHECK_BY, closing, now)
        if ("reply" in owner) return owner.reply
        const out = closeByCheckNow(store, request.id, v.detail, closing, now, deps.closeProof ?? PROOF_OFF)
        if (out.outcome === "held") return { status: 409, body: { error: `Not closed: its check gives the same result the owner already found does not match their words (${out.detail}).`, held: true } }
        if (out.outcome === "blocked") {
          // The refusal is the telling (#692 S5): the sweep does not ask again.
          store.markProofAsked(request.id, now)
          return {
            status: 409,
            body: { error: `Not closed: its check is met, but ${out.detail}. Give one link per item with proofs: [{deliverable, link}] on step or done.`, proofRequired: true, missing: out.missing },
          }
        }
        if (out.outcome === "reading") return { status: 202, body: { request: store.get(request.id), verify: "reading", detail: out.detail } }
        if (home) store.setHome(request.id, home, now)
        const said2 = keepOwnerVerdict(deps, request.id, owner.verdict, now)
        return { status: 200, body: { request: store.get(request.id), verified: true, ...said2 } }
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
    // An estimate over a week is refused before it is kept, while due
    // times are on (#1909); off and shadow keep it as before.
    if (dueTimesOn(deps) && declared.estimateMinutes !== undefined && declared.estimateMinutes > MAX_ESTIMATE_MINUTES) {
      return { status: 400, body: { error: ESTIMATE_TOO_LONG } }
    }
    // The daemon gives the due time of an accept (#1909): off by default.
    // A requester's time the queue cannot hold is answered before anything
    // is accepted or written (#1920): no work, goal or goal record is left
    // behind by a refused accept. The slot itself is kept only by slotDone.
    const slot = action === "accept"
      ? dueSlot(deps, input, {
        agentId, requestId: request.id, due: loop.dueAt ?? null, requester: request.owedTo ?? request.sender ?? "owner",
        // It queues from its accept, not from when it was asked: an old
        // request accepted now does not go ahead of work accepted before.
        words: described.headline ?? request.headline ?? request.text,
        kept: { work: request.work, estimateMinutes: request.estimateMinutes },
        ownerSourced: ownerSourced(request),
      }, now)
      : null
    if (slot && "refuse" in slot) return slot.refuse
    if (slot?.plan.kind === "set") loop.dueAt = slot.plan.dueAt
    const slotDone = () => (slot && "plan" in slot ? finishSlot(slot.plan, request!.id, now) : null)

    if (action === "accept") {
      store.setWork(request.id, declared)
      if (goal) {
        store.setGoal(request.id, goal)
        deps.goals?.ensure(goal, agentId, now)
      }
      const settings = deps.planSettings ?? DEFAULT_PLAN_SETTINGS
      if (input.steps == null && deps.plans && deps.plans.get(request.id)?.state !== "active" && planGateOn(settings, agentId)) {
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
      if (deps.plans.get(request.id)?.state === "active") return { status: 409, body: { error: `request "${request.id}" already has a plan: report on its steps with action step` } }
      const parsed = parseSteps(input.steps, { createdBy: agentId, hasAgent: deps.hasAgent, settings })
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
      store.progress(request.id, now)
      if (described.need) store.setHeadline(request.id, { need: described.need }, "agent")
      if (home) store.setHome(request.id, home, now)
      store.setLoop(request.id, loop, now)
      deps.plans.create(request.id, agentId, parsed.steps, now)
      const plannedDue = store.get(request.id)?.dueAt
      if (plannedDue != null && deps.promiseSettings?.acceptWake !== false) {
        store.recordDueGate(request.id, plannedDue, "covered-by-plan", now)
      }
      if (needsQa !== undefined) store.setNeedsQa(request.id, needsQa, now)
      deps.onPlanChange?.()
      const due = slotDone()
      return { status: 200, body: { request: store.get(request.id), plan: deps.plans.get(request.id), steps: deps.plans.steps(request.id), ...(due ? { due } : {}) } }
    }

    // The owner-words check before the close (#2047), after every gate.
    const doneEvidence = action === "done" ? str(input.evidence) || (proof ? describeProof(proof) : "") : ""
    const owner = action === "done" ? ownerGate(deps, request.id, agentId, doneEvidence, now) : { verdict: null }
    if ("reply" in owner) return owner.reply
    let said: { ownerWords?: OwnerWordsNote } = {}
    try {
      if (action === "accept") {
        store.progress(request.id, now)
        if (described.need) store.setHeadline(request.id, { need: described.need }, "agent")
      } else if (action === "wait") {
        const question = str(input.question)
        if (!question) return { status: 400, body: { error: "wait needs `question`: what you are asking the owner" } }
        store.waitOnOwner(request.id, question, now, described.need ?? null)
      } else if (action === "done") {
        if (store.close(request.id, "done", doneEvidence, now, proof, agentId, null, linkCheck?.verify)) said = keepOwnerVerdict(deps, request.id, owner.verdict, now)
      }
      else if (closeKind) {
        store.close(request.id, "declined", str(input.reason) || `superseded by ${closeKind.link}`, now, { kind: "link", value: closeKind.link, ranAt: now }, agentId, closeKind.kind)
      } else store.close(request.id, "declined", str(input.reason), now, null, agentId)
      if (home) store.setHome(request.id, home, now)
      store.setLoop(request.id, loop, now)
      // A due time the agent accepts wakes it when it comes (#1908), like
      // a promise's: before, it only fed the overdue notice to the owner.
      if (action === "accept" && typeof loop.dueAt === "number" && deps.promiseSettings?.acceptWake !== false) armPromiseWake(store, request.id, loop.dueAt, now)
      if (needsQa !== undefined) store.setNeedsQa(request.id, needsQa, now)
    } catch (e: any) {
      return { status: 400, body: { error: e?.message ?? String(e) } }
    }
    const due = slotDone()
    // Warn mode tells the closing agent what its links showed (#2122).
    const links = linkCheck ? { proofLinks: linkCheck.verify } : {}
    return { status: 200, body: { request: store.get(request.id), ...(due ? { due } : {}), ...said, ...links } }
  }

  if (m !== "GET" && m !== "HEAD") return { status: 405, body: { error: "Method not allowed" } }
  return { status: 404, body: { error: "Not found" } }
}
