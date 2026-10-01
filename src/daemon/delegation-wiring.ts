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
import { DelegationManager, type CallerTurn, type DelegationDeps } from "@/a2a/delegation"
import type { RootInitiator } from "@/a2a/initiator"
import type { AgentRegistry } from "@/agents/registry"
import type { A2AMesh } from "@/a2a/mesh"
import type { MessageRouter } from "@/channels/router"
import type { DaemonConfig } from "./config"
import { isLoopback } from "./mesh-auth"
import { getEventBus } from "@/events/bus"

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
 * Synchronous delegations running on this node: which turn waits on which
 * callee run. Used only to refuse a delegation that could never be
 * answered (a cycle back into a turn that is itself waiting).
 */
export class SyncWaits {
  /** callee run id → the caller turn waiting on it */
  private waitingOn = new Map<string, string>()

  begin(callerTaskId: string, calleeRunId: string): void {
    this.waitingOn.set(calleeRunId, callerTaskId)
  }

  end(calleeRunId: string): void {
    this.waitingOn.delete(calleeRunId)
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
export function acceptedBody(taskId: string, callee: string, peer?: string): Record<string, unknown> {
  const who = peer ? `${callee} on ${peer}` : callee
  return {
    accepted: true,
    mode: "callback",
    taskId,
    agent: callee,
    ...(peer ? { peer } : {}),
    note:
      `Delegated to ${who} (task ${taskId}). Their answer will reach you as a new message in this conversation. ` +
      `Tell the person who you asked and why, then end your turn. Do not wait or poll for the result.`,
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
  baseDir?: string
  /** Put a callback turn in the intent ledger, so the activity map can
   *  draw it as the answer returning to the caller (#267). */
  recordDispatch?: (agentId: string, context: Record<string, unknown>, message: string, senderAgentId: string) =>
    { eventId: string; decidedBy: string } | undefined
  /** Open requests (#356) follow delegations through these. */
  onStarted?: DelegationDeps["onStarted"]
  onDone?: DelegationDeps["onDone"]
}

export function createDelegations(w: DelegationWiring): DelegationManager {
  const cfg = w.config.mesh.delegation
  const route = (channel: string): { channel: string; chatId?: string } | null => {
    if (w.router.getChannel(channel)) return { channel }
    if (PUSH_FALLBACK_CHANNELS.has(channel) && w.router.getChannel("push")) return { channel: "push", chatId: "default" }
    return null
  }
  return new DelegationManager({
    timeoutMs: cfg.timeoutMinutes * 60_000,
    asyncWhenHuman: cfg.asyncWhenHuman,
    logPath: resolve(w.baseDir ?? process.cwd(), ".agentx/a2a/delegations.jsonl"),
    log: w.log,
    onStarted: w.onStarted,
    onDone: w.onDone,
    runLocal: (callee, message, context, opts) => w.registry.execute({
      agentId: callee,
      message,
      context: context as any,
      freshSession: true,
      timeoutMinutes: Math.ceil(opts.timeoutMs / 60_000),
      onStart: opts.onStart,
      ...(opts.extras?.intentRef ? { intentRef: opts.extras.intentRef as { eventId: string; decidedBy: string } } : {}),
    }),
    runPeer: (peer, callee, message, context, opts) => {
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
    canDeliver: (channel) => channel === "app" || route(channel) !== null,
    deliver: async (msg) => {
      if (msg.channel === "app") {
        // The phone app keeps its own thread in the dashboard's chat store.
        // Hold the reply here and say so on the bus; the dashboard (which
        // sees peers' events through the feed) fetches it and files it in
        // the conversation, unread, with its finish notification.
        if (msg.record) {
          try { w.registry.getSessionStore().addAgentMessage(msg.agentId, msg.channel, msg.chatId, msg.text) } catch { /* the thread still gets it */ }
        }
        const reply = w.replies.put({
          taskId: msg.taskId,
          channel: msg.channel,
          chatId: msg.chatId,
          agent: msg.agentId,
          text: msg.text,
          status: msg.outcome,
          plain: w.config.agents[msg.agentId]?.richMessages === false,
        })
        getEventBus().publish({
          kind: CALLBACK_REPLY_KIND,
          type: CALLBACK_REPLY_TYPE,
          agentId: msg.agentId,
          // No reply text here: events reach the mesh feed; the text stays behind
          // the mesh-gated GET /a2a/delegations/<id>/reply.
          summary: `${msg.agentId} replied after a delegation (${msg.outcome})`,
          ref: reply.taskId,
        })
        return
      }
      const r = route(msg.channel)
      if (!r) throw new Error(`no channel "${msg.channel}" on this machine`)
      if (r.channel === msg.channel) {
        await w.router.sendOutbound(
          { channel: msg.channel, chatId: msg.chatId, text: msg.text, agentId: msg.agentId, accountId: msg.accountId },
          { recordInSession: msg.record },
        )
        return
      }
      // A push is a notification about the chat, not a message in it; the
      // reply is already in the agent's session for the next turn there.
      const name = w.config.agents[msg.agentId]?.name || msg.agentId
      await w.router.sendOutbound(
        { channel: r.channel, chatId: r.chatId || "default", text: `${name}: ${msg.text}` },
        { recordInSession: false },
      )
    },
  })
}
