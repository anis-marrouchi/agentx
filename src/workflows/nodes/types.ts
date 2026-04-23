import type { Workflow, WorkflowNode, WorkflowRun } from "../types"

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
  /** Structured log sink. */
  log: (msg: string) => void
}

export interface NodeResult {
  /** Output bundle keyed under ctx.run.context[node.id] by the dispatcher. */
  output?: Record<string, unknown>
  /** For branch nodes: which outgoing port fired (case's `to` field or
   *  `default` port). Undefined for non-branch nodes. */
  port?: string
  /** True when the node paused the run (checkpoint). Dispatcher stops the
   *  walk and parks the run until a matching event arrives. */
  paused?: boolean
  pausedAt?: { nodeId: string; checkpointName: string; resumeMatch: Record<string, unknown> }
  /** On failure, a short message. Dispatcher logs it + marks the run failed. */
  error?: string
}

export type NodeHandler = (ctx: NodeContext) => Promise<NodeResult>
