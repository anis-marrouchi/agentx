// --- Daemon side of A2A callbacks (#277) ---
//
// Two jobs, kept out of the daemon's route switch so they can be tested:
//
//   resolveCallerTurn  Which running turn is asking? A delegation arrives
//                      over HTTP from a tool the agent launched (the agentx
//                      MCP server, or curl). Only requests from this machine
//                      are considered; a request forwarded by a mesh peer
//                      (it carries parentEventId) never names a local turn.
//   createDelegations  The DelegationManager with the registry, the mesh
//                      and the router plugged in.
//
// A reply for the phone app does not go through a channel adapter: the
// phone's conversations live in the dashboard's chat store, a separate
// process. The reply waits in CallbackReplies and a small bus event
// announces it; the dashboard follows those events (a peer's arrive
// through the mesh feed) and files the reply in the thread
// (app-chat-callbacks.ts).

import { resolve } from "path"
import type { IncomingMessage as HttpRequest } from "http"
import type Database from "better-sqlite3"
import { DelegationManager, UNNAMED_CALLER, type CallerTurn, type DelegationDeps, type DelegationOrigin } from "@/a2a/delegation"
import { handoffStoreFor, importDelegationLog } from "@/a2a/handoff-store"
import { rootInitiatorOf, type RootInitiator } from "@/a2a/initiator"
import type { AgentRegistry } from "@/agents/registry"
import type { SessionStore } from "@/agents/sessions"
import type { A2AMesh } from "@/a2a/mesh"
import type { MessageRouter } from "@/channels/router"
import type { DaemonConfig } from "./config"
import { isLoopback } from "./mesh-auth"
import { getEventBus } from "@/events/bus"
import { DEFAULT_WAKE_SETTINGS } from "@/jobs/wake"

/** Channels with no adapter or thread of their own: a callback reply
 *  reaches the person as a push notification. The phone app ("app") is not
 *  here: its replies go into the conversation thread (CallbackReplies). */
const PUSH_FALLBACK_CHANNELS = new Set(["voice", "dashboard"])

/** Bus event that says "a callback reply for a phone conversation is
 *  waiting on this node". The envelope carries only a summary and the
 *  delegation id; the text is read from GET /a2a/delegations/<id>/reply. */
export const CALLBACK_REPLY_KIND = "delegation"
export const CALLBACK_REPLY_TYPE = "reply"

/** A caller's reply after a delegation, held for the dashboard. */
export interface CallbackReply {
  taskId: string
  channel: string
  chatId: string
  agent: string
  text: string
  status: "done" | "error"
  /** The agent has rich messages off: no files, no agentx:ui extras. */
  plain: boolean
  at: number
}

/** Longest reply kept, the same as one message in the phone's chat store. */
export const CALLBACK_REPLY_MAX = 32_000

/**
 * Replies waiting for the dashboard to file them in the phone thread. A
 * small bounded buffer, not a store: the dashboard polls every few
 * seconds, and the reply is in the agent's session either way. Lost on a
 * daemon restart, like the event that points at it.
 */
export class CallbackReplies {
  private byId = new Map<string, CallbackReply>()
  constructor(private max = 200, private ttlMs = 24 * 60 * 60_000, private now: () => number = Date.now) {}

  put(r: Omit<CallbackReply, "at">): CallbackReply {
    const reply: CallbackReply = { ...r, text: r.text.slice(0, CALLBACK_REPLY_MAX), at: this.now() }
    this.byId.delete(reply.taskId)
    this.byId.set(reply.taskId, reply)
    while (this.byId.size > this.max) {
      const oldest = this.byId.keys().next().value
      if (oldest === undefined) break
      this.byId.delete(oldest)
    }
    return reply
  }

  get(taskId: string): CallbackReply | null {
    const r = this.byId.get(taskId)
    if (!r) return null
    if (this.now() - r.at > this.ttlMs) {
      this.byId.delete(taskId)
      return null
    }
    return r
  }
}

