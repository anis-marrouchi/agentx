// --- Sub-Agent Spawning ---
//
// Allows agents to spawn background sub-agents from within a conversation.
// Sub-agents run in their own session and report results back to the parent.
//
// Use cases:
// - Parallel research (spawn 3 workers to investigate different aspects)
// - Long-running background tasks (spawn worker, continue conversation)
// - Orchestrator patterns (one agent coordinates many)

import type { AgentRegistry } from "./registry"
import type { AgentTask, AgentResponse } from "./runtime"

export interface SubAgentRequest {
  /** ID of the agent to spawn as sub-agent */
  targetAgentId: string
  /** Task prompt for the sub-agent */
  prompt: string
  /** ID of the parent agent that initiated the spawn */
  parentAgentId: string
  /** Channel where results should be announced */
  announceChannel?: string
  /** Chat ID where results should be announced */
  announceChatId?: string
  /** Whether to wait for completion or fire-and-forget */
  blocking?: boolean
  /** Timeout in ms (default: 5 minutes) */
  timeout?: number
}

export interface SubAgentResult {
  /** ID assigned to this sub-agent run */
  runId: string
  /** Target agent that was spawned */
  targetAgentId: string
  /** Whether the run completed successfully */
  success: boolean
  /** Response content from the sub-agent */
  content: string
  /** Error if any */
  error?: string
  /** Duration in ms */
  duration: number
}

interface ActiveRun {
  request: SubAgentRequest
  runId: string
  startedAt: number
  resolve?: (result: SubAgentResult) => void
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000 // 5 minutes
const MAX_DEPTH = 3                     // Prevent infinite spawning chains

/**
 * Manages sub-agent spawning and lifecycle.
 */
export class SubAgentManager {
  private registry: AgentRegistry
  private activeRuns: Map<string, ActiveRun> = new Map()
  private runCounter = 0
  private log: (...args: unknown[]) => void
  /** Track spawn depth to prevent infinite chains */
  private depthMap: Map<string, number> = new Map()

  constructor(
    registry: AgentRegistry,
    log: (...args: unknown[]) => void = console.error.bind(console, "[subagent]"),
  ) {
    this.registry = registry
    this.log = log
  }

  /**
   * Spawn a sub-agent. Returns immediately with a runId if non-blocking,
   * or waits for completion if blocking.
   */
  async spawn(request: SubAgentRequest): Promise<SubAgentResult> {
    // Check depth to prevent infinite spawning
    const parentDepth = this.depthMap.get(request.parentAgentId) || 0
    if (parentDepth >= MAX_DEPTH) {
      return {
        runId: "",
        targetAgentId: request.targetAgentId,
        success: false,
        content: "",
        error: `Sub-agent spawn depth exceeded (max: ${MAX_DEPTH}). Cannot spawn "${request.targetAgentId}" from "${request.parentAgentId}".`,
        duration: 0,
      }
    }

    const runId = `sub-${++this.runCounter}-${Date.now().toString(36)}`
    const run: ActiveRun = {
      request,
      runId,
      startedAt: Date.now(),
    }

    this.activeRuns.set(runId, run)
    this.depthMap.set(request.targetAgentId, parentDepth + 1)

    this.log(
      `Spawning sub-agent: ${request.targetAgentId} (parent: ${request.parentAgentId}, ` +
      `depth: ${parentDepth + 1}, blocking: ${request.blocking ?? false})`,
    )

    const task: AgentTask = {
      message: this.buildSubAgentPrompt(request),
      agentId: request.targetAgentId,
      context: {
        channel: "subagent",
        sender: `agent:${request.parentAgentId}`,
        chatId: `subagent:${runId}`,
      },
    }

    const timeout = request.timeout ?? DEFAULT_TIMEOUT

    try {
      const response = await Promise.race([
        this.registry.execute(task),
        this.timeoutPromise(timeout, request.targetAgentId),
      ])

      const result: SubAgentResult = {
        runId,
        targetAgentId: request.targetAgentId,
        success: !response.error,
        content: response.content,
        error: response.error,
        duration: Date.now() - run.startedAt,
      }

      this.log(
        `Sub-agent ${request.targetAgentId} completed in ${result.duration}ms ` +
        `(${result.success ? "success" : "error"})`,
      )

      return result
    } catch (error: any) {
      return {
        runId,
        targetAgentId: request.targetAgentId,
        success: false,
        content: "",
        error: error.message,
        duration: Date.now() - run.startedAt,
      }
    } finally {
      this.activeRuns.delete(runId)
      this.depthMap.delete(request.targetAgentId)
    }
  }

  /**
   * Spawn multiple sub-agents in parallel.
   */
  async spawnParallel(requests: SubAgentRequest[]): Promise<SubAgentResult[]> {
    return Promise.all(requests.map((req) => this.spawn(req)))
  }

  /**
   * List active sub-agent runs.
   */
  listActive(): Array<{
    runId: string
    targetAgentId: string
    parentAgentId: string
    duration: number
  }> {
    return Array.from(this.activeRuns.values()).map((run) => ({
      runId: run.runId,
      targetAgentId: run.request.targetAgentId,
      parentAgentId: run.request.parentAgentId,
      duration: Date.now() - run.startedAt,
    }))
  }

  private buildSubAgentPrompt(request: SubAgentRequest): string {
    return [
      `[Sub-agent task from ${request.parentAgentId}]`,
      `You have been spawned as a background sub-agent to handle a specific task.`,
      `Focus on completing the task below and provide a clear, actionable response.`,
      ``,
      request.prompt,
    ].join("\n")
  }

  private timeoutPromise(ms: number, agentId: string): Promise<AgentResponse> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Sub-agent "${agentId}" timed out after ${Math.round(ms / 1000)}s`))
      }, ms)
    })
  }
}
