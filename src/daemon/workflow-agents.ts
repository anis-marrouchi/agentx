import type { AgentRegistry } from "@/agents/registry"
import type { AgentExecuteRequest, AgentExecuteResponse } from "@/workflows/nodes/types"

/**
 * Agent-execute shim for the `agent` node handler and the follow-up nudge.
 * Awaits AgentRegistry inside the walk loop — the walk itself runs in a
 * background async context detached from the webhook response, so
 * long-running agent calls don't block webhook delivery.
 */
export function workflowAgents(registry: Pick<AgentRegistry, "execute">): { execute(req: AgentExecuteRequest): Promise<AgentExecuteResponse> } {
  return {
    execute: async (req: AgentExecuteRequest): Promise<AgentExecuteResponse> => {
      const start = Date.now()
      try {
        // Scope each workflow run to its own session bucket so concurrent
        // runs of the same workflow (or even different workflows hitting
        // the same agent) don't collide in api:default. Without this,
        // every workflow turn for `coder-agent` ends up in
        // `coder-agent:api:default:<day>.json` regardless of which run
        // produced it — bleeding context across runs and breaking the
        // single-conversation guarantee per workflow run.
        const wfChatId = req.workflowRunId ? `workflow:${req.workflowRunId}` : "workflow:adhoc"
        let runTaskId: string | undefined
        const resp = await registry.execute({
          agentId: req.agentId,
          message: req.message,
          workflowRunId: req.workflowRunId,
          ...(req.workflowId ? { workflowId: req.workflowId } : {}),
          timeoutMinutes: req.timeoutMinutes,
          autonomy: req.autonomy,
          context: {
            channel: "workflow",
            chatId: wfChatId,
            sender: "workflow",
            // The step's issue or merge request (#2084): one run of the
            // agent at a time on it, whatever started the others.
            ...(req.home ? { home: req.home } : {}),
            // A step a person waits on (#2334): the /send/agent rule.
            ...(req.priority === "critical" ? { admissionPriority: "critical" } : {}),
          },
          // A stop signal names this id; the paused step keeps it (#870).
          onStart: (id) => { runTaskId = id; req.onStarted?.() },
          // The step's queue limit and held notice (#2334).
          ...(req.signal ? { callerSignal: req.signal } : {}),
          ...(req.onHeld ? { onHeld: req.onHeld, heldNoticeMs: req.heldNoticeMs } : {}),
        })
        return {
          content: resp.content ?? "",
          error: resp.error,
          errorKind: resp.errorKind,
          autonomyBlocks: resp.autonomyBlocks,
          taskId: `wf-${req.workflowRunId ?? "na"}-${start.toString(36)}`,
          ...(runTaskId ? { runTaskId } : {}),
          durationMs: Date.now() - start,
        }
      } catch (e: any) {
        return { content: "", error: e.message }
      }
    },
  }
}
