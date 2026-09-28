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

import { resolve } from "path"
import type { IncomingMessage as HttpRequest } from "http"
import { DelegationManager, type CallerTurn } from "@/a2a/delegation"
import type { AgentRegistry } from "@/agents/registry"
import type { A2AMesh } from "@/a2a/mesh"
import type { MessageRouter } from "@/channels/router"
import type { DaemonConfig } from "./config"
import { isLoopback } from "./mesh-auth"

/** Channels with no adapter of their own whose person has the phone app:
 *  a callback reply reaches them as a push notification. */
const PUSH_FALLBACK_CHANNELS = new Set(["app", "voice", "dashboard"])

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
 *  certainty. Null means "delegate synchronously", today's behaviour. */
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
  if (!agentId) return null
  const turn = registry.findRunningTurn(agentId, hint.callerChannel && hint.callerChatId
    ? { channel: hint.callerChannel, chatId: hint.callerChatId }
    : {})
  return turn ? { agentId, taskId: turn.taskId, context: turn.context as Record<string, unknown> } : null
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
  baseDir?: string
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
    injectTurn: (turn) => w.registry.execute({ agentId: turn.agentId, message: turn.message, context: turn.context as any }),
    isChatBusy: (agentId, channel, chatId) => w.registry.isChatBusy(agentId, channel, chatId),
    canDeliver: (channel) => route(channel) !== null,
    deliver: async (msg) => {
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
