import { getNextCronDate } from "@/crons/scheduler"
import type { WorkflowDispatcher } from "./dispatcher"
import type { WorkflowStore } from "./store"
import type { HookEvent } from "@/hooks/types"
import type { HookRegistry } from "@/hooks"

// --- Trigger wiring for Phase 3 ---
//
// Workflows with `trigger.cron` or `trigger.hook` nodes don't map to
// channel events, so the regular hook subscribers in hooks.ts don't fire
// them. This module wires those two sources:
//
//   - trigger.cron: compute next fire time via getNextCronDate + chain
//     setTimeout. On fire, call dispatcher with a synthetic trigger event.
//     Each workflow gets its own timer loop; rescheduled on every fire.
//
//   - trigger.hook: register a HookRegistry handler on whichever on:* event
//     the trigger node configures. On fire, map the hook context payload
//     directly into a trigger event.
//
// Called once from daemon boot after the dispatcher is constructed. Teardown
// isn't wired for v1 — daemon restart clears timers.

export interface CronTriggerOptions {
  workflowId: string
  triggerNodeId: string
  spec: string
  timezone: string
}

export function startWorkflowTriggers(args: {
  store: WorkflowStore
  dispatcher: WorkflowDispatcher
  hooks: HookRegistry
  log: (msg: string) => void
}): { cronTimers: number; hookSubscribers: number } {
  const workflows = args.store.list()
  let cronTimers = 0
  let hookSubscribers = 0

  for (const wf of workflows) {
    const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
    if (!trigger) continue

    if (trigger.type === "trigger.cron") {
      const cfg = trigger.config as { spec?: string; timezone?: string }
      if (!cfg.spec) { args.log(`[workflows] ${wf.id} trigger.cron missing config.spec — skipping`); continue }
      scheduleCron({
        workflowId: wf.id,
        triggerNodeId: trigger.id,
        spec: cfg.spec,
        timezone: cfg.timezone ?? "UTC",
      }, args.dispatcher, args.log)
      cronTimers++
    } else if (trigger.type === "trigger.hook") {
      const cfg = trigger.config as { event?: string }
      if (!cfg.event || !cfg.event.startsWith("on:")) {
        args.log(`[workflows] ${wf.id} trigger.hook config.event must start with "on:" — skipping`)
        continue
      }
      args.hooks.registerHandler(cfg.event as HookEvent, `workflows:${wf.id}`, async (ctx) => {
        try {
          // Go direct: this hook subscriber is registered per-workflow,
          // so we already know which workflow to fire. Going through
          // dispatch() + matchByTrigger() would drop the event unless the
          // workflow's trigger.hook node had a matching `source` field —
          // which users don't set (the event IS the filter).
          const entityId = entityKeyFromHookContext(wf.id, cfg.event!, ctx)
          await args.dispatcher.dispatchWorkflow({
            workflowId: wf.id,
            entityRef: { backend: "hook", id: entityId },
            event: {
              id: `hook:${cfg.event}:${Date.now().toString(36)}`,
              payload: { hookEvent: cfg.event, ...ctx },
            },
          })
        } catch (e: any) {
          args.log(`[workflows] ${wf.id} hook dispatch failed: ${e.message}`)
        }
        return {}
      }, 60)
      hookSubscribers++
    }
  }

  return { cronTimers, hookSubscribers }
}

/** Derive a per-event entity id for a hook fire. Two unrelated issues
 *  (or MRs, or messages) MUST resolve to different entities — otherwise
 *  the second one collides with the first's paused/running run and
 *  either gets dropped or hijacks the paused state. Falls back to a
 *  per-fire unique id so unknown hook shapes never silently collide. */
function entityKeyFromHookContext(workflowId: string, event: string, ctx: Record<string, unknown>): string {
  const project = typeof ctx.project === "string" ? ctx.project : ""
  const iid = ctx.iid != null ? String(ctx.iid) : ""
  if (event === "on:gitlab-issue" && project && iid) return `${workflowId}:${event}:${project}#${iid}`
  if (event === "on:gitlab-mr" && project && iid)    return `${workflowId}:${event}:${project}!${iid}`
  if (event === "on:gitlab-pipeline" && project) {
    const pid = ctx.pipelineId != null ? String(ctx.pipelineId) : ""
    if (pid) return `${workflowId}:${event}:${project}@pipeline:${pid}`
  }
  // Unknown / shapeless hook payloads: per-fire entity so each fire spawns
  // its own run rather than colliding on a single shared key. Authors who
  // want stickiness can move to a custom matcher later.
  return `${workflowId}:${event}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function scheduleCron(
  opts: CronTriggerOptions,
  dispatcher: WorkflowDispatcher,
  log: (msg: string) => void,
): void {
  const tick = () => {
    let next: Date
    try { next = getNextCronDate(opts.spec, new Date(), opts.timezone) }
    catch (e: any) { log(`[workflows] ${opts.workflowId} cron spec invalid: ${e.message}`); return }

    const delay = Math.max(1000, next.getTime() - Date.now())
    setTimeout(() => {
      void (async () => {
        const eventId = `cron:${opts.workflowId}:${next.toISOString()}`
        try {
          await dispatcher.dispatchWorkflow({
            workflowId: opts.workflowId,
            trigger: { source: "cron" },
            // Each scheduled fire gets a distinct entity so multiple runs
            // can coexist. If authors want a single "rolling" entity keyed
            // by the workflow, they can override via a transform node.
            entityRef: { backend: "cron", id: `${opts.workflowId}@${next.toISOString()}` },
            event: {
              id: eventId,
              payload: { now: next.toISOString(), spec: opts.spec, workflowId: opts.workflowId },
            },
          })
        } catch (e: any) {
          log(`[workflows] ${opts.workflowId} cron dispatch failed: ${e.message}`)
        } finally {
          // Reschedule for the next fire window regardless of success.
          tick()
        }
      })()
    }, delay)
  }
  tick()
}