export interface CallerHint {
  senderAgentId?: string
  callerTaskId?: string
  callerChannel?: string
  callerChatId?: string
  /** The request came from a mesh peer's forward (body.parentEventId). */
  meshForwarded: boolean
  /** The request came from this machine. */
  local: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

/** Read the caller hints from a delegation request. The MCP server sends
 *  them in the body; curl callers can send `X-AgentX-Task`. */
export function callerHintFrom(req: HttpRequest, body: Record<string, unknown>): CallerHint {
  const header = req.headers["x-agentx-task"]
  return {
    senderAgentId: str(body.senderAgentId),
    callerTaskId: str(body.callerTaskId) ?? str(Array.isArray(header) ? header[0] : header),
    callerChannel: str(body.callerChannel),
    callerChatId: str(body.callerChatId),
    meshForwarded: typeof body.parentEventId === "string",
    local: isLoopback(req.socket?.remoteAddress || ""),
  }
}

/** The caller's running turn, or null when it cannot be named with
 *  certainty. Null means "delegate synchronously", today's behaviour.
 *  The turn must be named: by its task id, or by agent plus channel and
 *  chat. An agent id alone is not enough, because a same-host proxy also
 *  arrives over loopback and could be matched to an unrelated turn. */
export function resolveCallerTurn(
  hint: CallerHint,
  registry: Pick<AgentRegistry, "findRunningTurn" | "runningTaskOwner">,
): CallerTurn | null {
  if (hint.meshForwarded || !hint.local) return null
  let agentId = hint.senderAgentId
  if (hint.callerTaskId) {
    const owner = registry.runningTaskOwner(hint.callerTaskId)
    if (!owner) return null
    if (agentId && owner.agentId !== agentId) return null
    agentId = owner.agentId
    const turn = registry.findRunningTurn(agentId, { taskId: hint.callerTaskId })
    return turn ? { agentId, taskId: turn.taskId, context: turn.context as Record<string, unknown> } : null
  }
  if (!agentId || !hint.callerChannel || !hint.callerChatId) return null
  const turn = registry.findRunningTurn(agentId, { channel: hint.callerChannel, chatId: hint.callerChatId })
  return turn ? { agentId, taskId: turn.taskId, context: turn.context as Record<string, unknown> } : null
}

/**
 * Who asks, when it is an agent (#2007 piece 2, B4): the agent of the
 * resolved turn, or, with no turn, a request from this machine that is not
 * a mesh forward and names a local agent as its sender (C1: the same test
 * resolveCallerTurn makes, so a peer's runPeer or a mesh.delegate step
 * naming an agent id that also exists here is not taken for it). An agent
 * caller always gets a receipt; null keeps today's synchronous answer for
 * the CLI, workflow steps, peers, the phone relay and scripts.
 */
export function agentCallerOf(
  hint: Pick<CallerHint, "senderAgentId" | "meshForwarded" | "local">,
  turn: CallerTurn | null,
  registry: { getAgent(id: string): unknown },
): string | null {
  if (turn) return turn.agentId
  if (hint.meshForwarded || !hint.local || !hint.senderAgentId) return null
  return registry.getAgent(hint.senderAgentId) ? hint.senderAgentId : null
}

/** What an agent caller asked for that it does not get (#2007 B4): a
 *  stream (`stream:true` or an SSE Accept header) or a wait (`async:false`).
 *  Flagged in the 202 body. */
export function ignoredFlags(body: Record<string, unknown>, accept: string): { streamIgnored?: true; asyncIgnored?: true } {
  return {
    ...(body.stream === true || accept.includes("text/event-stream") ? { streamIgnored: true as const } : {}),
    ...(body.async === false ? { asyncIgnored: true as const } : {}),
  }
}

/**
 * Synchronous delegations running on this node: which turn waits on which
 * callee run. Used only to refuse a delegation that could never be
 * answered (a cycle back into a turn that is itself waiting).
 */
export class SyncWaits {
  /** callee run id → the caller turn waiting on it */
  private waitingOn = new Map<string, string>()
  /** callee run id → the root of the chain it works for. A synchronous
   *  callee's own context carries no root, so the next hop asks here. */
  private roots = new Map<string, RootInitiator>()

