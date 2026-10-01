import type { EntityRef, Workflow, WorkflowRun } from "@/workflows/types"
import type { TriggerEvent } from "@/workflows/dispatcher"

// --- POST /workflows/:id/run ---
//
// Manual run used by `agentx workflow run <id>` and the dashboard's Run
// button. Starts exactly the workflow named in the URL, or returns an
// error. It goes through dispatchWorkflow (by id), never dispatch(): a
// trigger match by `source` would hand the run to the highest-priority
// workflow that declares `source: "manual"`, whichever id was asked for.
//
// Status codes: 200 run started · 202 handed to an existing run of this
// entity · 400 no trigger node · 404 unknown · 409 not a manual trigger
// (without force) / not active / nothing started.

export interface ManualRunDeps {
  get(id: string): Workflow | null | undefined
  dispatchWorkflow(args: {
    workflowId: string
    entityRef: EntityRef
    event: TriggerEvent
    trigger?: { source?: string; project?: string; repo?: string; chat?: string; labels?: string[] }
  }): Promise<{ claimed: boolean; run: WorkflowRun | null }>
}

export async function startManualWorkflowRun(
  deps: ManualRunDeps,
  workflowId: string,
  body: { force?: unknown; payload?: Record<string, unknown> } | null | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const wf = deps.get(workflowId)
  if (!wf) return { status: 404, body: { error: `unknown workflow "${workflowId}"` } }
  const triggerNode = wf.nodes.find((n) => n.type.startsWith("trigger."))
  if (!triggerNode) return { status: 400, body: { error: `workflow "${workflowId}" has no trigger node` } }

  const force = !!body?.force
  const payload = body?.payload || {}

  // By default we only allow running workflows whose trigger is
  // `trigger.manual` — otherwise a manual kick would race against live
  // channel events. `force: true` overrides this for testing: we
  // synthesize a trigger event with the workflow's declared source and
  // seed the provided payload into the trigger node's output bundle.
  // Useful when the live channel is disconnected (WhatsApp not paired,
  // Telegram 409 conflict) and you just want to exercise the graph.
  if (triggerNode.type !== "trigger.manual" && !force) {
    return {
      status: 409,
      body: {
        error: `workflow "${workflowId}" trigger is "${triggerNode.type}"`,
        hint: `pass { "force": true } to fire anyway with a synthesized event (for testing)`,
      },
    }
  }
  // Same lifecycle gate as a trigger match: disabled and quarantined
  // workflows take no new runs.
  if (wf.state && wf.state !== "active") {
    return { status: 409, body: { error: `workflow "${workflowId}" is ${wf.state}` } }
  }

  const cfg = (triggerNode.config ?? {}) as {
    source?: string
    filter?: { project?: string; repo?: string; chat?: string; labels?: string[] }
  }
  const source = force ? String(cfg.source ?? "manual") : "manual"
  const entityId = String(payload.entityId || payload.chatId || `manual-${Date.now().toString(36)}`)
  const entityRef: EntityRef = {
    backend: force ? (cfg.source ? "channel" : "manual") : "manual",
    id: entityId,
  }
  const result = await deps.dispatchWorkflow({
    workflowId,
    trigger: force
      ? {
          source,
          project: cfg.filter?.project,
          repo: cfg.filter?.repo,
          chat: cfg.filter?.chat,
          labels: cfg.filter?.labels,
        }
      : { source: "manual" },
    entityRef,
    event: { id: `manual:${workflowId}:${entityId}:${Date.now()}`, payload },
  })
  if (!result.run && !result.claimed) {
    return { status: 409, body: { error: `workflow "${workflowId}" did not start a run for entity "${entityId}"` } }
  }
  return {
    status: result.run ? 200 : 202,
    body: { ok: true, runId: result.run?.id, entityRef, source, force },
  }
}
