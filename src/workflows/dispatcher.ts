import { evaluateBranch, findNode, initialPendingFromTrigger, nextNodes } from "./engine"
import { resolveHandler } from "./nodes/handlers"
import type { AgentExecuteRequest, AgentExecuteResponse } from "./nodes/types"
import { RunStore, idempotencyKey } from "./run-store"
import type { WorkflowStore } from "./store"
import type { EntityRef, NodeExecutionEntry, Workflow, WorkflowRun } from "./types"

// --- Dispatcher (V2) ---
//
// Entry point called by the hook layer. Given a triggering event:
//
//   1. Find workflows whose trigger filter matches.
//   2. For each match, resolve or create a run keyed by the event's entityRef.
//   3. If the run's home node is a remote peer, forward via mesh.
//   4. Locally: seed the trigger node's output into run.context, then
//      walk the DAG — execute each pending node's handler, fold the output
//      into run.context, enqueue successors, loop until pending is empty
//      or a handler paused / failed the run.
//
// All side effects (adapter calls, agent dispatch) happen inside node
// handlers. This module only orchestrates.

export interface MeshForwarder {
  forwardTransition(peer: string, payload: { workflowId: string; event: TriggerEvent; entityRef: EntityRef }): Promise<void>
}

export interface TriggerEvent {
  /** Stable event id — used by idempotency keys so retried webhooks
   *  collapse into the same node execution. */
  id: string
  /** Output bundle produced by the trigger node. Hooks build this from
   *  the raw channel payload. Goes directly into `run.context[triggerId]`. */
  payload: Record<string, unknown>
}

export interface DispatcherOptions {
  store: WorkflowStore
  runs: RunStore
  nodeId: string
  forwarder?: MeshForwarder
  channels: Record<string, unknown>
  agents: { execute(req: AgentExecuteRequest): Promise<AgentExecuteResponse> }
  log?: (msg: string) => void
}

export class WorkflowDispatcher {
  private readonly store: WorkflowStore
  private readonly runs: RunStore
  private readonly nodeId: string
  private readonly forwarder?: MeshForwarder
  private readonly channels: Record<string, unknown>
  private readonly agents: { execute(req: AgentExecuteRequest): Promise<AgentExecuteResponse> }
  private readonly log: (msg: string) => void

  constructor(opts: DispatcherOptions) {
    this.store = opts.store
    this.runs = opts.runs
    this.nodeId = opts.nodeId
    this.forwarder = opts.forwarder
    this.channels = opts.channels
    this.agents = opts.agents
    this.log = opts.log ?? (() => {})
  }