  begin(callerTaskId: string, calleeRunId: string, root?: RootInitiator): void {
    this.waitingOn.set(calleeRunId, callerTaskId)
    if (root) this.roots.set(calleeRunId, root)
  }

  end(calleeRunId: string): void {
    this.waitingOn.delete(calleeRunId)
    this.roots.delete(calleeRunId)
  }

  rootOf(taskId: string | undefined): RootInitiator | undefined {
    return taskId ? this.roots.get(taskId) : undefined
  }

  /** Every turn waiting on `taskId`, directly or through a chain. */
  waitersOf(taskId: string): Set<string> {
    const out = new Set<string>()
    let cur = this.waitingOn.get(taskId)
    while (cur && !out.has(cur)) {
      out.add(cur)
      cur = this.waitingOn.get(cur)
    }
    return out
  }
}

/**
 * Why a synchronous delegation to `target` must be refused now, or null.
 * An agent cannot ask itself. And when every slot of the target is held by
 * a turn that is (through any chain) waiting on this caller, the request
 * could never start: A -> B -> A with one slot each used to wait out the
 * 25-minute slot limit before failing.
 */
export function cycleRefusal(
  target: string,
  hint: Pick<CallerHint, "senderAgentId" | "meshForwarded">,
  caller: CallerTurn | null,
  registry: Pick<AgentRegistry, "slotHolders">,
  waits: SyncWaits,
): string | null {
  if (hint.meshForwarded) return null
  const self = caller?.agentId ?? hint.senderAgentId
  if (self && self === target) return `An agent cannot delegate to itself ("${target}"). Do the work in this turn instead.`
  if (!caller?.taskId) return null
  const slots = registry.slotHolders(target)
  if (!slots?.full || slots.runIds.length === 0) return null
  const waiting = waits.waitersOf(caller.taskId)
  if (slots.runIds.every((id) => waiting.has(id))) {
    return `Agent "${target}" is busy with the turn that is waiting on this request, so it could never answer. ` +
      "Answer from what you have, or say what you need from it."
  }
  return null
}

/** The root of the chain a calling turn works for: the one a synchronous
 *  hop was started under, else the turn's own. */
export function chainRootOf(caller: CallerTurn, waits: SyncWaits): RootInitiator {
  return waits.rootOf(caller.taskId) ?? rootInitiatorOf(caller.context, caller.agentId)
}

/**
 * People permissions (#379) for an agent-to-agent request: the note when
 * the person the calling turn works for may not reach `callee`, or null.
 * Asked before any hop starts, synchronous or callback, on this node or to
 * a peer. A caller the daemon cannot name is not checked.
 */
export function hopRefusal(
  callee: string,
  caller: CallerTurn | null,
  registry: Pick<AgentRegistry, "refusalFor">,
  waits: SyncWaits,
): string | null {
  return caller ? registry.refusalFor(callee, { initiator: chainRootOf(caller, waits) }) : null
}

/**
 * What /mesh/task does with a request. A request whose own context names a
 * chat (channel and chatId) keeps its behaviour from before #277: its
 * `async: true` delivers the peer's raw answer to that chat, and without
 * the flag it waits. Only a request with no chat of its own may become a
 * callback into the calling turn.
 */
export function meshTaskMode(body: Record<string, unknown>, callbackAllowed: boolean): "callback" | "legacy-async" | "sync" {
  const ctx = body.context as Record<string, unknown> | undefined
  const ownChat = !!ctx && typeof ctx.channel === "string" && !!ctx.channel && typeof ctx.chatId === "string" && !!ctx.chatId
  if (!ownChat && callbackAllowed && typeof body.agent === "string" && body.agent) return "callback"
  return body.async === true ? "legacy-async" : "sync"
}

/** What the daemon's delegation gate decided for one request. */
export type DelegationGateResult =
  | { refused: string }
  | { accepted: Record<string, unknown> }
  | { track: { onStart: (runId: string) => void; end: () => void; root?: RootInitiator } }

/**
 * The HTTP answer for a gate result that settles the request on its own:
 * 409 for a refusal, 202 for an accepted callback. Call sites check
 * `"track" in gate` first; anything else ends here. One place, so /task,
 * /send/agent and /mesh/task answer a refusal the same way: /mesh/task
 * used to drop a refusal and fall through to its synchronous path (#282).
 */
export function gateAnswer(
  gate: Exclude<DelegationGateResult, { track: unknown }>,
): { status: 409 | 202; body: Record<string, unknown> } {
  if ("refused" in gate) return { status: 409, body: { error: gate.refused } }
  return { status: 202, body: gate.accepted }
}

/** The 202 body a caller gets back; its `note` is written for the agent. */
export function acceptedBody(taskId: string, callee: string, peer?: string, send = false): Record<string, unknown> {
  const who = peer ? `${callee} on ${peer}` : callee
  return {
    accepted: true,
    mode: "callback",
    taskId,
    agent: callee,
    ...(peer ? { peer } : {}),
    note: send
      ? `Sent to ${who} (task ${taskId}). The message is delivered; do not send it again. ` +
        `Its answer, or its failure, will reach you as a new message in this conversation. Do not wait or poll for it.`
      : `Delegated to ${who} (task ${taskId}). Their answer will reach you as a new message in this conversation. ` +
        `Tell the person who you asked and why, then end your turn. Do not wait or poll for the result.`,
  }
}

/** What a send that joined an open hand-off gets back (#2007 piece 3):
 *  the 202 of the first send, marked, with nothing started. */
export function joinedBody(taskId: string, callee: string, peer?: string, send = false, carried = false): Record<string, unknown> {
  return {
    ...acceptedBody(taskId, callee, peer, send),
    duplicate: true,
    note: `Already handed off as task ${taskId}; this repeat started nothing. ` +
      (carried
        // An ended continue row (#2042): no new answer comes for it.
        ? `That run ended and the job carries on; its result comes through the job. Do not send it again, and do not wait or poll for it.`
        : `You will hear its answer once, as a new message in this conversation. Do not send it again, and do not wait or poll for it.`),
  }
}

/** The 202 of a none row (#2007 piece 2): an agent caller nobody can call
 *  back. The answer is read by its id; a named sender also gets a notice
 *  on its next run. */
export function noneBody(taskId: string, callee: string, peer: string | undefined, duplicate: boolean, carried = false): Record<string, unknown> {
  const who = peer ? `${callee} on ${peer}` : callee
  return {
    accepted: true,
    mode: "none",
    taskId,
    agent: callee,
    ...(peer ? { peer } : {}),
    ...(duplicate ? { duplicate: true } : {}),
    note: (duplicate
      ? `Already handed off as task ${taskId}; this repeat started nothing. ` + (carried ? `That run ended and the job carries on; its result comes through the job. ` : ``)
      : `Sent to ${who} (task ${taskId}). The message is delivered; do not send it again. `) +
      `No turn of yours can be called back from here, so the answer is not sent to you as a message. ` +
      `When it ends you get a short notice on your next run; read the answer with agentx_lookup (handoff: "${taskId}") or GET /a2a/delegations/${taskId}?as=<you>. Do not wait or poll for it.`,
  }
}

/** What /mesh/task async:true starts (#2007 S5): the peer, the agent it
 *  names (or none: the peer picks), the message, the request's own
 *  context (it names the chat the answer goes to), the asking agent when
 *  it is known, and the peer call itself, made as before. */
export interface MeshDeliver {
  peer: string
  agent?: string
  message: string
  context: Record<string, unknown>
  caller?: string
  run: () => Promise<string>
}

/** The callee a deliver row names when the request named none. */
const DEFAULT_CALLEE = "default"

/** The row's caller: the agent whose chat it is (the answer was sent as
 *  that agent before), else the asking agent, else "?". */
function meshDeliverTurn(o: Omit<MeshDeliver, "run">): CallerTurn {
  const named = typeof o.context.agentId === "string" && o.context.agentId ? o.context.agentId : undefined
  return { agentId: named ?? o.caller ?? UNNAMED_CALLER, context: o.context }
}

function meshDeliverBody(taskId: string, o: Omit<MeshDeliver, "run">, duplicate: boolean, carried = false): Record<string, unknown> {
  const to = `${String(o.context.channel)}:${String(o.context.chatId)}`
  return {
    accepted: true,
    mode: "deliver",
    taskId,
    ...(o.agent ? { agent: o.agent } : {}),
    peer: o.peer,
    deliverTo: to,
    ...(duplicate ? { duplicate: true } : {}),
    note: duplicate
      ? carried
        ? `Already ran as task ${taskId}; this repeat started nothing. The job carries on; its result comes through the job.`
        : `Already running as task ${taskId}; this repeat started nothing. Its result goes to ${to} once.`
      : `The result will be delivered to the originating chat when the peer finishes. Read it any time with GET /a2a/delegations/${taskId}.`,
  }
}

/** The 202 of the open deliver row this request repeats, or null when it
 *  is new work. Asked before the hand-off budget, so a repeat spends no
 *  hop (as on the dlg- paths, #2007 C2). */
export function meshDeliverJoined(delegations: DelegationManager, o: Omit<MeshDeliver, "run">): Record<string, unknown> | null {
  const key = delegations.joinKeyOf({ caller: meshDeliverTurn(o), callee: o.agent || DEFAULT_CALLEE, peer: o.peer, wayHome: "deliver", message: o.message })
  const open = delegations.joined(key)
  return open ? meshDeliverBody(open, o, true, delegations.carriedByJob(open)) : null
}

/** Start /mesh/task async:true on the hand-off journal (#2007 S5): one
 *  row with way_home 'deliver', its dlg- id back at once, the row ended
 *  once (result_text), and the answer sent to the named chat as before.
 *  The context must name channel and chatId; the caller checks that. */
export function startMeshDeliver(delegations: DelegationManager, o: MeshDeliver): { status: 202; body: Record<string, unknown> } {
  const r = delegations.start({
    caller: meshDeliverTurn(o),
    callee: o.agent || DEFAULT_CALLEE,
    peer: o.peer,
    message: o.message,
    wayHome: "deliver",
    run: o.run,
  })
  return { status: 202, body: meshDeliverBody(r.taskId, o, r.duplicate === true, r.carried === true) }
}

/** The notice a named sender gets when its none row ends (#2007 C7). */
export function noneNotice(rec: { id: string; callee: string; peer?: string }, result: { status: string }): string {
  const who = rec.peer ? `${rec.callee}@${rec.peer}` : rec.callee
  return `Your hand-off ${rec.id} to ${who} ended: ${result.status}. Read it by its id (agentx_lookup with handoff: "${rec.id}", or GET /a2a/delegations/${rec.id}?as=<you>).`
}

/** How long a called-back send to a local agent may take (#1100): the
 *  callee's own time limit (a run stopped there is continued by its job's
 *  wake, not inside this send: #1861), plus the wait for a free slot (a2a
 *  runs wait up to 25 min) and a margin. The plain delegation timeout
 *  would cut a long build off half way. */
export function sendTimeoutMs(maxExecutionMinutes: number | undefined): number {
  return ((maxExecutionMinutes ?? 20) + 25 + 5) * 60_000
}

/** Point a callee's new chat at the agent session of its earlier chats on
 *  the same home (#1100), newest first: the first that has one is
 *  continued, with the counters the rotation checks read (SessionStore.
 *  continueFrom). The earlier run has ended: the delegation waits for it.
 *  False when there was nothing to continue, so the run starts fresh. */
export function continueSession(
  store: Pick<SessionStore, "continueFrom">,
  agentId: string,
  from: ReadonlyArray<{ channel: string; chatId: string }>,
  to: { channel: string; chatId: string },
): boolean {
  if (!to.chatId) return false
  try {
    return from.some((f) => store.continueFrom(agentId, f, to))
  } catch {
    return false
  }
}

/** What a run that says it ends to wait gets back (#1100). */
export function waitingBody(w: { delegation: string | null; asker: string | null; on: string; dueAt?: number }): Record<string, unknown> {
  const due = w.dueAt ? ` by ${new Date(w.dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""
  const told = w.delegation
    ? `When this run ends, ${w.asker} is told the work is waiting for ${w.on}${due}, not done.`
    : "No delegation on this node waits on this run, so no one is called back; say it in your reply."
  return {
    ok: true,
    delegation: w.delegation,
    note: `Recorded: this run ends waiting for ${w.on}${due}. ${told} When the wait is over, finish the work and report it to whoever asked.`,
  }
}

/** What a callee gets back when its message to the agent that asked it
 *  was passed into that agent's conversation (#1100). */
export function replyBody(taskId: string, caller: string): Record<string, unknown> {
  return {
    accepted: true,
    status: "delivered",
    taskId,
    agent: caller,
    note: `Passed to ${caller} in the conversation it asked you from (task ${taskId}). Do not send it again.`,
  }
}

export interface DelegationWiring {
  config: DaemonConfig
  registry: AgentRegistry
  router: MessageRouter
  mesh: () => A2AMesh | undefined
  log: (msg: string) => void
  /** Phone-app replies waiting for the dashboard (GET /a2a/delegations/<id>/reply). */
  replies: CallbackReplies
  /** The jobs database, opened before the manager is built: the hand-off
   *  journal lives there (#1861). Null: memory only, with a loud warning. */
  db: Database.Database | null
  /** The daemon's folder: a leftover old delegation log is looked for
   *  under it, imported once and renamed (#1961). */
  baseDir?: string
  /** Put a callback turn in the intent ledger, so the activity map can
   *  draw it as the answer returning to the caller (#267). */
  recordDispatch?: (agentId: string, context: Record<string, unknown>, message: string, senderAgentId: string) =>
    { eventId: string; decidedBy: string } | undefined
  /** Open requests (#356) follow delegations through these. */
  onStarted?: DelegationDeps["onStarted"]
  onDone?: DelegationDeps["onDone"]
  callbackNote?: DelegationDeps["callbackNote"]
  onRelayFailed?: DelegationDeps["onRelayFailed"]
}

/** Where a message for `channel` goes on this machine: its own adapter,
 *  or a push notification for a channel with no adapter of its own. */
function routeFor(router: MessageRouter, channel: string): { channel: string; chatId?: string } | null {
  if (router.getChannel(channel)) return { channel }
  if (PUSH_FALLBACK_CHANNELS.has(channel) && router.getChannel("push")) return { channel: "push", chatId: "default" }
  return null
}

/** Can a message on this channel reach the person from this machine? */
export function canDeliverToChat(router: MessageRouter, channel: string): boolean {
  return channel === "app" || routeFor(router, channel) !== null
}

/** A message for a person's chat that no turn in that chat produced: a
 *  delegation's callback reply, or a schedule's result or failure (#738). */
export interface ChatDelivery {
  channel: string
  chatId: string
  text: string
  /** Absent when no agent is named (an unnamed /mesh/task async request):
   *  nothing is recorded in a session then. */
  agentId?: string
  accountId?: string
  /** Also add the text to the agent's session for that chat. */
  record: boolean
  /** Unique per message: the phone files the reply under it once. */
  taskId: string
  outcome: "done" | "error"
  /** Passed to the router so a repeat send of the same message is dropped. */
  idempotencyKey?: string
  /** The bus event's summary for a phone reply. No reply text: it reaches the mesh feed. */
  summary?: string
  /** An agent's answer in the conversation itself (#1892). Default false:
   *  cron results, alerts and notices do not use up a goodbye. */
  countsAsReply?: boolean
}

/**
 * Send a message to a person's chat on any channel this machine knows,
 * including the two with no outbound adapter: the phone app (held in
 * CallbackReplies and announced on the bus) and voice (a push
 * notification). Throws when the channel can't be reached here.
 */
export async function deliverToChat(
  w: Pick<DelegationWiring, "config" | "registry" | "router" | "replies">,
  msg: ChatDelivery,
): Promise<void> {
  if (msg.channel === "app") {
    // The phone app keeps its own thread in the dashboard's chat store.
    // Hold the reply here and say so on the bus; the dashboard (which
    // sees peers' events through the feed) fetches it and files it in
    // the conversation, unread, with its finish notification.
    if (msg.record && msg.agentId) {
      try { w.registry.getSessionStore().addAgentMessage(msg.agentId, msg.channel, msg.chatId, msg.text) } catch { /* the thread still gets it */ }
    }
    const reply = w.replies.put({
      taskId: msg.taskId,
      channel: msg.channel,
      chatId: msg.chatId,
      agent: msg.agentId ?? "",
      text: msg.text,
      status: msg.outcome,
      plain: !!msg.agentId && w.config.agents[msg.agentId]?.richMessages === false,
    })
    getEventBus().publish({
      kind: CALLBACK_REPLY_KIND,
      type: CALLBACK_REPLY_TYPE,
      agentId: msg.agentId ?? "",
      // No reply text here: events reach the mesh feed; the text stays behind
      // the mesh-gated GET /a2a/delegations/<id>/reply.
      summary: msg.summary ?? `${msg.agentId ?? "An agent"} replied after a delegation (${msg.outcome})`,
      ref: reply.taskId,
    })
    return
  }
  const r = routeFor(w.router, msg.channel)
  if (!r) throw new Error(`no channel "${msg.channel}" on this machine`)
  const dedupe = msg.idempotencyKey !== undefined ? { idempotencyKey: msg.idempotencyKey } : {}
  if (r.channel === msg.channel) {
    await w.router.sendOutbound(
      { channel: msg.channel, chatId: msg.chatId, text: msg.text, agentId: msg.agentId, accountId: msg.accountId },
      { recordInSession: msg.record, countsAsReply: msg.countsAsReply === true, ...dedupe },
    )
    return
  }
  // A push is a notification about the chat, not a message in it. The full
  // text goes in the agent's session for that chat, so the next turn there
  // can read out what the push had to cut.
  if (msg.record && msg.agentId) {
    try { w.registry.getSessionStore().addAgentMessage(msg.agentId, msg.channel, msg.chatId, msg.text) } catch { /* the push still goes */ }
  }
  const name = (msg.agentId && w.config.agents[msg.agentId]?.name) || msg.agentId || "AgentX"
  await w.router.sendOutbound(
    { channel: r.channel, chatId: r.chatId || "default", text: `${name}: ${pushPreview(msg.text)}` },
    { recordInSession: false, ...dedupe },
  )
}

/** Send a schedule's answer to the chat its `notify` names; nothing when it names none. */
export async function deliverCronResult(
  w: Pick<DelegationWiring, "config" | "registry" | "router" | "replies">,
  dest: { channel: string; chatId: string; accountId?: string } | undefined,
  run: { jobId: string; agent: string; text: string; runId: string },
): Promise<void> {
  if (!dest) return
  await deliverToChat(w, {
    channel: dest.channel,
    chatId: dest.chatId,
    accountId: dest.accountId,
    agentId: run.agent,
    text: run.text,
    record: true,
    // One message per run: the phone files it once, the router drops a
    // repeat. No "/" so it stays one segment of the reply URL.
    taskId: `cron:${run.runId.replace(/\//g, ":")}`,
    idempotencyKey: run.runId,
    outcome: "done",
    summary: `Cron "${run.jobId}" result`,
  })
}

/** Longest text a push carries; a phone shows a few lines of it anyway. */
export const PUSH_PREVIEW_MAX = 500

/** A long answer, cut to fit a notification, saying where the rest is. */
export function pushPreview(text: string): string {
  const chars = [...text]
  if (chars.length <= PUSH_PREVIEW_MAX) return text
  return `${chars.slice(0, PUSH_PREVIEW_MAX).join("").trimEnd()}… (shortened; ask the agent for the full answer)`
}

/** The old delegation log, under the daemon's folder. No longer written
 *  (#1961): a node that still has one imports it once at start, then it
 *  is renamed to `delegations.jsonl.imported`. */
export const DELEGATION_LOG = ".agentx/a2a/delegations.jsonl"

export function createDelegations(w: DelegationWiring): DelegationManager {
  const cfg = w.config.mesh.delegation
  const store = handoffStoreFor(w.db, w.log)
  // Before the manager reads the table back. Without the table (memory
  // only), a leftover file is left where it is for a start that has one.
  if (store) importDelegationLog(store, resolve(w.baseDir ?? process.cwd(), DELEGATION_LOG), w.log)
  return new DelegationManager({
    timeoutMs: cfg.timeoutMinutes * 60_000,
    asyncWhenHuman: cfg.asyncWhenHuman,
    requeueRelayOnRestart: cfg.requeueRelayOnRestart,
    coalesceMs: cfg.coalesceSeconds * 1000,
    // The hand-off journal is the table (#1861); no file is written (#1961).
    store,
    log: w.log,
    onStarted: w.onStarted,
    onDone: w.onDone,
    callbackNote: w.callbackNote,
    onRelayFailed: w.onRelayFailed,
    // A sender's last ended send stays its next send's session as long as
    // any chat session lives (session.staleMinutes).
    senderKeyMs: w.config.session.staleMinutes * 60_000,
    // A continue row keeps its key as long as the job wake's grace (#2042).
    continueJoinMs: (w.config.requests?.jobs?.wake?.graceMinutes ?? DEFAULT_WAKE_SETTINGS.graceMinutes) * 60_000,
    // A none row of a named local sender (#2007 C7): one notice on its next
    // run, or a run of its own after NOTICE_HOLD_MS. No new mechanism.
    notify: (rec, result) => {
      if (!w.registry.getAgent(rec.caller)) return
      const waiting = w.registry.notices.add(rec.caller, rec.callee, noneNotice(rec, result))
      w.log(`[delegation ${rec.id}] ${rec.caller} told with a notice (${result.status}; ${waiting} waiting)`)
    },
    runLocal: (callee, message, context, opts) => w.registry.execute({
      agentId: callee,
      message,
      context: context as any,
      // A follow-up on the same home continues that run's session (#1100).
      freshSession: !(opts.resumeFrom && continueSession(w.registry.getSessionStore(), callee, opts.resumeFrom, {
        channel: String((context as any).channel ?? "a2a"),
        chatId: String((context as any).chatId ?? ""),
      })),
      timeoutMinutes: Math.ceil(opts.timeoutMs / 60_000),
      onStart: opts.onStart,
      ...(opts.slotWaitMs ? { slotWaitMs: opts.slotWaitMs } : {}),
      ...(opts.extras?.intentRef ? { intentRef: opts.extras.intentRef as { eventId: string; decidedBy: string } } : {}),
    }),
    runPeer: (peer, callee, message, context, opts) => {
      // The peer cannot check a person's limit (ids are per machine).
      const refusal = w.registry.refusalFor(callee, context)
      if (refusal) return Promise.resolve(refusal)
      const mesh = w.mesh()
      if (!mesh) return Promise.reject(new Error("mesh not enabled"))
      return mesh.sendTask(peer, message, callee, { context, senderAgentId: opts.senderAgentId, timeoutMs: opts.timeoutMs })
    },
    cancelLocal: (runId, reason) => { w.registry.cancelRunningTask(runId, reason) },
    injectTurn: (turn) => {
      const from = (turn.context.delegation as { from?: unknown } | undefined)?.from
      const intentRef = typeof from === "string" ? w.recordDispatch?.(turn.agentId, turn.context, turn.message, from) : undefined
      return w.registry.execute({ agentId: turn.agentId, message: turn.message, context: turn.context as any, ...(intentRef ? { intentRef } : {}) })
    },
    isChatBusy: (agentId, channel, chatId) => w.registry.isChatBusy(agentId, channel, chatId),
    canDeliver: (channel) => canDeliverToChat(w.router, channel),
    deliver: (msg) => deliverToChat(w, msg),
  })
}
