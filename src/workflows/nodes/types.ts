import type { ActorStore } from "../../actors/store"
import type { TaskStore } from "../task-store"
import type { PausedAt, Workflow, WorkflowNode, WorkflowRun } from "../types"

// --- Node handler interface ---
//
// Each node type registers a handler that executes the node given the live
// run context. Handlers are awaited inside the dispatcher's walk loop; they
// are NOT on the webhook-response critical path, so taking tens of seconds
// (e.g. for an agent call) is fine.
//
// Handlers return one of three shapes:
//   - ok: { output }             — node produced data, carry on
//   - ok with port: { output, port } — branch nodes: which outgoing port fired
//   - paused: { paused: true, pausedAt } — checkpoint nodes (Phase 2)
//   - failed: { error }          — log + fail the run

export interface AgentExecuteRequest {
  agentId: string
  message: string
  workflowRunId?: string
  timeoutMinutes?: number
}

export interface AgentExecuteResponse {
  content: string
  error?: string
  taskId?: string
  durationMs?: number
}

export interface NodeContext {
  workflow: Workflow
  run: WorkflowRun
  node: WorkflowNode
  /** Live channel adapter instances keyed by name (gitlab/github/telegram/...).
   *  Handlers narrow to the method they need. */
  channels: Record<string, unknown>
  /** Thin agent-execute shim around AgentRegistry.execute(). */
  agents: { execute(req: AgentExecuteRequest): Promise<AgentExecuteResponse> }
  /** Actor + role resolver. Required for userTask handlers; optional for
   *  legacy handlers so tests don't need to stub it. */
  actors?: ActorStore
  /** Open user-task store — written to by userTask handler on pause. */
  tasks?: TaskStore
  /** Outbound mesh forwarder — used by `action.send` to deliver to a channel
   *  hosted on a peer node (e.g. workflow on macbook, whatsapp on
   *  clawd-server). Optional; absent in single-node setups and tests. */
  forwardChannelSend?: (payload: {
    channel: string
    chatId: string
    text: string
    accountId?: string
    parseMode?: string
    replyTo?: string
  }) => Promise<{ messageId: string | null }>
  /** Structured log sink. */
  log: (msg: string) => void
}

export interface NodeResult {
  /** Output bundle keyed under ctx.run.context[node.id] by the dispatcher. */
  output?: Record<string, unknown>
  /** For branch nodes: which outgoing port fired (case's `to` field or
   *  `default` port). Undefined for non-branch nodes. */
  port?: string
  /** True when the node paused the run (checkpoint, userTask, subProcess,
   *  signalWait, timerWait). Dispatcher stops the walk and parks the run
   *  until a matching event arrives. */
  paused?: boolean
  pausedAt?: PausedAt
  /** Optional actor ids who should see this task right now (userTask only). */
  assignedTo?: string[]
  /** Child workflow id + run id (subProcess only). The dispatcher spawns
   *  the child before parking the parent. */
  spawnChild?: { workflowId: string; input: Record<string, unknown> }
  /** Signal emission produced by a signal.emit node, posted to the bus
   *  before walk continues. */
  emitSignal?: { name: string; scope: "workflow" | "global"; payload: Record<string, unknown> }
  /** On failure, a short message. Dispatcher logs it + marks the run failed. */
  error?: string
}

export type NodeHandler = (ctx: NodeContext) => Promise<NodeResult>