  /** Main entry. The hook subscribers map channel events into this shape.
   *  `claimed` lists workflows that are actively handling this event for the
   *  entity — newly created, resumed, forwarded to a remote home, or dropped
   *  as a concurrent duplicate of a running run. The pre:channel-message hook
   *  uses this to suppress the router's default reply so the workflow owns
   *  the conversation (no double-send). A paused run whose resumeMatch didn't
   *  accept the event is deliberately NOT claimed, so unrelated chatter flows
   *  through the default agent while the workflow waits for the signal it
   *  cares about. */
  async dispatch(args: {
    trigger: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] }
    entityRef: EntityRef
    event: TriggerEvent
  }): Promise<{ claimed: Workflow[]; runs: WorkflowRun[] }> {
    const matches = this.matchByTrigger(args.trigger)
    if (!matches.length) return { claimed: [], runs: [] }

    const willFan = matches.some((m) => m.fanOut)
    const toRun = willFan ? matches : [matches[0]]
    const claimed: Workflow[] = []
    const runs: WorkflowRun[] = []
    for (const wf of toRun) {
      const r = await this.dispatchOne(wf, args.entityRef, args.event, args.trigger)
      if (r.claimed) claimed.push(wf)
      if (r.run) runs.push(r.run)
    }
    return { claimed, runs }
  }

  private matchByTrigger(t: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] }): Workflow[] {
    const all = this.store.list()
    const out: Workflow[] = []
    for (const wf of all) {
      const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
      if (!trigger) continue
      const cfg = trigger.config as {
        source?: string
        filter?: { project?: string; repo?: string; chat?: string; labels?: string[]; fromJid?: string }
      }
      if (cfg.source !== t.source) continue
      const f = cfg.filter
      if (f) {
        if (f.project && f.project !== "*" && f.project !== t.project) continue
        if (f.repo && f.repo !== "*" && f.repo !== t.repo) continue
        if (f.chat && f.chat !== "*" && f.chat !== t.chat) continue
        if (f.labels?.length) {
          const have = new Set(t.labels ?? [])
          const hit = f.labels.some((l) => have.has(l))
          if (!hit) continue
        }
      }
      out.push(wf)
    }
    return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }

  private async dispatchOne(
    workflow: Workflow,
    entityRef: EntityRef,
    event: TriggerEvent,
    trigger: { source: string; project?: string; repo?: string; chat?: string; labels?: string[] },
  ): Promise<{ claimed: boolean; run: WorkflowRun | null }> {
    const activeRunId = this.runs.getActiveByEntity(entityRef)
    const homeNode = activeRunId ? this.runs.getHomeNodeByEntity(entityRef) : null

    // Remote home node — forward via mesh and bail. The remote owns the
    // conversation, so we still claim the event locally (no default reply).
    if (activeRunId && homeNode && homeNode !== this.nodeId) {
      if (!this.forwarder) {
        this.log(`[workflow:${workflow.id}] run ${activeRunId} home'd on "${homeNode}" but no forwarder — dropping`)
        return { claimed: false, run: null }
      }
      try {
        await this.forwarder.forwardTransition(homeNode, { workflowId: workflow.id, event, entityRef })
      } catch (e: any) {
        this.log(`[workflow:${workflow.id}] forward to "${homeNode}" failed: ${e.message}`)
      }
      return { claimed: true, run: null }
    }

    let run = activeRunId ? this.runs.get(activeRunId) : null
    if (!run) {
      // New entity → create a run, seed trigger context, enqueue trigger's successors.
      const init = initialPendingFromTrigger(workflow)
      if (!init) { this.log(`[workflow:${workflow.id}] no trigger node found`); return { claimed: false, run: null } }
      run = this.runs.create({
        workflowId: workflow.id,
        initialPending: init.pending,
        entityRef,
        initialContext: { [init.triggerId]: event.payload },
      })
      this.log(`[workflow:${workflow.id}] run ${run.id} created from trigger "${init.triggerId}" for ${entityRef.id}`)
    } else if (run.status === "paused" && run.pausedAt) {
      // Resume path: a matching event arrived for a paused run. Check the
      // checkpoint's resumeMatch against the incoming event's trigger
      // fields (source, project, repo, chat, labels). On match, unpause
      // and seed the event as the checkpoint node's output.
      if (!matchesResume(run.pausedAt.resumeMatch, trigger, event)) {
        this.log(`[workflow:${workflow.id}] run ${run.id} paused but event doesn't match resumeMatch — dropping`)
        return { claimed: false, run: null }
      }
      const checkpointNode = findNode(workflow, run.pausedAt.nodeId)
      const successors = checkpointNode
        ? workflow.edges.filter((e) => e.from === checkpointNode.id).map((e) => e.to)
        : []
      const resumeEntry = {
        at: new Date().toISOString(),
        nodeId: run.pausedAt.nodeId,
        inputKeys: [],
        status: "resumed" as const,
        output: { event: event.payload },
        idempotencyKey: idempotencyKey(run.id, run.pausedAt.nodeId, `resume:${event.id}`),
      }
      const newContext: Record<string, Record<string, unknown>> = {
        ...run.context,
        [run.pausedAt.nodeId]: { event: event.payload },
      }
      const updated = this.runs.recordExecution({
        runId: run.id,
        entry: resumeEntry,
        nextPending: successors,
        status: "running",
        pausedAt: null,
        context: newContext,
      })
      if (updated) run = updated
      this.log(`[workflow:${workflow.id}] run ${run.id} resumed from checkpoint "${run.pausedAt?.checkpointName ?? "?"}"`)
    } else if (run.status === "running") {
      // Concurrent message on an already-running run. v1 policy: drop —
      // but still claim the event so the router doesn't ALSO reply.
      this.log(`[workflow:${workflow.id}] run ${run.id} already running; dropping concurrent event ${event.id}`)
      return { claimed: true, run: null }
    } else {
      // completed / failed / canceled — dead run. The filter matched but
      // this conversation's workflow is over, so let default routing handle.
      this.log(`[workflow:${workflow.id}] run ${run.id} is ${run.status}; dropping event ${event.id}`)
      return { claimed: false, run: null }
    }

    // Background walk — the dispatch call already returned 200 to the
    // webhook source. Agent calls inside the walk can take minutes.
    void this.walk(workflow, run.id, event.id)
    return { claimed: true, run }
  }

  /** Execute the pending queue until empty, paused, or failed. */
  private async walk(workflow: Workflow, runId: string, triggeringEventId: string): Promise<void> {
    let run = this.runs.get(runId)
    if (!run) return

    while (run.status === "running" && run.pending.length > 0) {
      const nodeId: string = run.pending[0]
      const remaining: string[] = run.pending.slice(1)
      const node = findNode(workflow, nodeId)
      if (!node) {
        this.log(`[workflow:${workflow.id}] missing node "${nodeId}" — marking run failed`)
        this.runs.recordExecution({
          runId: run.id,
          entry: {
            at: new Date().toISOString(),
            nodeId,
            inputKeys: [],
            status: "failed",
            idempotencyKey: idempotencyKey(run.id, nodeId, triggeringEventId),
            note: "node definition missing from workflow",
          },
          nextPending: remaining,
          status: "failed",
        })
        return
      }

      const handler = resolveHandler(node.type)
      if (!handler) {
        this.log(`[workflow:${workflow.id}] no handler for node type "${node.type}"`)
        this.runs.recordExecution({
          runId: run.id,
          entry: {
            at: new Date().toISOString(),
            nodeId,
            inputKeys: [],
            status: "failed",
            idempotencyKey: idempotencyKey(run.id, nodeId, triggeringEventId),
            note: `no handler for node type "${node.type}"`,
          },
          nextPending: remaining,
          status: "failed",
        })
        return
      }

      const key = idempotencyKey(run.id, nodeId, triggeringEventId)
      if (run.history.some((h) => h.idempotencyKey === key)) {
        // Already executed — skip.  Dispatcher advances past without
        // re-running, to support idempotent webhook retries.
        run = this.runs.recordExecution({
          runId: run.id,
          entry: {
            at: new Date().toISOString(),
            nodeId,
            inputKeys: [],
            status: "skipped",
            idempotencyKey: key + "_dedup",
            note: "duplicate execution dropped",
          },
          nextPending: remaining,
        }) ?? run
        continue
      }

      const inputKeys = workflow.edges.filter((e) => e.to === nodeId).map((e) => e.from)
      let result
      try {
        result = await handler({
          workflow, run, node,
          channels: this.channels,
          agents: this.agents,
          log: this.log,
        })
      } catch (e: any) {
        this.log(`[workflow:${workflow.id}] handler "${node.type}" threw: ${e.message}`)
        result = { error: e.message }
      }

      const now = new Date().toISOString()
      if (result.error) {
        const entry: NodeExecutionEntry = {
          at: now, nodeId, inputKeys,
          status: "failed",
          idempotencyKey: key,
          note: result.error.slice(0, 200),
        }
        run = this.runs.recordExecution({ runId: run.id, entry, nextPending: remaining, status: "failed" }) ?? run
        return
      }
      if (result.paused && result.pausedAt) {
        const entry: NodeExecutionEntry = {
          at: now, nodeId, inputKeys,
          status: "paused",
          idempotencyKey: key,
        }
        run = this.runs.recordExecution({
          runId: run.id, entry,
          nextPending: remaining,
          status: "paused",
          pausedAt: result.pausedAt,
        }) ?? run
        return
      }

      // Success — fold the node's output into context, enqueue successors.
      const output: Record<string, unknown> = result.output ?? {}
      const newContext: Record<string, Record<string, unknown>> = { ...run.context, [nodeId]: output }
      const { nextPending } = nextNodes({ workflow, fromNodeId: nodeId, selectedPort: result.port })
      const merged = [...remaining, ...nextPending]
      const terminal = node.type === "end"

      const entry: NodeExecutionEntry = {
        at: now,
        nodeId,
        inputKeys,
        status: "ok",
        output,
        idempotencyKey: key,
      }
      run = this.runs.recordExecution({
        runId: run.id,
        entry,
        nextPending: terminal ? [] : merged,
        status: terminal ? (String(node.config.status ?? "completed") as WorkflowRun["status"]) : "running",
        context: newContext,
      }) ?? run

      if (terminal) return
    }
  }
}

/** Does the incoming event's trigger fields match the checkpoint's
 *  resumeMatch filter? Empty/missing fields are wildcards (match anything),
 *  so the default `resumeMatch: {}` accepts any event on the entity. */
function matchesResume(
  resumeMatch: Record<string, unknown>,
  trigger: { source?: string; project?: string; repo?: string; chat?: string; labels?: string[] },
  event: TriggerEvent,
): boolean {
  const match = (k: keyof typeof trigger): boolean => {
    const want = resumeMatch[k]
    if (want === undefined || want === "" || want === "*") return true
    if (Array.isArray(want)) {
      const have = new Set(trigger.labels ?? [])
      return (want as string[]).some((l) => have.has(String(l)))
    }
    return trigger[k] === want
  }
  // Fields supported in v1: source, project, repo, chat, labels. Additional
  // keys in resumeMatch are ignored (won't accidentally block resume).
  if (!match("source")) return false
  if (!match("project")) return false
  if (!match("repo")) return false
  if (!match("chat")) return false
  // `eventIdLike`: optional substring match on the event id, useful for
  // resuming only on events that carry a specific marker.
  const eventIdLike = resumeMatch.eventIdLike
  if (typeof eventIdLike === "string" && eventIdLike && !event.id.includes(eventIdLike)) return false
  return true
}

export { idempotencyKey } from "./run-store"
